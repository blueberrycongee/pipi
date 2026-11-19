import fs from "fs/promises";
import type {
  AgentMessage,
  AssistantMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
  Model,
  PiTreeEntry,
  ThinkingLevel,
} from "./protocol";

/**
 * Direct reader for saved session `.jsonl` and `.pipi-agent.jsonl` files,
 * following the canonical formats in `docs/pi/session-format.md`,
 * `docs/pi/message-types.md`, and `sidecar/external-agent.mjs`.
 *
 * Reading a saved session file directly in the client lets a session switch put
 * the settled conversation and its recorded model/thinking depth on screen in
 * milliseconds, while the CLI engine spawns and attaches in the background.
 */

export interface SessionSnapshot {
  kind: "pi" | "external";
  id?: string;
  agentId?: string;
  driver?: string;
  cwd?: string;
  name?: string;
  /** Full model record on external sessions, or `{ provider, id }` on Pi sessions. */
  model?: Partial<Model> & { id: string; provider?: string };
  thinkingLevel?: ThinkingLevel;
  context?: { tokens?: number; window?: number };
  messages: AgentMessage[];
}

export interface SessionSnapshotOptions {
  /** Keep `background: true` on external tool calls when attaching to a warm daemon process whose background tasks are still live. */
  keepBackgroundTools?: boolean;
}

const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : undefined;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** Session files stamp messages ISO-8601; the live protocol carries ms — one shape for the transcript. */
function normalizeMessageTimestamp(msg: AgentMessage): AgentMessage {
  const at = (msg as { timestamp?: unknown }).timestamp;
  if (typeof at === "string" && at) {
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) return { ...msg, timestamp: ms } as AgentMessage;
  }
  return msg;
}

/** Matches `clearStaleBackgroundTools` in `sidecar/external-agent.mjs` on session reload. */
function stripStaleBackgroundFlags(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block?.type === "toolCall" && block.background) {
        changed = true;
        const { background: _bg, ...rest } = block;
        return rest;
      }
      return block;
    });
    return changed ? { ...msg, content } : msg;
  });
}

function parseExternalSnapshot(lines: Record<string, unknown>[], options?: SessionSnapshotOptions): SessionSnapshot {
  const header = lines[0];
  const rawMessages: AgentMessage[] = [];
  for (let i = 1; i < lines.length; i++) {
    const entry = lines[i];
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      rawMessages.push(normalizeMessageTimestamp(entry.message as AgentMessage));
    }
  }
  const driver = typeof header.driver === "string" ? header.driver : undefined;
  const agentId =
    (typeof header.agentId === "string" && header.agentId) ||
    driver ||
    undefined;
  let model: (Partial<Model> & { id: string; provider?: string }) | undefined;
  const rawModel = header.model as Record<string, unknown> | undefined;
  if (rawModel && typeof rawModel === "object" && typeof rawModel.id === "string" && rawModel.id) {
    const base = rawModel as unknown as Partial<Model> & { id: string; provider?: string };
    model = driver === "claude" ? { ...base, input: ["text", "image"] } : base;
  }
  const rawContext = header.context as Record<string, unknown> | undefined;
  const context =
    rawContext && typeof rawContext === "object"
      ? {
          tokens: typeof rawContext.tokens === "number" ? rawContext.tokens : undefined,
          window: typeof rawContext.window === "number" && rawContext.window > 0 ? rawContext.window : undefined,
        }
      : undefined;

  return {
    kind: "external",
    id: typeof header.id === "string" ? header.id : undefined,
    agentId,
    driver,
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    name: typeof header.name === "string" && header.name ? header.name : undefined,
    model,
    thinkingLevel: asThinkingLevel(header.thinkingLevel),
    context,
    messages: options?.keepBackgroundTools ? rawMessages : stripStaleBackgroundFlags(rawMessages),
  };
}

function normalizePiMessage(raw: AgentMessage): AgentMessage {
  const stamped = normalizeMessageTimestamp(raw);
  const role = (stamped as { role?: unknown }).role;
  if (role === "hookMessage") {
    const legacy = stamped as unknown as Record<string, unknown>;
    return {
      role: "custom",
      customType: typeof legacy.customType === "string" ? legacy.customType : "extension",
      content:
        typeof legacy.content === "string" || Array.isArray(legacy.content)
          ? (legacy.content as CustomMessage["content"])
          : "",
      display: Boolean(legacy.display),
      timestamp: typeof legacy.timestamp === "number" ? legacy.timestamp : 0,
    };
  }
  return stamped;
}

function activeBranch(entries: PiTreeEntry[], leafId?: string | null): PiTreeEntry[] {
  if (leafId === null) return [];
  const byId = new Map<string, PiTreeEntry>();
  let hasTreeIds = false;
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id) {
      byId.set(entry.id, entry);
      hasTreeIds = true;
    }
  }

  // Reconstruct the active branch from the current leaf (last appended entry) to its root (`docs/pi/session-format.md`).
  let pathEntries: PiTreeEntry[];
  if (hasTreeIds && entries.length > 0) {
    const reversed: PiTreeEntry[] = [];
    const seen = new Set<string>();
    let cur: PiTreeEntry | undefined = leafId === undefined ? entries.at(-1) : byId.get(leafId);
    while (cur) {
      if (typeof cur.id === "string") {
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
      }
      reversed.push(cur);
      const pid: string | null | undefined = cur.parentId;
      cur = typeof pid === "string" && pid ? byId.get(pid) : undefined;
    }
    pathEntries = reversed.reverse();
  } else {
    pathEntries = entries;
  }

  return pathEntries;
}

