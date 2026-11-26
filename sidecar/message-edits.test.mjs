import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEdit, editableMessage, editedMessage, editSnapshot, messageKey, readEdits } from "./message-edits.mjs";

const answer = (text, timestamp = 2) => ({ role: "assistant", content: [{ type: "text", text }], timestamp, stopReason: "stop" });
const user = (content, timestamp = 1) => ({ role: "user", content, timestamp });

test("edits replay append-only with original and every timestamp, without touching engine history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-edits-"));
  const file = path.join(dir, "session.jsonl");
  const original = answer("original\u2028text");
  fs.writeFileSync(file, JSON.stringify(original));
  for (let i = 0; i < 8; i++) appendEdit(file, original, `version ${i}`, 10 + i, 5, 4);
  const edits = readEdits(file);
  const updated = editedMessage(original, edits);
  assert.equal(updated.editKey, messageKey(original));
  assert.equal(updated.versions.length, 9);
  assert.deepEqual(updated.versions[0], { content: "original\u2028text", at: 2 });
  assert.equal(updated.content[0].text, "version 7");
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(original));
  assert.deepEqual(editedMessage(original, readEdits(file)), updated);
  assert.deepEqual(editedMessage(answer("different", 2), edits).versions, undefined);
});

test("only the last completed answer after a real user is editable, deliveries do not cut it off", () => {
  const a = answer("summary");
  assert.equal(editableMessage([user("hi"), a]), a);
  assert.equal(editableMessage([user("hi"), a, user('<pipi-message from="child" title="Worker" agent="ACP" status="idle">done</pipi-message>', 3)]), a);
  assert.equal(editableMessage([user("hi"), a, user("new question", 3)]), undefined);
  assert.equal(editableMessage([user("hi"), a, user('<pipi-message from="user" title="you" agent="you" status="idle">new question</pipi-message>', 3)]), undefined);
  assert.equal(editableMessage([user("hi"), a, user("new question", 3), { ...answer("draft", 4), stopReason: "pending" }]), undefined);
  assert.equal(editableMessage([user("hi"), a, answer("new answer", 4)]).timestamp, 4);
});

test("silent edit turns replay without confirmation text; substantive replies and later user turns survive", () => {
  const a = answer("old");
  const edits = [{ type: "message_edit", key: messageKey(a), original: "old", originalAt: 2, content: "new", at: 6, turnAt: 5, userAt: 4 }];
  const messages = [user("hi"), a, user('<pipi-message from="child" title="Worker" agent="ACP" status="idle">done</pipi-message>', 4), answer("[edited]", 5), answer("extra", 7), user("next", 8), answer("[edited]", 9)];
  const replay = editSnapshot(messages, edits);
  assert.equal(replay[1].content[0].text, "new");
  assert.equal(replay[3].content[0].text, "");
  assert.equal(replay[3].silentEdit, true);
  assert.equal(replay[4].content[0].text, "extra");
  assert.equal(replay[6].content[0].text, "[edited]");
});

test("merged engine messages retain process text, and a silent tool turn is never the editable answer", () => {
  const original = { ...answer(""), content: [{ type: "text", text: "Checking." }, { type: "toolCall", id: "t", name: "read", arguments: {} }, { type: "text", text: "The answer." }] };
  const edits = [{ key: messageKey(original), original: "The answer.", originalAt: 2, content: "Updated answer.", at: 6 }];
  const updated = editedMessage(original, edits);
  assert.equal(updated.content[0].text, "Checking.");
  assert.equal(updated.content[2].text, "Updated answer.");
  const silent = { ...answer("", 5), content: [{ type: "text", text: "Updating." }, { type: "toolCall", name: "message_edit" }, { type: "text", text: "<no-reply/>" }] };
  assert.equal(editableMessage([user("hi"), original, silent]), original);
});

test("a torn journal tail does not consume the next acknowledged edit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-edits-torn-"));
  const file = path.join(dir, "session.jsonl");
  const original = answer("original");
  appendEdit(file, original, "first", 3);
  fs.appendFileSync(`${file}.pipi-edits.jsonl`, '{"type":"message_');
  appendEdit(file, original, "second", 4);
  assert.equal(readEdits(file).length, 2);
  assert.equal(editedMessage(original, readEdits(file)).versions.length, 3);
});
