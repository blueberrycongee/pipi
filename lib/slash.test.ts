import { expect, test } from "nsh/test";
import { answersTo, type ComposerCommand, matchCommands, matchOptions, parseSlashLine, readSlashInput } from "./slash";

const commands: ComposerCommand[] = [
  { name: "new", description: "Start a new session", source: "app", aliases: ["clear"], keywords: ["新建"] },
  { name: "compact", description: "Compact the context", source: "app", keywords: ["压缩"] },
  { name: "name", description: "Rename this session", source: "app", aliases: ["rename"] },
  { name: "clear-cache", description: "Empty the build cache", source: "prompt" },
  { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
  { name: "skill:review", description: "Review a change", source: "skill" },
];
const names = (query: string) => matchCommands(commands, query).map((command) => command.name);

test("reads the draft as a command being typed, a first argument, or neither", () => {
  expect(readSlashInput("/")).toEqual({ kind: "command", query: "" });
  expect(readSlashInput("/Fix")).toEqual({ kind: "command", query: "fix" });
  expect(readSlashInput("/delegate ")).toEqual({ kind: "argument", name: "delegate", query: "" });
  expect(readSlashInput("/delegate Cl")).toEqual({ kind: "argument", name: "delegate", query: "cl" });
  // Past the first argument the line is the user's own words.
  expect(readSlashInput("/delegate claude review this")).toBe(undefined);
  expect(readSlashInput("/name\n")).toBe(undefined);
  // A path is not a command; nor is a slash anywhere but first.
  expect(readSlashInput("/Users/pip/notes.txt")).toBe(undefined);
  expect(readSlashInput("see /new")).toBe(undefined);
  expect(readSlashInput("")).toBe(undefined);
});

test("the slash key under a Chinese input method opens the menu too", () => {
  expect(readSlashInput("、")).toEqual({ kind: "command", query: "" });
  expect(readSlashInput("、压缩")).toEqual({ kind: "command", query: "压缩" });
  expect(readSlashInput("／new")).toEqual({ kind: "command", query: "new" });
});

test("finds commands by name first, then by part, alias and description", () => {
  expect(names("")).toEqual(["new", "compact", "name", "clear-cache", "fix-tests", "skill:review"]);
  // The name typed in full comes before names that only start with it.
  expect(names("n")).toEqual(["new", "name"]);
  expect(names("name")).toEqual(["name"]);
  // A part after `:` or `-` finds the command; so does a name from another tool, and the action in Chinese.
  expect(names("review")).toEqual(["skill:review"]);
  expect(names("tests")).toEqual(["fix-tests"]);
  expect(names("rename")).toEqual(["name"]);
  // An alias typed in full is the command's name: it comes before names that only start with it.
  expect(names("clear")).toEqual(["new", "clear-cache"]);
  expect(names("cle")).toEqual(["clear-cache", "new"]);
  expect(answersTo(commands[0], "new")).toBe(true);
  expect(answersTo(commands[0], "clear")).toBe(true);
  expect(answersTo(commands[0], "新建")).toBe(false);
  expect(names("压")).toEqual(["compact"]);
  // Descriptions are searched by a word, never by one letter.
  expect(names("failing")).toEqual(["fix-tests"]);
  expect(names("g")).toEqual([]);
  expect(names("zzz")).toEqual([]);
});

test("finds a command's argument values by value, then by what they are called", () => {
  const agents = [
    { value: "pi", description: "Pi" },
    { value: "claude", description: "Claude Code" },
    { value: "codex", description: "Codex" },
  ];
  expect(matchOptions(agents, "").map((o) => o.value)).toEqual(["pi", "claude", "codex"]);
  expect(matchOptions(agents, "c").map((o) => o.value)).toEqual(["claude", "codex"]);
  expect(matchOptions(agents, "code").map((o) => o.value)).toEqual(["codex", "claude"]);
});

test("parses a finished line into a command and what follows it", () => {
  expect(parseSlashLine("/new")).toEqual({ name: "new", args: "" });
  expect(parseSlashLine("  /compact keep the plan ")).toEqual({ name: "compact", args: "keep the plan" });
  expect(parseSlashLine("/delegate claude review\nthe diff")).toEqual({ name: "delegate", args: "claude review\nthe diff" });
  expect(parseSlashLine("/Users/pip/notes.txt explain")).toBe(undefined);
  expect(parseSlashLine("/")).toBe(undefined);
  expect(parseSlashLine("new")).toBe(undefined);
});
