/**
 * Document `@` mentions in the composer: detects `@query` at the caret,
 * ranks open and saved documents, and strips the mention token once a
 * document is attached as a card. No UI, no state.
 */

export interface DocMentionInput {
  /** Start offset of the `@` trigger in the draft. */
  start: number;
  /** End offset of the mention query (the caret). */
  end: number;
  /** Lowercased query typed after `@`. */
  query: string;
}

export interface DocMentionCandidate {
  path: string;
  title: string;
  open?: boolean;
}

const stemOf = (path: string) =>
  (path.split("/").pop() ?? path).replace(/\.(md|markdown|mdown|txt)$/i, "");

/**
 * Reads an active `@query` ending at `caret` (default: end of draft).
 * Only triggers at the start of the message or after whitespace / an opening
 * bracket so email addresses (`a@b.com`) never open the menu. Supports both
 * ASCII `@` and full-width `＠`.
 */
export function readDocMention(draft: string, caret = draft.length): DocMentionInput | undefined {
  const end = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, end);
  const match = /(?:^|[\s(（[【])([@＠][^\s@＠]*)$/.exec(before);
  if (!match) return undefined;
  const token = match[1];
  const start = end - token.length;
  return { start, end, query: token.slice(1).toLowerCase() };
}

function rankCandidate(doc: DocMentionCandidate, query: string): number | undefined {
  const title = doc.title.toLowerCase();
  const stem = stemOf(doc.path).toLowerCase();
  if (title === query || stem === query) return 0;
  if (title.startsWith(query) || stem.startsWith(query)) return 1;
  if (title.split(/[\s:._/-]+/).some((part) => part.startsWith(query))) return 2;
  if (title.includes(query) || stem.includes(query)) return 3;
  return undefined;
}

/** Documents matching `query`, nearest match first (open tabs lead ties). */
export function matchDocMentions<T extends DocMentionCandidate>(all: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...all].sort((a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)));
  }
  const found: { doc: T; rank: number; at: number }[] = [];
  all.forEach((doc, at) => {
    const score = rankCandidate(doc, q);
    if (score !== undefined) found.push({ doc, rank: score, at });
  });
  return found
    .sort((a, b) => a.rank - b.rank || Number(Boolean(b.doc.open)) - Number(Boolean(a.doc.open)) || a.at - b.at)
    .map((entry) => entry.doc);
}

/** Removes the `@query` token from `draft` cleanly without leaving double spaces. */
export function removeDocMention(draft: string, mention: DocMentionInput): { text: string; caret: number } {
  const before = draft.slice(0, mention.start);
  const after = draft.slice(mention.end);
  if (before.endsWith(" ") && after.startsWith(" ")) {
    const next = `${before}${after.slice(1)}`;
    return { text: next, caret: before.length };
  }
  if (!before && after.startsWith(" ")) {
    return { text: after.slice(1), caret: 0 };
  }
  if (!after && before.endsWith(" ")) {
    const trimmed = before.slice(0, -1);
    return { text: trimmed, caret: trimmed.length };
  }
  return { text: `${before}${after}`, caret: before.length };
}
