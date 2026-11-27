// The shared session-file scanner's title reading: pipi's fixed protocol
// shells never become a session's name, however old or clipped the file is.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanSessionFile, titleWords } from "./session-index.mjs";

const writePiSession = (firstText) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-session-index-"));
  const file = path.join(dir, "session.jsonl");
  const rows = [
    { type: "session", id: "s_test", timestamp: "2025-01-01T00:00:00.000Z" },
    {
      type: "message",
      timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: firstText }], timestamp: 1 },
    },
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return file;
};

const scanPi = async (firstText) => {
  const file = writePiSession(firstText);
  const entry = await scanSessionFile(file, fs.statSync(file));
  assert.ok(entry);
  return entry;
};

test("titleWords unwraps a pipi-message envelope and keeps the delegated task", () => {
  const envelope = '<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">\n调查侧边栏标题\n</pipi-message>';
  assert.equal(titleWords(envelope), "调查侧边栏标题");
});

test("a pipi session starting with a delegated envelope indexes the inner task", async () => {
  const entry = await scanPi('<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">\nFix the sidebar title\n</pipi-message>');
  assert.equal(entry.firstMessage, "Fix the sidebar title");
  assert.ok(!entry.firstMessage.includes("<pipi-message"));
});

test("persona, handoff, and editor context prefixes are stripped before the title", async () => {
  const text = [
    '<pipi-persona name="Pip">persona instructions</pipi-persona>',
    '<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">',
    '<conversation_handoff from="pi">notes</conversation_handoff>',
    'User message:',
    'Readable task title',
    '<doc_editor_context path="/tmp/a.md">edit instructions</doc_editor_context>',
    '</pipi-message>',
  ].join("\n");
  const entry = await scanPi(text);
  assert.equal(entry.firstMessage, "Readable task title");
});

test("an envelope already clipped before its closing tag still loses the protocol head", async () => {
  const clipped = '<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">\nReadable words survived before the clip…';
  assert.equal(titleWords(clipped), "Readable words survived before the clip…");
  const entry = await scanPi(clipped);
  assert.equal(entry.firstMessage, "Readable words survived before the clip…");
});

test("an external header's clipped firstMessage is cleaned before it is clipped again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-session-index-"));
  const file = path.join(dir, "external.pipi-agent.jsonl");
  const header = {
    type: "pipi_external_session",
    version: 2,
    id: "external",
    agentId: "fake",
    created: 1,
    firstMessage: '<pipi-message from="s_pip" title="Pip" agent="Pi" status="idle">\nLegacy delegated title\n</pipi-message>',
  };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
  const entry = await scanSessionFile(file, fs.statSync(file));
  assert.equal(entry?.firstMessage, "Legacy delegated title");
});

test("an ordinary first message is unchanged", async () => {
  const entry = await scanPi("Please refactor the sidebar");
  assert.equal(entry.firstMessage, "Please refactor the sidebar");
});
