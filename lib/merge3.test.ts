import { expect, test } from "nsh/test";
import { merge3 } from "./merge3";

// Two writers on one document: the person typing, and whatever else writes its file.
//
//   nsh test lib/merge3.test.ts

const lines = (...l: string[]) => l.join("\n");

test("one side's change stands when the other left the text alone", () => {
  const base = lines("# Title", "", "one", "", "two");
  const changed = lines("# Title", "", "one, reworded", "", "two");
  expect(merge3(base, base, changed)).toEqual({ text: changed, conflict: false });
  expect(merge3(base, changed, base)).toEqual({ text: changed, conflict: false });
  expect(merge3(base, changed, changed)).toEqual({ text: changed, conflict: false });
});

test("changes to different paragraphs both stand", () => {
  const base = lines("# Title", "", "one", "", "two", "", "three");
  const mine = lines("# Title", "", "one", "", "two", "", "three, still being typed");
  const theirs = lines("# Title", "", "one, tightened", "", "two", "", "three");
  expect(merge3(base, mine, theirs)).toEqual({
    text: lines("# Title", "", "one, tightened", "", "two", "", "three, still being typed"),
    conflict: false,
  });
});

test("lines added by each side at different places both stand", () => {
  const base = lines("a", "b", "c");
  const mine = lines("a", "b", "c", "", "d");
  const theirs = lines("intro", "", "a", "b", "c");
  expect(merge3(base, mine, theirs)).toEqual({ text: lines("intro", "", "a", "b", "c", "", "d"), conflict: false });
});

test("a paragraph one side removed and the other never touched is gone", () => {
  const base = lines("a", "", "b", "", "c");
  const mine = lines("a", "", "b", "", "c", "", "d");
  const theirs = lines("a", "", "c");
  expect(merge3(base, mine, theirs)).toEqual({ text: lines("a", "", "c", "", "d"), conflict: false });
});

test("the same line changed two ways is a conflict, and the one typing keeps theirs", () => {
  const base = lines("a", "", "b", "", "c");
  const mine = lines("a", "", "b, as I say it", "", "c");
  const theirs = lines("a", "", "b, as the agent says it", "", "c, also changed");
  const merged = merge3(base, mine, theirs);
  expect(merged.conflict).toBe(true);
  // Mine where they collide; theirs where only they wrote.
  expect(merged.text).toBe(lines("a", "", "b, as I say it", "", "c, also changed"));
});

test("an emptied document and a rewritten one do not lose the rewrite silently", () => {
  const base = lines("a", "b");
  expect(merge3(base, "", lines("a", "b", "c")).conflict).toBe(true);
  expect(merge3("", "typed", "written")).toEqual({ text: "typed", conflict: true });
});
