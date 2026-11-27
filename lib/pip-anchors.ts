import type { Row } from "../pi/transcript";

/**
 * Stable in-conversation anchors for a persona message's local adornments and
 * quote targets. Rows keep their order in a session file even when cold loads
 * mint fresh row ids, so an anchor is the message's ordinal among its kind —
 * plus the SMS bubble index inside one Pip reply.
 */

export function userAnchor(rows: readonly Row[], rowId: string): string | undefined {
  let at = 0;
  for (const row of rows) {
    if (row.kind !== "user") continue;
    at++;
    if (row.id === rowId) return `u:${at}`;
  }
  return undefined;
}

export function pipAnchor(rows: readonly Row[], rowId: string, bubbleIndex: number): string | undefined {
  let at = 0;
  for (const row of rows) {
    if (row.kind !== "text") continue;
    at++;
    if (row.id === rowId) return `a:${at}#b${Math.max(0, bubbleIndex)}`;
  }
  return undefined;
}

/** The transcript row an anchor names, and the display-row id its SMS bubble carries. */
export function resolveAnchor(rows: readonly Row[], target: string): { row?: Row; rowId?: string; displayId?: string } {
  const user = /^u:(\d+)$/.exec(target);
  if (user) {
    const wanted = Number(user[1]);
    let at = 0;
    for (const row of rows) {
      if (row.kind !== "user") continue;
      at++;
      if (at === wanted) return { row, rowId: row.id, displayId: row.id };
    }
    return {};
  }
  const pip = /^a:(\d+)(?:#b(\d+))?$/.exec(target);
  if (pip) {
    const wanted = Number(pip[1]);
    const bubble = Number(pip[2] ?? 0);
    let at = 0;
    for (const row of rows) {
      if (row.kind !== "text") continue;
      at++;
      if (at === wanted) return { row, rowId: row.id, displayId: `${row.id}#b${bubble}` };
    }
  }
  return {};
}
