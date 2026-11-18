/**
 * A three-way merge of text by lines: what two writers each made of the same
 * base, put together. A document open in the editor has two — the person
 * typing in it, and whatever else writes its file (an agent asked to tighten
 * a paragraph, another editor). Changes to different lines both stand; lines
 * both changed, differently, are a conflict, and `mine` is kept there: the
 * words under the caret are never taken from the one typing them.
 *
 * Lines are the unit because Markdown's paragraphs are lines: a reworded
 * paragraph and a sentence added three paragraphs down do not touch.
 */

/** Past this many cells the longest-common-subsequence table is not built: the texts are too far apart to merge by it. */
const LCS_LIMIT = 4_000_000;

/**
 * Which lines of `a` survive in `b`, as a map from index in `a` to index in
 * `b` (a longest common subsequence), or `undefined` when the texts are too
 * large and too different to compare.
 */
function matches(a: readonly string[], b: readonly string[]): Map<number, number> | undefined {
  const map = new Map<number, number>();
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) map.set(head, head++);
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) map.set(--tailA, --tailB);
  const n = tailA - head;
  const m = tailB - head;
  if (!n || !m) return map;
  if (n * m > LCS_LIMIT) return undefined;
  // lengths[i * (m + 1) + j]: the LCS of a[head + i ..] and b[head + j ..].
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[head + i] === b[head + j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[head + i] === b[head + j]) map.set(head + i++, head + j++);
    else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++;
    else j++;
  }
  return map;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

export interface Merge {
  text: string;
  /** Both sides changed the same lines differently somewhere; `mine` stands there. */
  conflict: boolean;
}

/** `mine` and `theirs`, each a rewrite of `base`, as one text. */
export function merge3(base: string, mine: string, theirs: string): Merge {
  if (mine === theirs || theirs === base) return { text: mine, conflict: false };
  if (mine === base) return { text: theirs, conflict: false };
  const o = base.split("\n");
  const a = mine.split("\n");
  const b = theirs.split("\n");
  const toMine = matches(o, a);
  const toTheirs = matches(o, b);
  if (!toMine || !toTheirs) return { text: mine, conflict: true };

  const out: string[] = [];
  let conflict = false;
  let i = 0;
  let x = 0;
  let y = 0;
  while (i < o.length || x < a.length || y < b.length) {
    // A stretch all three agree on.
    if (i < o.length && toMine.get(i) === x && toTheirs.get(i) === y) {
      out.push(o[i]);
      i++;
      x++;
      y++;
      continue;
    }
    // Up to the next base line both kept: what each side made of the lines between.
    let next = i;
    while (next < o.length && !(toMine.has(next) && toTheirs.has(next))) next++;
    const endMine = next < o.length ? toMine.get(next)! : a.length;
    const endTheirs = next < o.length ? toTheirs.get(next)! : b.length;
    const was = o.slice(i, next);
    const ours = a.slice(x, endMine);
    const others = b.slice(y, endTheirs);
    if (same(ours, was)) out.push(...others);
    else if (same(others, was) || same(ours, others)) out.push(...ours);
    else {
      conflict = true;
      out.push(...ours);
    }
    i = next;
    x = endMine;
    y = endTheirs;
  }
  return { text: out.join("\n"), conflict };
}
