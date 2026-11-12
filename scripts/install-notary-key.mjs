// CI-only: write the App Store Connect API key to the runner's temp directory
// so notarytool reads a file (APPLE_API_KEY) while the PEM stays a secret.
import { createPrivateKey } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
if (env.GITHUB_ACTIONS !== "true" || !env.RUNNER_TEMP || !env.GITHUB_ENV) {
  throw new Error("Notary key installation requires an ephemeral GitHub Actions runner");
}
for (const name of ["APPLE_API_KEY_P8", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
  if (!env[name]?.trim()) throw new Error(`Missing release credential: ${name}`);
}
const path = join(env.RUNNER_TEMP, "pipi-notary.p8");
try {
  const key = createPrivateKey(env.APPLE_API_KEY_P8);
  if (key.asymmetricKeyType !== "ec") throw new Error("Unexpected key type");
} catch {
  throw new Error("Missing or invalid App Store Connect team API private key");
}
writeFileSync(path, env.APPLE_API_KEY_P8, { mode: 0o600 });
appendFileSync(env.GITHUB_ENV, `APPLE_API_KEY=${path}\n`);
