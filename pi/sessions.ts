import fs from "fs/promises";
import { runHelper } from "./sidecar";

/** A saved session of the working directory, as the sidebar lists it. */
export interface SessionSummary {
  /** The session file: what `switch_session` takes. */
  path: string;
  id: string;
  /** The name the user gave it, when it has one. */
  name?: string;
  /** The start of its first message: its title when it has no name. */
  firstMessage: string;
  messageCount: number;
  created: number;
  modified: number;
  /** Which agent harness owns this saved session (`"pi"`, `"claude"`, `"codex"`, etc.). */
  agentId?: string;
}

/** The sessions Pi saved for `cwd`, newest first (`sidecar/list-sessions.mjs`). */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const out = await runHelper("list-sessions.mjs", [cwd]);
  const parsed: unknown = JSON.parse(out || "[]");
  return Array.isArray(parsed) ? (parsed as SessionSummary[]) : [];
}

/** Lists saved sessions for multiple working directories in one helper pass. */
export async function listWorkspaceSessions(cwds: string[]): Promise<Record<string, SessionSummary[]>> {
  const unique = [...new Set(cwds.filter(Boolean))];
  if (unique.length === 0) return {};
  if (unique.length === 1) return { [unique[0]]: await listSessions(unique[0]) };
  const out = await runHelper("list-sessions.mjs", unique);
  const parsed: unknown = JSON.parse(out || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, SessionSummary[]>) : {};
}

/**
 * Deletes a session: its `.jsonl` file, as `docs/pi/session-format.md` describes.
 * Only files that look like a session are removed.
 */
export async function deleteSession(path: string) {
  if (!path.endsWith(".jsonl")) throw new Error("Not a session file");
  await fs.unlink(path);
}

/** What a session is called in lists and the title bar. */
export function sessionTitle(session: { name?: string; firstMessage?: string }, fallback = "New session") {
  const text = (session.name || session.firstMessage || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}
