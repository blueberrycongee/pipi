import { expect, test } from "nsh/test";
import { composeDocMessage, plainMarkdown, splitDocMessage } from "./doc-wire";

// A document riding on a message: what goes to the agent, and what the bubble reads back.
//
//   nsh test lib/doc-wire.test.ts

const NOTE = "/Users/pip/Library/Application Support/pipi/docs/note.md";

test("a document sent without a word is the message itself", () => {
  expect(composeDocMessage("", [{ path: NOTE, text: "# Brief\n\nShip the tabs.\n" }])).toBe("# Brief\n\nShip the tabs.");
  expect(composeDocMessage("  ", [{ path: NOTE, text: "only this passage", excerpt: true }])).toBe("only this passage");
});

test("words come first, then the document in a block that names its file", () => {
  const wire = composeDocMessage("Tighten the second paragraph", [{ path: NOTE, text: "# Brief\n\nShip the tabs.\n" }]);
  expect(wire).toBe(`Tighten the second paragraph\n\n<document path="${NOTE}">\n# Brief\n\nShip the tabs.\n</document>`);
  expect(splitDocMessage(wire)).toEqual({ said: "Tighten the second paragraph", docs: [{ path: NOTE, text: "# Brief\n\nShip the tabs." }] });
});

test("a passage and a whole document ride together, each read back as it went", () => {
  const parts = [
    { path: NOTE, text: "the passage", excerpt: true },
    { path: "/tmp/plan.md", text: "# Plan" },
  ];
  const wire = composeDocMessage("Compare these", parts);
  expect(splitDocMessage(wire)).toEqual({ said: "Compare these", docs: parts });
  // Without words there is still more than one thing to tell apart: blocks, no bare text.
  expect(splitDocMessage(composeDocMessage("", parts))).toEqual({ said: "", docs: parts });
});

test("a document that would read as a command goes in a block", () => {
  expect(composeDocMessage("", [{ path: NOTE, text: "/compact\n" }])).toBe(`<document path="${NOTE}">\n/compact\n</document>`);
  expect(composeDocMessage("", [{ path: NOTE, text: "![shot](a.png)\n\ntext" }]).startsWith("<document ")).toBe(true);
});

test("a message that only mentions the tags is left alone", () => {
  const plain = 'Wrap it in <document path="x"> please';
  expect(splitDocMessage(plain)).toEqual({ said: plain, docs: [] });
  const unclosed = 'Look\n\n<document path="x">\nnever closed';
  expect(splitDocMessage(unclosed)).toEqual({ said: unclosed, docs: [] });
});

test("a document quoting a closing tag ends where the message does", () => {
  const text = "How blocks end:\n</document>\n\nlike that.";
  const wire = composeDocMessage("Explain", [{ path: NOTE, text }]);
  expect(splitDocMessage(wire)).toEqual({ said: "Explain", docs: [{ path: NOTE, text }] });
});

test("a path with a quote survives the attribute", () => {
  const path = '/tmp/say "hi".md';
  expect(splitDocMessage(composeDocMessage("x", [{ path, text: "t" }])).docs[0].path).toBe(path);
});

test("the serializer's escapes come off; code keeps its backslashes", () => {
  expect(plainMarkdown("foo\\_bar and a \\* b, \\<task> in \\~/dev \\[x\\]")).toBe("foo_bar and a * b, <task> in ~/dev [x]");
  expect(plainMarkdown("a path C:\\\\\\*.txt")).toBe("a path C:\\*.txt");
  expect(plainMarkdown("inline `a\\_b` stays, c\\_d goes")).toBe("inline `a\\_b` stays, c_d goes");
  expect(plainMarkdown("```\nx\\_y\n```\n\nz\\_w")).toBe("```\nx\\_y\n```\n\nz_w");
  expect(plainMarkdown("~~~md\n\\# not a heading\n~~~")).toBe("~~~md\n\\# not a heading\n~~~");
});

test("a hard break is its line break; structure stays", () => {
  expect(plainMarkdown("line one\\\nline two")).toBe("line one\nline two");
  expect(plainMarkdown("# Title\n\n- **bold** item\n- [ ] task\n\n> quote")).toBe("# Title\n\n- **bold** item\n- [ ] task\n\n> quote");
  expect(plainMarkdown("ends in a backslash\\\\")).toBe("ends in a backslash\\");
});

test("a stray backtick stops at its paragraph", () => {
  expect(plainMarkdown("it\\`s a\\_b\n\nnext c\\_d")).toBe("it`s a_b\n\nnext c_d");
  expect(plainMarkdown("open ` never closed a\\_b\n\nnext c\\_d")).toBe("open ` never closed a\\_b\n\nnext c_d");
});
