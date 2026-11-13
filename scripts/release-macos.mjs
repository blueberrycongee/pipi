// pipi macOS release: package with nsh, re-sign with the pinned Developer ID,
// notarize, staple, and verify Gatekeeper before anything is published.
// Never falls back to ad hoc signing; a missing credential or a failed check
// stops before any artifact leaves the machine.
//
// Required environment:
//   PIPI_RELEASE_SIGN_ID   certificate SHA-1 fingerprint (pinned, never a name)
//   PIPI_RELEASE_TEAM_ID   Apple developer team identifier
//   APPLE_API_KEY          path to the App Store Connect API .p8
//   APPLE_API_KEY_ID       that key's ID
//   APPLE_API_ISSUER       team issuer ID
//   APPLE_NOTARY_PROFILE   optional `notarytool store-credentials` profile,
//                          replacing the three APPLE_API_* variables
//   PIPI_RELEASE_KEYCHAIN  optional keychain path holding the identity
//   RELEASE_TAG            optional v<version> tag; must match nsh.json
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "nsh.json"), "utf8"));
const version = manifest.version;
const app = join(root, ".nsh/out", `${manifest.name}.app`);
const releaseDir = join(root, "release");
const appReceiptPath = join(releaseDir, "notarization/app-submission.json");
const dmgReceiptPath = join(releaseDir, "notarization/submission.json");
const archiveName = `pipi-${version}-mac-arm64.dmg`;

const env = process.env;
function credentials() {
  const id = env.PIPI_RELEASE_SIGN_ID?.trim().toUpperCase();
  if (!id || !/^[A-F0-9]{40}$/.test(id)) {
    throw new Error("Set PIPI_RELEASE_SIGN_ID to the certificate SHA-1 fingerprint, not a name");
  }
  if (!/^[A-Z0-9]{10}$/.test(env.PIPI_RELEASE_TEAM_ID || "")) {
    throw new Error("Missing or invalid PIPI_RELEASE_TEAM_ID");
  }
  if (env.APPLE_NOTARY_PROFILE?.trim()) return id;
  for (const name of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
    if (!env[name]?.trim()) throw new Error(`Missing release credential: ${name} (or set APPLE_NOTARY_PROFILE)`);
  }
  if (!existsSync(env.APPLE_API_KEY)) {
    throw new Error(`APPLE_API_KEY does not name a readable file: ${env.APPLE_API_KEY}`);
  }
  return id;
}

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });

// codesign -dv prints on stderr; spctl does too on some versions.
const probe = (cmd, args) => {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  return `${out.stdout || ""}\n${out.stderr || ""}`;
};

function checkIdentity(id) {
  const args = ["find-identity", "-v", "-p", "codesigning"];
  if (env.PIPI_RELEASE_KEYCHAIN) args.push(env.PIPI_RELEASE_KEYCHAIN);
  const found = run("security", args).split("\n").some((line) =>
    line.toUpperCase().includes(id) && line.includes("Developer ID Application:"));
  if (!found) throw new Error("The pinned Developer ID Application identity is not in the keychain");
}

function signApp(id) {
  const args = ["--force", "--deep", "--sign", id, "--options", "runtime", "--timestamp"];
  if (env.PIPI_RELEASE_KEYCHAIN) args.push("--keychain", env.PIPI_RELEASE_KEYCHAIN);
  args.push(app);
  run("codesign", args);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const info = probe("codesign", ["-dv", "--verbose=2", app]);
  if (!info.includes(`TeamIdentifier=${env.PIPI_RELEASE_TEAM_ID}`)) {
    throw new Error("Signed app carries the wrong team identifier");
  }
}

function signDmg(id, dmg) {
  const args = ["--force", "--sign", id, "--timestamp"];
  if (env.PIPI_RELEASE_KEYCHAIN) args.push("--keychain", env.PIPI_RELEASE_KEYCHAIN);
  args.push(dmg);
  run("codesign", args);
}

