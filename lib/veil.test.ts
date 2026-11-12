import { expect, test } from "nsh/test";
import {
  advanceVeil,
  chunkAlpha,
  clearVeils,
  commonPrefix,
  rowVeil,
  settleVeil,
  sliceChunks,
  veilBoost,
  veilDurationMs,
  veilEmaNext,
  veilOpacity,
  type RowVeil,
} from "./veil";
import { closeHangingInline, mendStreamingMarkdown, PENDING_LINK_URL } from "./mend";

const fresh = (): RowVeil => ({ elems: new Map(), seeding: false, initialized: false, seenBlocks: 0, blockNodes: new Map() });
const seeded = (v: RowVeil): RowVeil => { v.initialized = true; return v; };

test("veil constants and cadence math", () => {
  // duration = clamp(ema*3, 120, 400); seed 160 -> max, fast stream -> floor.
  expect(veilDurationMs(160)).toBe(400);
  expect(veilDurationMs(30)).toBe(120);
  expect(veilDurationMs(60)).toBe(180);
  // ema = ema*0.7 + min(gap,1000)*0.3.
  expect(veilEmaNext(160, 100)).toBe(160 * 0.7 + 100 * 0.3);
  expect(veilEmaNext(160, 5000)).toBe(160 * 0.7 + 1000 * 0.3);
  // boost = 1 + 0.3*max(0, n-2).
  expect(veilBoost(0)).toBe(1);
  expect(veilBoost(2)).toBe(1);
  expect(Math.abs(veilBoost(3) - 1.3) < 1e-6).toBe(true);
  expect(Math.abs(veilBoost(5) - 1.9) < 1e-6).toBe(true);
});

test("veil opacity curve: 1-(1-p)^1.6, clamped, monotonic", () => {
  expect(veilOpacity(0)).toBe(0);
  expect(veilOpacity(1)).toBe(1);
  const mid = veilOpacity(0.5);
  expect(mid).toBeGreaterThan(0.5);
  expect(Math.abs(mid - (1 - Math.pow(0.5, 1.6))) < 1e-6).toBe(true);
  expect(veilOpacity(-1)).toBe(0);
  expect(veilOpacity(2)).toBe(1);
  expect(veilOpacity(0.2)).toBeLessThan(veilOpacity(0.4));
});

test("common prefix never splits a surrogate pair", () => {
  expect(commonPrefix("é", "è")).toBe(0); // wait: é/è differ in the low byte of a single char
  expect(commonPrefix("ab", "ab")).toBe(2);
  const a = "x🚀y";
  const b = "x🚀z"; // share "x🚀" (3 code units), differ at y/z
  expect(commonPrefix(a, b)).toBe(3);
  // If the prefix would end after a high surrogate, snap back.
  const c = "x🚀";
  expect(commonPrefix("x\uD83D\uDE80y", c)).toBe(3); // whole surrogate pair is shared
  // A prefix that would end inside a surrogate pair snaps back to the boundary.
  expect(commonPrefix("x\uD83D", "x\uD83D\uDE80")).toBe(1);
});

test("row veil: first-seen text is the baseline, only appends fade, chunks settle once", () => {
  const v = seeded(fresh());
  v.elems.set("root", { prev: "already on screen", chunks: [], emaMs: 160, lastAppend: null }); // attach adopted the text as its baseline
  const chunks = advanceVeil(v, "already on screen plus", 1000);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].start).toBe(17);
  expect(chunks[0].end).toBe(22);
  // Settled after its duration (400ms max): never fades again.
  expect(advanceVeil(v, "already on screen plus", 1000 + 410)).toHaveLength(0);
  // A later append veils only the new suffix.
  const next = advanceVeil(v, "already on screen plus more", 1600);
  expect(next).toHaveLength(1);
  expect(next[0].start).toBe(22);
});

test("concurrent chunks fade independently; rewrites keep the committed prefix", () => {
  const v = seeded(fresh());
  advanceVeil(v, "one ", 0);
  const chunks = advanceVeil(v, "one two ", 100);
  expect(chunks).toHaveLength(2);
  expect(chunks[0].start).toBe(0);
  expect(chunks[1].start).toBe(4);
  // Non-append rewrite (markdown resolving): prefix kept, tail re-veiled.
  v.elems.set("root", { prev: "intro **bol", chunks: [{ start: 0, end: 11, startedAt: 0, durationMs: 400 }], emaMs: 160, lastAppend: null });
  const spans = advanceVeil(v, "intro bold", 50);
  expect(spans).toHaveLength(2);
  expect(spans[0].end).toBe(6);
  expect(spans[1].start).toBe(6);
});

