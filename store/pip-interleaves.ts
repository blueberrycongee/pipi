import { signal, Storage } from "nsh";
import type { PipInterleaveRecord } from "../lib/pip-reveal";

/**
 * Persisted persona bubble crossings, keyed by the session file they belong to.
 * Records carry ordinals and non-reversible hashes only — never message text —
 * and the whole key is absent until a crossing actually happens.
 */
const KEY = "pipi.interleaves.v1";
const MAX_PER_SESSION = 80;
const MAX_SESSIONS = 80;

const entries = signal<Record<string, PipInterleaveRecord[]>>({});
const valid = (value: unknown): value is PipInterleaveRecord => {
  const r = value as PipInterleaveRecord;
  return Boolean(
    r &&
      r.v === 1 &&
      Number.isFinite(r.turn) &&
      Number.isFinite(r.turnRepeat) &&
      Number.isFinite(r.user) &&
      Number.isFinite(r.userRepeat) &&
      Number.isFinite(r.before) &&
      Number.isFinite(r.bubbles) &&
      Number.isFinite(r.at) &&
      typeof r.turnHash === "string" &&
      typeof r.userHash === "string",
  );
};

function normalize(value: unknown): Record<string, PipInterleaveRecord[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, PipInterleaveRecord[]> = {};
  for (const [file, list] of Object.entries(value as Record<string, unknown>)) {
    if (!file || !Array.isArray(list)) continue;
    const records = list.filter(valid).slice(-MAX_PER_SESSION);
    if (records.length) out[file] = records;
  }
  return out;
}

/** Reads the crossing journal once during boot. */
export async function loadPipInterleaves() {
  try {
    const raw = await Storage.getItem(KEY);
    entries.set(normalize(raw ? JSON.parse(raw) : {}));
  } catch {
    entries.set({});
  }
}

/** Records for one session file. Reading the signal makes projections react to a newly written crossing. */
export function pipInterleavesForSession(file: string | undefined): PipInterleaveRecord[] {
  if (!file) {
    entries();
    return [];
  }
  return entries()[file] ?? [];
}

const sameRecord = (a: PipInterleaveRecord, b: PipInterleaveRecord) =>
  a.turnHash === b.turnHash && a.turnRepeat === b.turnRepeat && a.userHash === b.userHash && a.userRepeat === b.userRepeat && a.before === b.before;

/** Appends one crossing. Writes are deliberately tiny and happen only when a real crossing occurs. */
export function recordPipInterleave(file: string | undefined, record: PipInterleaveRecord) {
  if (!file || !valid(record)) return;
  const before = entries();
  const existing = before[file] ?? [];
  if (existing.some((item) => sameRecord(item, record))) return;
  const next: Record<string, PipInterleaveRecord[]> = { ...before, [file]: [...existing, record].slice(-MAX_PER_SESSION) };
  const keys = Object.keys(next);
  if (keys.length > MAX_SESSIONS) {
    const ordered = keys.sort((a, b) => (next[a].at(-1)?.at ?? 0) - (next[b].at(-1)?.at ?? 0));
    for (const key of ordered.slice(0, keys.length - MAX_SESSIONS)) delete next[key];
  }
  entries.set(next);
  void Storage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
}
