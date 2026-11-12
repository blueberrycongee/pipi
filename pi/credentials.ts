import fs from "fs/promises";
import os from "os";
import process from "process";
import { env } from "../lib/env";

/**
 * API keys in Pi's own credential store.
 *
 * Pi's RPC protocol has no command for credentials: Pi reads them from
 * `<agent-dir>/auth.json` (`docs/pi/providers.md`, `docs/pi/configuration.md`),
 * the file its own `/login` writes. This module reads and edits that file in
 * the documented `{ "<provider>": { "type": "api_key", "key": "…" } }` shape
 * and never invents another store. OAuth entries are left exactly as they
 * are; a key's value never leaves this module.
 */

/** How a provider is signed in, without the secret. */
export type CredentialKind = "api_key" | "oauth";

type AuthFile = Record<string, { type?: string; key?: string } & Record<string, unknown>>;

/** Pi's agent directory: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function agentDir() {
  return env("PI_CODING_AGENT_DIR") ?? `${os.homedir()}/.pi/agent`;
}

const authPath = () => `${agentDir()}/auth.json`;

async function read(): Promise<AuthFile> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(authPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AuthFile) : {};
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
}

async function write(auth: AuthFile) {
  await fs.mkdir(agentDir(), { recursive: true });
  await fs.writeFile(authPath(), `${JSON.stringify(auth, null, 2)}\n`);
  // The file holds secrets: keep it private to the user, as Pi does.
  await process.run("chmod", ["600", authPath()]).catch(() => undefined);
}

/** The providers that have a stored credential, and its kind. */
export async function storedCredentials(): Promise<Record<string, CredentialKind>> {
  const auth = await read();
  const kinds: Record<string, CredentialKind> = {};
  for (const [provider, entry] of Object.entries(auth)) kinds[provider] = entry?.type === "api_key" ? "api_key" : "oauth";
  return kinds;
}

/** Stores an API key for a provider, replacing the one it had. */
export async function saveApiKey(provider: string, key: string) {
  const auth = await read();
  const previous = auth[provider]?.type === "api_key" ? auth[provider] : {};
  auth[provider] = { ...previous, type: "api_key", key: key.trim() };
  await write(auth);
}

/** Removes a provider's stored credential (as Pi's `/logout` does). */
export async function removeCredential(provider: string) {
  const auth = await read();
  if (!(provider in auth)) return;
  delete auth[provider];
  await write(auth);
}
