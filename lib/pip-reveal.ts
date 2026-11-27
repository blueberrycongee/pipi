import type { ChatRow } from "../views/Rows";

/**
 * Sequential reveal and display-order plumbing for a persona's SMS bubbles.
 *
 * The engine's history is chronological by message: a whole assistant answer
 * precedes the user's next message. The persona surface splits that answer
 * into bubbles, and a bubble not yet shown has not visually "arrived" yet. If
 * the person writes while later bubbles are still arriving, those bubbles land
 * after their message — the order this file arranges and persists as compact,
 * non-content-bearing anchors.
 */

export interface PipInterleaveRecord {
  v: 1;
  /** Zero-based Pip turn cluster ordinal in the session, plus a content hash anchor. */
  turn: number;
  turnHash: string;
  turnRepeat: number;
  /** Zero-based visible user-row ordinal in the session, plus a content hash anchor. */
  user: number;
  userHash: string;
  userRepeat: number;
  /** How many bubbles of the turn were already before this user message. */
  before: number;
  /** Bubble count of the turn when the crossing was recorded. */
  bubbles: number;
  at: number;
}

export interface PipRuntimeSplit {
  turnId: string;
  userId: string;
  before: number;
}

type PipBubble = Extract<ChatRow, { kind: "pip-bubble" }>;
type UserRow = Extract<ChatRow, { kind: "user" }>;

export interface PipTurnScan {
  turnId: string;
  index: number;
  repeat: number;
  hash: string;
  start: number;
  end: number;
  rows: ChatRow[];
  bubbles: PipBubble[];
}

export interface PipUserScan {
  row: UserRow;
  index: number;
  ordinal: number;
  repeat: number;
  hash: string;
}

export interface PipRowsScan {
  clusters: PipTurnScan[];
  users: PipUserScan[];
}

/** Small non-reversible content anchor; the store never carries message text. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length.toString(36)}-${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

const delayForLength = (len: number) => Math.max(320, Math.min(480, 360 + Math.max(-40, Math.min(120, (len - 24) * 2))));

/** The comfortable gap between two consecutive bubble arrivals. */
export function pipRevealDelayMs(previousText: string): number {
  return delayForLength(Array.from(previousText).length);
}

const clusterTurnId = (row: ChatRow): string | undefined =>
  (row.kind === "pip-bubble" || row.kind === "media" || row.kind === "pip-sessions" || row.kind === "pip-footer")
    ? row.pip?.meta?.turnId
    : undefined;

/** Scans the normally-projected rows into Pip turn clusters and visible user rows. */
export function scanPipRows(rows: readonly ChatRow[]): PipRowsScan {
  const clusters: PipTurnScan[] = [];
  const users: PipUserScan[] = [];
  const userRepeats = new Map<string, number>();
  const clusterRepeats = new Map<string, number>();
  let open: { turnId: string; start: number; rows: ChatRow[]; bubbles: PipBubble[] } | undefined;

  const close = (end: number) => {
    if (!open) return;
    const text = open.bubbles[0]?.fullText || open.bubbles.map((b) => b.copyText).join("\n\n");
    const hash = hashText(text);
    const repeat = clusterRepeats.get(hash) ?? 0;
    clusterRepeats.set(hash, repeat + 1);
    clusters.push({
      turnId: open.turnId,
      index: clusters.length,
      repeat,
      hash,
      start: open.start,
      end,
      rows: open.rows,
      bubbles: open.bubbles,
    });
    open = undefined;
  };

  rows.forEach((row, index) => {
    if (row.kind === "user") {
      const hash = hashText(`${row.text}\n${row.images}`);
      const repeat = userRepeats.get(hash) ?? 0;
      userRepeats.set(hash, repeat + 1);
      users.push({ row, index, ordinal: users.length, repeat, hash });
    }
    const turnId = clusterTurnId(row);
    if (!turnId) {
      close(index - 1);
      return;
    }
    if (!open || open.turnId !== turnId) {
      close(index - 1);
      open = { turnId, start: index, rows: [], bubbles: [] };
    }
    open.rows.push(row);
    if (row.kind === "pip-bubble") open.bubbles.push(row);
  });
  close(rows.length - 1);
  return { clusters, users };
}

/** Builds the compact persisted anchor for one crossing. */
export function makePipInterleaveRecord(
  scan: PipRowsScan,
  cluster: PipTurnScan,
  user: PipUserScan,
  before: number,
  at = Date.now(),
): PipInterleaveRecord {
  return {
    v: 1,
    turn: cluster.index,
    turnHash: cluster.hash,
    turnRepeat: cluster.repeat,
    user: user.ordinal,
    userHash: user.hash,
    userRepeat: user.repeat,
    before: Math.max(1, Math.min(cluster.bubbles.length - 1, before)),
    bubbles: cluster.bubbles.length,
    at,
  };
}

