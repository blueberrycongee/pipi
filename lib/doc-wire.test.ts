import { expect, test } from "nsh/test";
import { composeDocMessage, plainMarkdown, splitDocMessage, titleWords } from "./doc-wire";

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

test("inline document editor context instructs direct edits while staying invisible to bubbles and titles", () => {
  const full = composeDocMessage("Write an architecture overview", [{ path: NOTE, text: "" }], {
    path: NOTE,
    editable: true,
    scope: "document",
  });
  expect(full).toContain('<doc_editor_context path="');
  expect(full).toContain(`directly into "${NOTE}"`);
  expect(splitDocMessage(full)).toEqual({
    said: "Write an architecture overview",
    docs: [{ path: NOTE, text: "" }],
  });
  expect(titleWords(full)).toBe("Write an architecture overview");

  const sel = composeDocMessage("Tighten this", [{ path: NOTE, text: "Selected words.", excerpt: true }], {
    path: NOTE,
    editable: true,
    scope: "selection",
  });
  expect(sel).toContain('scope="selection"');
  expect(sel).toContain("only that selected passage in-place");
  expect(splitDocMessage(sel)).toEqual({
    said: "Tighten this",
    docs: [{ path: NOTE, text: "Selected words.", excerpt: true }],
  });

  const ro = composeDocMessage("Summarize", [{ path: NOTE, text: "# Doc" }], {
    path: NOTE,
    editable: false,
  });
  expect(ro).toContain('editable="false"');
  expect(splitDocMessage(ro)).toEqual({
    said: "Summarize",
    docs: [{ path: NOTE, text: "# Doc" }],
  });
});

test("titles unwrap pipi-message envelopes and never expose their protocol head", () => {
  const envelope = '<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">\nFix the sidebar title\n</pipi-message>';
  expect(titleWords(envelope)).toBe("Fix the sidebar title");
  expect(titleWords(`<pipi-persona name="Pip">persona</pipi-persona>\n\n${envelope}`)).toBe("Fix the sidebar title");
});

test("titles strip handoff and editor protocol prefixes inside an envelope", () => {
  const text = [
    '<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">',
    '<conversation_handoff from="pi">notes</conversation_handoff>',
    'User message:',
    'Readable task title',
    '<doc_editor_context path="/tmp/a.md">edit instructions</doc_editor_context>',
    '</pipi-message>',
  ].join("\n");
  expect(titleWords(text)).toBe("Readable task title");
});

test("a clipped pipi-message envelope still loses its protocol head", () => {
  expect(titleWords('<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">\nReadable words survived…')).toBe("Readable words survived…");
});

test("ordinary title words are unchanged", () => {
  expect(titleWords("Please refactor the sidebar")).toBe("Please refactor the sidebar");
});
