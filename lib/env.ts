/**
 * The environment variables the app may read (those `nsh.json` grants).
 * Read from the global `process`: under the dev server's hot reload the
 * `process` module's default import is its namespace, which has no `env`.
 */
export function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[name] || undefined;
}
