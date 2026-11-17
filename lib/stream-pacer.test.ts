import { expect, test } from "nsh/test";
import { clearPacers, markPacersSeeded, pacedStreamText } from "./stream-pacer";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("small deltas pass through immediately; settled or reduced text bypasses pacer", () => {
  clearPacers();
  expect(pacedStreamText("r1", "hello", true, false)).toBe("hello");
  expect(pacedStreamText("r1", "hello world", true, false)).toBe("hello world");

  // Large burst with reduced motion returns full text at once.
  const longText = "a".repeat(120);
  expect(pacedStreamText("r2", longText, true, true)).toBe(longText);

  // Settled stream immediately drains remaining text.
  expect(pacedStreamText("r3", "a".repeat(80), true, false).length).toBeLessThan(80);
  expect(pacedStreamText("r3", "a".repeat(80), false, false)).toBe("a".repeat(80));
  clearPacers();
});

test("bursty packets drain smoothly across frames without splitting surrogate pairs", async () => {
  clearPacers();
  const burst = "Streaming ".repeat(4) + "🚀🚀🚀" + " smoothly across frames.";
  const first = pacedStreamText("r-burst", burst, true, false);
  expect(first.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThan(burst.length);

  // Wait enough 16ms frames for the pacer to drain completely.
  await wait(240);
  const done = pacedStreamText("r-burst", burst, true, false);
  expect(done).toBe(burst);

  // Check surrogate boundary safety right at an emoji boundary.
  clearPacers();
  const emojiBurst = "12345678901234567890123456789012345\uD83D\uDE80end";
  let seen = pacedStreamText("r-emoji", emojiBurst, true, false);
  while (seen.length < emojiBurst.length) {
    const lastCode = seen.charCodeAt(seen.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    await wait(20);
    seen = pacedStreamText("r-emoji", emojiBurst, true, false);
  }
  expect(seen).toBe(emojiBurst);
  clearPacers();
});

test("markPacersSeeded commits existing baseline and paces only subsequent appends", () => {
  clearPacers();
  markPacersSeeded(["r-seed"]);
  const base = "Short existing reply";
  expect(pacedStreamText("r-seed", base, true, false)).toBe(base);
  const next = base + " plus a very long sudden network delta packet arriving later";
  const mid = pacedStreamText("r-seed", next, true, false);
  expect(mid.length).toBeGreaterThan(base.length);
  expect(mid.length).toBeLessThan(next.length);
  clearPacers();
});

/** Every prefix the pacer shows of `text` on its way, in order, and how long the drain took. */
async function drainOf(id: string, text: string): Promise<{ shown: string[]; ms: number }> {
  const started = Date.now();
  const shown: string[] = [pacedStreamText(id, text, true, false)];
  while (shown[shown.length - 1].length < text.length) {
    await wait(4);
    const next = pacedStreamText(id, text, true, false);
    if (next !== shown[shown.length - 1]) shown.push(next);
    if (Date.now() - started > 3000) break;
  }
  return { shown, ms: Date.now() - started };
}

const LETTER = /[A-Za-z0-9]/;
/** The cuts that fell between two letters of one Latin word. */
const midWord = (shown: string[], text: string) =>
  shown.filter((s) => s.length < text.length && LETTER.test(text[s.length - 1]) && LETTER.test(text[s.length]));

test("a cut lands on a word's edge, so no word fades in as two halves", async () => {
  clearPacers();
  const prose =
    "The reducer keeps a stable prefix cache so settled blocks are neither re-parsed nor re-stringified on later deltas, which is what the whole thing rests on.";
  const a = await drainOf("r-words", prose);
  expect(a.shown[a.shown.length - 1]).toBe(prose);
  expect(a.shown.length).toBeGreaterThan(2);
  expect(midWord(a.shown, prose)).toEqual([]);

  const marked = "Streaming a code span `pacedStreamText` and a **bold run** across frames, with 1234567890 digits.";
  const b = await drainOf("r-marked", marked);
  expect(b.shown[b.shown.length - 1]).toBe(marked);
  expect(midWord(b.shown, marked)).toEqual([]);
  clearPacers();
});

test("text without word gaps still drains: CJK, and a word longer than the reach", async () => {
  clearPacers();
  const cjk = "这是一段中文回复，用来检查断词在中文里不会把词语切断造成两段各自淡入的问题。";
  const a = await drainOf("r-cjk", cjk);
  expect(a.shown[a.shown.length - 1]).toBe(cjk);
  expect(a.shown.length).toBeGreaterThan(1);

  // No edge within reach: the cut stays where the step put it rather than stall.
  const long = "a".repeat(120);
  const b = await drainOf("r-long", long);
  expect(b.shown[b.shown.length - 1]).toBe(long);
  for (let i = 1; i < b.shown.length; i++) expect(b.shown[i].length).toBeGreaterThan(b.shown[i - 1].length);
  clearPacers();
});