// The DMG, not the .app inside it, is the outermost container users download,
// so it is what Apple notarizes and what ships.
function makeDmg(destination) {
  rmSync(destination, { force: true });
  run(join(root, "scripts/make-dmg.sh"), [app, destination], { stdio: "inherit" });
  if (!existsSync(destination)) throw new Error(`make-dmg.sh did not produce ${destination}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const transient = (error) =>
  error.code === "ETIMEDOUT" ||
  /NSURLErrorDomain|ECONNRESET|ENETUNREACH|EAI_AGAIN|timed out|network|offline|connection|\b50[234]\b|\b429\b/i
    .test(`${error.message}\n${error.stderr || ""}\n${error.stdout || ""}`);

const notaryAuth = () =>
  env.APPLE_NOTARY_PROFILE?.trim()
    ? ["--keychain-profile", env.APPLE_NOTARY_PROFILE.trim(), "--output-format", "json"]
    : ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID,
       "--issuer", env.APPLE_API_ISSUER, "--output-format", "json"];

// Apple accepts the upload before the receipt exists; an interrupted submit is
// ambiguous, so the receipt records what was sent before any wait begins and a
// rerun resumes that submission instead of uploading again.
async function notarize(archive, receiptFile) {
  mkdirSync(dirname(receiptFile), { recursive: true });
  const hash = sha256(archive);
  const save = (receipt) => {
    writeFileSync(`${receiptFile}.tmp`, JSON.stringify(receipt, null, 2) + "\n");
    renameSync(`${receiptFile}.tmp`, receiptFile);
  };
  let receipt;
  if (existsSync(receiptFile)) {
    receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    if (receipt.sha256 !== hash) throw new Error("Notarization receipt hash does not match the archive");
    if (receipt.status === "UploadUnknown") {
      throw new Error("Notarization upload outcome is unknown; check Apple history before resubmitting");
    }
    if (receipt.status === "Accepted") return receipt;
  } else {
    receipt = { sha256: hash, archive: basename(archive), status: "UploadUnknown" };
    save(receipt);
    let submission;
    try {
      submission = JSON.parse(run("xcrun", ["notarytool", "submit", archive, "--no-wait", ...notaryAuth()], {
        stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000,
      }));
    } catch (error) {
      const detail = `${error.stderr || ""}${error.stdout || ""}${error.message || error}`.trim().slice(0, 2000);
      throw new Error(`Notarization upload failed or its outcome is unknown; inspect Apple history before retrying${detail ? `\n${detail}` : ""}`);
    }
    receipt = { id: submission.id, sha256: hash, archive: basename(archive), status: "Submitted" };
    save(receipt);
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt.id)) {
    throw new Error("Missing or invalid notarization submission ID");
  }
  console.log(`Notarization submission ${receipt.id}`);
  let networkErrors = 0;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    let result;
    try {
      result = JSON.parse(run("xcrun", ["notarytool", "info", receipt.id, ...notaryAuth()], {
        stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
      }));
      networkErrors = 0;
    } catch (error) {
      if (!transient(error)) throw new Error(`Notarization query failed for ${receipt.id}`);
      if (++networkErrors >= 5) throw new Error(`Notarization network retry limit reached for ${receipt.id}`);
      console.warn(`Notarization query interrupted; retry ${networkErrors}/5`);
      await sleep(30_000);
      continue;
    }
    if (result.id !== receipt.id) throw new Error("Notarization response submission ID mismatch");
    receipt.status = result.status;
    save(receipt);
    console.log(`Notarization ${receipt.id}: ${result.status}`);
    if (result.status === "Accepted") return receipt;
    if (result.status !== "In Progress") {
      throw new Error(`Notarization ${receipt.id}: ${result.status}; inspect its Apple submission log`);
    }
    await sleep(30_000);
  }
  throw new Error(`Notarization waiting limit reached for ${receipt.id}`);
}

// Stapling and validation query CloudKit; transient failures retry against the
// same artifact, never resubmitting it.
async function stapler(action, target) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      run("xcrun", ["stapler", action, target], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      return;
    } catch (error) {
      if (!transient(error) || attempt === 3) throw error;
      console.warn(`stapler ${action} interrupted; retry ${attempt}/2 for ${target}`);
      await sleep(30_000);
    }
  }
}

const identity = credentials();
checkIdentity(identity);
const tag = env.RELEASE_TAG?.trim();
if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match nsh.json version v${version}`);
}

console.log(`Packaging pipi ${version} (nsh package --target macos)`);
run("nsh", ["package", "--target", "macos", root], { stdio: "inherit" });
if (!existsSync(app)) throw new Error(`nsh package did not produce ${app}`);
run(join(root, "scripts/stamp-macos-sdk.sh"), [app], { stdio: "inherit" });

console.log("Signing with the pinned Developer ID (hardened runtime, timestamp)");
signApp(identity);

mkdirSync(releaseDir, { recursive: true });
console.log("Notarizing and stapling pipi.app before building the disk image");
const appArchive = join(releaseDir, "app-submission.zip");
rmSync(appArchive, { force: true });
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, appArchive]);
const appReceipt = await notarize(appArchive, appReceiptPath);
rmSync(appArchive, { force: true });
await stapler("staple", app);
await stapler("validate", app);

console.log(`Building ${archiveName}`);
const uploadArchive = join(releaseDir, "submission.dmg");
makeDmg(uploadArchive);
console.log("Signing, notarizing, and stapling the disk image");
signDmg(identity, uploadArchive);
const receipt = await notarize(uploadArchive, dmgReceiptPath);
await stapler("staple", uploadArchive);
await stapler("validate", uploadArchive);

console.log(`Writing ${archiveName}`);
const artifact = join(releaseDir, archiveName);
renameSync(uploadArchive, artifact);

console.log("Gatekeeper assessment");
const spctl = probe("spctl", ["-a", "-vv", "-t", "execute", app]);
if (!/accepted/.test(spctl) || !/source=Notarized Developer ID/.test(spctl)) {
  throw new Error(`Gatekeeper rejected the app:\n${spctl}`);
}
console.log(spctl.trimEnd());
const spctlDmg = probe("spctl", ["-a", "-vv", "-t", "install", artifact]);
if (!/accepted/.test(spctlDmg) || !/source=Notarized Developer ID/.test(spctlDmg)) {
  throw new Error(`Gatekeeper rejected the disk image:\n${spctlDmg}`);
}
console.log(spctlDmg.trimEnd());

const commit = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
writeFileSync(join(releaseDir, "verification.json"), JSON.stringify({
  name: manifest.name,
  version,
  commit,
  bundleId: manifest.id,
  identity,
  teamId: env.PIPI_RELEASE_TEAM_ID,
  notarization: { app: appReceipt.id, dmg: receipt.id },
  artifact: { file: archiveName, sha256: sha256(artifact) },
  checks: [
    "codesign --verify --deep --strict (app)",
    "stapler validate (app inside dmg, dmg)",
    "spctl -a -vv -t execute (app)",
    "spctl -a -vv -t install (dmg)",
  ],
}, null, 2) + "\n");
console.log(`Release verified: release/${archiveName}`);