function parsePiSnapshot(lines: Record<string, unknown>[]): SessionSnapshot {
  const header = lines[0];
  const entries = lines.slice(1) as PiTreeEntry[];
  const pathEntries = activeBranch(entries);
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) name = entry.name;
  }
  let model: { id: string; provider?: string } | undefined;
  let thinkingLevel: ThinkingLevel | undefined;

  for (const entry of pathEntries) {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) {
      name = entry.name;
    } else if (entry.type === "model_change" && typeof entry.modelId === "string" && entry.modelId) {
      model = {
        id: entry.modelId,
        provider: typeof entry.provider === "string" ? entry.provider : undefined,
      };
    } else if (entry.type === "thinking_level_change") {
      const lvl = asThinkingLevel(entry.thinkingLevel);
      if (lvl) thinkingLevel = lvl;
    } else if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const msg = entry.message as AssistantMessage & { thinkingLevel?: unknown };
      if (msg.role === "assistant") {
        if (typeof msg.model === "string" && msg.model) {
          model = { id: msg.model, provider: typeof msg.provider === "string" ? msg.provider : undefined };
        }
        const msgLvl = asThinkingLevel(msg.thinkingLevel);
        if (msgLvl) thinkingLevel = msgLvl;
      }
    }
  }

  return {
    kind: "pi",
    id: typeof header.id === "string" ? header.id : undefined,
    agentId: "pi",
    driver: "pi",
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    name,
    model,
    thinkingLevel,
    messages: branchMessages(pathEntries),
  };
}

/** The display history, not Pi's model context: keep original messages and each divider where it occurred. */
export function piHistoryMessages(entries: PiTreeEntry[], leafId: string | null): AgentMessage[] {
  return branchMessages(activeBranch(entries, leafId));
}

function branchMessages(entries: PiTreeEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const entry of entries) {
    switch (entry.type) {
      case "compaction": {
        const msg: CompactionSummaryMessage = {
          role: "compactionSummary",
          summary: typeof entry.summary === "string" ? entry.summary : "",
          tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
          timestamp: parseTimestamp(entry.timestamp),
        };
        messages.push(msg);
        break;
      }
      case "branch_summary": {
        const summary = typeof entry.summary === "string" ? entry.summary : "";
        if (!summary.trim()) break;
        const msg: BranchSummaryMessage = {
          role: "branchSummary",
          summary,
          timestamp: parseTimestamp(entry.timestamp),
        };
        messages.push(msg);
        break;
      }
      case "custom_message": {
        const raw: CustomMessage = {
          role: "custom",
          customType: typeof entry.customType === "string" ? entry.customType : "extension",
          content:
            typeof entry.content === "string" || Array.isArray(entry.content)
              ? (entry.content as CustomMessage["content"])
              : "",
          display: Boolean(entry.display),
          timestamp: parseTimestamp(entry.timestamp),
        };
        messages.push(raw);
        break;
      }
      case "message": {
        if (!entry.message || typeof entry.message !== "object") break;
        const raw = normalizePiMessage(entry.message as AgentMessage);
        if (raw.role !== "system") messages.push(raw);
        break;
      }
    }
  }

  return messages;
}

/** Parses raw JSONL session file contents into a `SessionSnapshot`; `undefined` if unrecognized or empty. */
export function parseSessionSnapshot(raw: string, options?: SessionSnapshotOptions): SessionSnapshot | undefined {
  if (!raw) return undefined;
  // Split strictly on LF (`\n`), never on U+2028/U+2029 which are valid inside JSON strings.
  const rawLines = raw.split("\n");
  const parsed: Record<string, unknown>[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].endsWith("\r") ? rawLines[i].slice(0, -1) : rawLines[i];
    if (!line) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed.push(obj as Record<string, unknown>);
      }
    } catch {
      // Tolerate a truncated trailing line if a background writer is mid-append.
    }
  }
  if (parsed.length === 0) return undefined;
  const firstType = parsed[0].type;
  if (firstType === "pipi_external_session") return parseExternalSnapshot(parsed, options);
  if (firstType === "session") return parsePiSnapshot(parsed);
  return undefined;
}

/** Reads and parses a saved session `.jsonl` / `.pipi-agent.jsonl` file directly from disk. */
export async function readSessionSnapshot(path: string, options?: SessionSnapshotOptions): Promise<SessionSnapshot | undefined> {
  if (!path || (!path.endsWith(".jsonl") && !path.endsWith(".pipi-agent.jsonl"))) return undefined;
  try {
    const raw = await fs.readFile(path, "utf8");
    return parseSessionSnapshot(raw, options);
  } catch {
    return undefined;
  }
}
