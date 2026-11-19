import { expect, test } from "nsh/test";
import { matchDocMentions, readDocMention, removeDocMention } from "./doc-mention";

test("readDocMention matches @ at start or after whitespace, never inside emails", () => {
  expect(readDocMention("@")).toEqual({ start: 0, end: 1, query: "" });
  expect(readDocMention("@Plan")).toEqual({ start: 0, end: 5, query: "plan" });
  expect(readDocMention("Review @arch")).toEqual({ start: 7, end: 12, query: "arch" });
  expect(readDocMention("看看 ＠架构")).toEqual({ start: 3, end: 6, query: "架构" });
  expect(readDocMention("Check (@plan", 12)).toEqual({ start: 7, end: 12, query: "plan" });
  expect(readDocMention("email foo@bar.com")).toBeUndefined();
  expect(readDocMention("Review @arch please")).toBeUndefined();
  // Caret in the middle of the message still sees the mention right before it.
  expect(readDocMention("Review @arch please", 12)).toEqual({ start: 7, end: 12, query: "arch" });
});

test("matchDocMentions prefers exact and prefix matches, then open documents", () => {
  const docs = [
    { path: "/docs/note-1.md", title: "Release checklist", open: false },
    { path: "/docs/arch-post.md", title: "Architecture notes", open: true },
    { path: "/docs/note-2.md", title: "Launch plan", open: false },
    { path: "/repo/PLAN.md", title: "Plan", open: true },
  ];
  expect(matchDocMentions(docs, "").map((d) => d.title)).toEqual([
    "Architecture notes",
    "Plan",
    "Release checklist",
    "Launch plan",
  ]);
  expect(matchDocMentions(docs, "plan").map((d) => d.title)).toEqual(["Plan", "Launch plan"]);
  expect(matchDocMentions(docs, "arch-post").map((d) => d.title)).toEqual(["Architecture notes"]);
  expect(matchDocMentions(docs, "nope")).toEqual([]);
});

test("removeDocMention cleans surrounding whitespace naturally", () => {
  expect(removeDocMention("@plan", { start: 0, end: 5, query: "plan" })).toEqual({ text: "", caret: 0 });
  expect(removeDocMention("Review @plan", { start: 7, end: 12, query: "plan" })).toEqual({ text: "Review", caret: 6 });
  expect(removeDocMention("Review @plan please", { start: 7, end: 12, query: "plan" })).toEqual({
    text: "Review please",
    caret: 7,
  });
  expect(removeDocMention("@plan please", { start: 0, end: 5, query: "plan" })).toEqual({ text: "please", caret: 0 });
});
