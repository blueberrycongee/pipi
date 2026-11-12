// CI-only: import an existing release identity, never generate one per build.
import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const signId = env.PIPI_RELEASE_SIGN_ID?.trim().toUpperCase();
if (!signId || !/^[A-F0-9]{40}$/.test(signId)) {
  throw new Error("Set PIPI_RELEASE_SIGN_ID to the certificate SHA-1 fingerprint");
}
if (env.GITHUB_ACTIONS !== "true") {
  throw new Error("This import script is restricted to ephemeral GitHub Actions runners");
}
if (!env.RUNNER_TEMP || !env.GITHUB_ENV || !env.PIPI_RELEASE_CERTIFICATE_P12 || !env.PIPI_RELEASE_CERTIFICATE_PASSWORD) {
  throw new Error("Release signing requires the persistent P12, password, fingerprint, and GitHub Actions environment");
}
const keychain = join(env.RUNNER_TEMP, "pipi-release.keychain-db");
const archive = join(env.RUNNER_TEMP, "pipi-release.p12");
const password = randomBytes(32).toString("hex");
function security(args) {
  try { execFileSync("security", args, { stdio: "pipe", timeout: 15_000 }); }
  catch (error) { throw new Error(`Release keychain operation failed: ${args[0]} (${error.status})`); }
}
try {
  writeFileSync(archive, Buffer.from(env.PIPI_RELEASE_CERTIFICATE_P12, "base64"), { mode: 0o600 });
  security(["create-keychain", "-p", password, keychain]);
  security(["set-keychain-settings", "-lut", "21600", keychain]);
  security(["unlock-keychain", "-p", password, keychain]);
  security(["import", archive, "-k", keychain, "-f", "pkcs12", "-P", env.PIPI_RELEASE_CERTIFICATE_PASSWORD,
    "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"]);
  security(["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
  const publicCertificate = execFileSync("security", ["find-certificate", "-p", keychain], { encoding: "utf8" });
  const imported = new X509Certificate(publicCertificate);
  if (imported.fingerprint.replaceAll(":", "") !== signId) {
    throw new Error("Imported certificate does not match the pinned release identity");
  }
  if (!imported.subject.includes("CN=Developer ID Application:") || !imported.subject.split("\n").includes(`OU=${env.PIPI_RELEASE_TEAM_ID}`)) {
    throw new Error("Certificate is not a Developer ID Application certificate for the configured team");
  }
  const searchList = execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" })
    .split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  security(["list-keychains", "-d", "user", "-s", keychain, ...searchList]);
  const found = execFileSync("security", ["find-identity", "-v", "-p", "codesigning", keychain], { encoding: "utf8" })
    .split("\n").some((line) => line.toUpperCase().includes(signId) && line.includes("Developer ID Application:"));
  if (!found) throw new Error("The pinned Developer ID Application identity is not in the release keychain");
  appendFileSync(env.GITHUB_ENV, `PIPI_RELEASE_KEYCHAIN=${keychain}\nPIPI_RELEASE_SIGN_ID=${signId}\n`);
} catch (error) {
  try { security(["delete-keychain", keychain]); } catch {}
  throw new Error("Release identity import failed; check certificate, password, fingerprint, and team");
} finally {
  rmSync(archive, { force: true });
}
