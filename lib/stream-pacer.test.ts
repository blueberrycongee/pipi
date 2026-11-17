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