test("settle clears the veil; sliceChunks shifts to local offsets", () => {
  const v = seeded(fresh());
  advanceVeil(v, "hello", 0);
  settleVeil(v, "hello");
  expect(advanceVeil(v, "hello", 10)).toHaveLength(0);
  const v2 = seeded(fresh());
  const chunks = advanceVeil(v2, "helloworld", 0);
  const local = sliceChunks(chunks, 5, 10);
  expect(local).toHaveLength(1);
  expect(local[0].start).toBe(0);
  expect(local[0].end).toBe(5);
  expect(sliceChunks(chunks, 20, 30)).toHaveLength(0);
});

test("rowVeil: a row first seen non-streaming seeds; a live row's first chunk fades", () => {
  clearVeils();
  // Not streaming at first sight (history, session switch): baseline, no fade.
  const history = rowVeil("history-row");
  expect(advanceVeil(history, "full reply", 0, true)).toHaveLength(0);
  // A streaming row seen already past a screenful is a re-attach: it seeds too.
  const mid = rowVeil("mid-row");
  expect(advanceVeil(mid, "x".repeat(300), 0)).toHaveLength(0);
  // A streaming row first seen short: its first text fades like any chunk.
  const live = rowVeil("live-row");
  const chunks = advanceVeil(live, "first text", 0);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].start).toBe(0);
  clearVeils();
});

test("chunkAlpha stays monotonic across intermediate animation frames when boosted chunks retire", () => {
  const v = seeded(fresh());
  advanceVeil(v, "aaa ", 0);
  advanceVeil(v, "aaa bbb ", 40);
  const chunks = advanceVeil(v, "aaa bbb ccc", 80);
  expect(chunks).toHaveLength(3);
  const tailChunk = chunks[2];

  // Sample every 10ms across the entire fade without arriving deltas: alpha must never dip backward!
  let prevAlpha = 0;
  for (let t = 80; t <= 500; t += 10) {
    const a = chunkAlpha(chunks, tailChunk, t);
    expect(a).toBeGreaterThanOrEqual(prevAlpha - 1e-6);
    prevAlpha = a;
  }
  expect(prevAlpha).toBe(1);
});

test("closeHangingInline mends hanging inline edge cases", () => {
  // Trailing whitespace: closer goes BEFORE trailing space so it stays right-flanking
  expect(closeHangingInline("**bold ")).toBe("**bold** ");
  expect(closeHangingInline("*em\n")).toBe("*em*\n");

  // Half-streamed closers and nested closers
  expect(closeHangingInline("**bold*")).toBe("**bold**");
  expect(closeHangingInline("~~gone~")).toBe("~~gone~~");
  expect(closeHangingInline("**a *b")).toBe("**a *b***");
  expect(closeHangingInline("_a **b")).toBe("_a **b**_");

  // Intraword `*` and `_` stay literal
  expect(closeHangingInline("2*3 equals 6")).toBe("2*3 equals 6");
  expect(closeHangingInline("snake_case_name")).toBe("snake_case_name");

  // Setext heading flash guard: closers go above the underline, zero-width space appended
  expect(closeHangingInline("para\n-")).toBe("para\n-\u200B");
  expect(closeHangingInline("**b\n-")).toBe("**b**\n-\u200B");

  // Math shielding, prices, shell variables, and half display closers
  expect(closeHangingInline("so $x_{1} + b")).toBe("so $x_{1} + b");
  expect(closeHangingInline("so $a_1 * b_2$ done")).toBe("so $a_1 * b_2$ done");
  expect(closeHangingInline("costs $5 and **bo")).toBe("costs $5 and **bo**");
  expect(closeHangingInline("$$x^2$")).toBe("$$x^2$$");
  expect(closeHangingInline("echo $PATH:$HOME/bin **bo")).toBe("echo $PATH:$HOME/bin **bo**");
  expect(closeHangingInline("Escape \\[ in regex, **bold")).toBe("Escape \\[ in regex, **bold**");

  // Links & emphasis inside links
  expect(closeHangingInline("[docs](https://x.dev/lo")).toBe(`[docs](${PENDING_LINK_URL})`);
  expect(closeHangingInline("[**a")).toBe(`[**a**](${PENDING_LINK_URL})`);
  expect(closeHangingInline("**a [b")).toBe(`**a [b](${PENDING_LINK_URL})**`);

  // Closed code fence with blank lines inside does not confuse trailing inline mending
  const withFence = "```ts\nconst a = 1;\n\nconst b = 2;\n```\n**trailing bold ";
  expect(mendStreamingMarkdown(withFence).source).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n```\n**trailing bold** ");
});