/** Resolves persisted anchors against this load's rows. Duplicate or stale anchors are ignored. */
export function resolvePipInterleaves(rows: readonly ChatRow[], records: readonly PipInterleaveRecord[]): PipRuntimeSplit[] {
  if (!records.length) return [];
  const scan = scanPipRows(rows);
  const out: PipRuntimeSplit[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.v !== 1) continue;
    const sameTurn = scan.clusters.filter((cluster) => cluster.hash === record.turnHash);
    const cluster = sameTurn[record.turnRepeat] ?? sameTurn[0] ?? scan.clusters[record.turn];
    const sameUser = scan.users.filter((user) => user.hash === record.userHash);
    const user = sameUser[record.userRepeat] ?? sameUser[0] ?? scan.users[record.user];
    if (!cluster || !user) continue;
    if (user.index <= cluster.end) continue;
    const before = Math.max(1, Math.min(cluster.bubbles.length - 1, Math.floor(record.before)));
    if (!Number.isFinite(before) || before < 1 || before >= cluster.bubbles.length) continue;
    const key = `${cluster.turnId}:${user.row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ turnId: cluster.turnId, userId: user.row.id, before });
  }
  return out;
}

const normalizedRows = new WeakMap<ChatRow, Map<string, ChatRow>>();
const normalizedRow = (row: ChatRow, key: string, make: () => ChatRow) => {
  let versions = normalizedRows.get(row);
  if (!versions) {
    versions = new Map();
    normalizedRows.set(row, versions);
  }
  const cached = versions.get(key);
  if (cached) return cached;
  const next = make();
  versions.set(key, next);
  return next;
};

function normalizeFinalGroups(rows: readonly ChatRow[]): ChatRow[] {
  const out = rows.slice();
  for (let i = 0; i < out.length; i++) {
    const row = out[i];
    if (row.kind === "user" && row.sms) {
      const first = i === 0 || out[i - 1].kind !== "user";
      const last = i + 1 >= out.length || out[i + 1].kind !== "user";
      if (row.sms.first !== first || row.sms.last !== last) {
        out[i] = normalizedRow(row, `u:${first}:${last}`, () => ({ ...row, sms: { ...row.sms, first, last } }));
      }
    }
  }

  for (let i = 0; i < out.length; i++) {
    const firstRow = out[i];
    if (firstRow.kind !== "pip-bubble") continue;
    const turnId = firstRow.pip.meta?.turnId;
    let end = i;
    while (end + 1 < out.length) {
      const next = out[end + 1];
      if (next.kind !== "pip-bubble" || next.pip.meta?.turnId !== turnId) break;
      end++;
    }
    for (let at = i; at <= end; at++) {
      const row = out[at];
      if (row.kind !== "pip-bubble") continue;
      const first = at === i;
      const last = at === end;
      const lead = first;
      const after = out[end + 1];
      const mediaOwnsTail = at === end && after?.kind === "media" && after.pip?.meta?.turnId === turnId;
      const tail = last && !mediaOwnsTail;
      if (row.first !== first || row.last !== last || Boolean(row.pip.lead) !== lead || Boolean(row.pip.tail) !== tail) {
        out[at] = normalizedRow(row, `p:${first}:${last}:${lead}:${tail}`, () => ({ ...row, first, last, pip: { ...row.pip, lead, tail } }));
      }
    }
    i = end;
  }
  return out;
}

function buildClusterRows(
  cluster: PipTurnScan,
  users: { split: PipRuntimeSplit; user: PipUserScan }[],
  released: number,
): ChatRow[] {
  const total = cluster.bubbles.length;
  const out: ChatRow[] = [];
  const tailRows = cluster.rows.filter((row) => row.kind !== "pip-bubble");
  const ordered = users.slice().sort((a, b) => a.split.before - b.split.before || a.user.index - b.user.index);
  let nextUser = 0;
  const emitUsers = (before: number) => {
    while (nextUser < ordered.length && ordered[nextUser].split.before <= before) {
      out.push(ordered[nextUser].user.row);
      nextUser++;
    }
  };

  for (let position = 1; position <= total; position++) {
    if (position <= released) out.push(cluster.bubbles[position - 1]);
    emitUsers(position);
  }
  emitUsers(Number.POSITIVE_INFINITY);
  if (released >= total) out.push(...tailRows);
  return out;
}

/**
 * Reorders and gates a persona's projected rows. `visibility` maps a revealing
 * turn id to the number of leading bubbles currently visible; turns absent
 * from the map are complete. User rows named by splits are never hidden.
 */
export function arrangePipRows(
  rows: readonly ChatRow[],
  splits: readonly PipRuntimeSplit[],
  visibility: ReadonlyMap<string, number> = new Map(),
): ChatRow[] {
  const scan = scanPipRows(rows);
  if (!scan.clusters.length) return rows.slice();
  const userById = new Map(scan.users.map((user) => [user.row.id, user]));
  const splitUsers = new Set<string>();
  const splitsByTurn = new Map<string, { split: PipRuntimeSplit; user: PipUserScan }[]>();
  const splitSeen = new Set<string>();
  for (const split of splits) {
    const user = userById.get(split.userId);
    if (!user) continue;
    const key = `${split.turnId}:${split.userId}`;
    if (splitSeen.has(key)) continue;
    splitSeen.add(key);
    splitUsers.add(split.userId);
    const list = splitsByTurn.get(split.turnId) ?? [];
    list.push({ split, user });
    splitsByTurn.set(split.turnId, list);
  }

  const starts = new Map(scan.clusters.map((cluster) => [cluster.start, cluster]));
  const out: ChatRow[] = [];
  for (let index = 0; index < rows.length; index++) {
    const cluster = starts.get(index);
    if (cluster) {
      out.push(...buildClusterRows(cluster, splitsByTurn.get(cluster.turnId) ?? [], visibility.get(cluster.turnId) ?? cluster.bubbles.length));
      index = cluster.end;
      continue;
    }
    const row = rows[index];
    if (row.kind === "user" && splitUsers.has(row.id)) continue;
    out.push(row);
  }
  // Visibility alone does not regroup bubbles: an unrevealed successor is already
  // represented by the quiet typing bubble, so corners stay in their final positions.
  // A real crossing is different — the user row permanently breaks the incoming group.
  return splitUsers.size > 0 ? normalizeFinalGroups(out) : out;
}

interface RevealState {
  total: number;
  released: number;
  complete: boolean;
  signature: string;
  lengths: number[];
  splits: PipRuntimeSplit[];
  timer?: ReturnType<typeof setTimeout>;
}

export interface PipRevealResult {
  rows: ChatRow[];
  pending: boolean;
}

export interface PipRevealControllerOptions {
  notify: () => void;
  isLiveRow: (rowId: string) => boolean;
  reduceMotion: () => boolean;
  onInterleave?: (record: PipInterleaveRecord) => void;
}

/**
 * Owns the timers and per-turn reveal state of one chat surface. The first
 * bubble is visible immediately; later bubbles arrive one at a time. A user
 * row observed while a turn is incomplete becomes a crossing, not a flush.
 */
export class PipRevealController {
  private states = new Map<string, RevealState>();

  constructor(private readonly options: PipRevealControllerOptions) {}

  private finish(state: RevealState, total = state.total) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.total = total;
    state.released = total;
    state.complete = true;
  }

  private arm(state: RevealState) {
    if (state.complete || state.timer) return;
    const previousLength = state.lengths[Math.max(0, state.released - 1)] ?? 24;
    const delay = delayForLength(previousLength);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.options.reduceMotion()) {
        this.finish(state);
      } else if (!state.complete) {
        state.released = Math.min(state.total, state.released + 1);
        if (state.released >= state.total) this.finish(state);
      }
      this.options.notify();
      this.arm(state);
    }, delay);
  }

  private signature(cluster: PipTurnScan): string {
    return cluster.bubbles.map((bubble) => `${bubble.rowId}:${bubble.copyText.length}:${hashText(bubble.copyText)}:${bubble.versions?.length ?? 0}`).join("|");
  }

  /** Applies live reveal state and persisted crossings to one normal projection. */
  apply(rows: readonly ChatRow[], persisted: readonly PipInterleaveRecord[]): PipRevealResult {
    const scan = scanPipRows(rows);
    const splits = resolvePipInterleaves(rows, persisted);
    const visibility = new Map<string, number>();

    for (const cluster of scan.clusters) {
      if (cluster.bubbles.length < 2) continue;
      const signature = this.signature(cluster);
      let state = this.states.get(cluster.turnId);
      if (state && state.signature !== signature) {
        // A message_edit (or an authoritative rewrite) replaces the answer:
        // close out the rhythm and show the replacement whole rather than dropping words.
        this.finish(state, cluster.bubbles.length);
        state.signature = signature;
        state.lengths = cluster.bubbles.map((bubble) => Array.from(bubble.copyText).length);
        state.splits = [];
      }
      if (!state) {
        const live = cluster.bubbles.some((bubble) => this.options.isLiveRow(bubble.rowId));
        if (!live || this.options.reduceMotion()) continue;
        state = {
          total: cluster.bubbles.length,
          released: 1,
          complete: false,
          signature,
          lengths: cluster.bubbles.map((bubble) => Array.from(bubble.copyText).length),
          splits: [],
        };
        this.states.set(cluster.turnId, state);
        this.arm(state);
      }

      if (!state.complete) {
        if (this.options.reduceMotion()) {
          this.finish(state);
        } else {
          for (const user of scan.users) {
            if (user.index <= cluster.end) continue;
            if (state.splits.some((split) => split.userId === user.row.id)) continue;
            const before = Math.max(1, Math.min(state.released, state.total - 1));
            state.splits.push({ turnId: cluster.turnId, userId: user.row.id, before });
            this.options.onInterleave?.(makePipInterleaveRecord(scan, cluster, user, before));
          }
          visibility.set(cluster.turnId, state.released);
          this.arm(state);
        }
      }
      for (const split of state.splits) {
        if (!splits.some((known) => known.turnId === split.turnId && known.userId === split.userId)) splits.push(split);
      }
    }

    return { rows: arrangePipRows(rows, splits, visibility), pending: visibility.size > 0 };
  }

  /** Clears every timer. The next projection decides from history seeds whether anything may animate. */
  reset() {
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.states.clear();
  }
}
