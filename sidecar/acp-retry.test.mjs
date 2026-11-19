// Antigravity (and other ACP harnesses) report transient upstream API retries
// inline as standalone `agent_message_chunk` lines (`⚠ API error (attempt N): …`).
// The bridge translates them into Pi's `auto_retry_start` / `auto_retry_end`
// status events so recovered retries never pollute the transcript or split tool
// activity groups, while an unrecovered failure is still reported once.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "external-agent.mjs");
const FAKE_ACP = path.join(__dirname, "..", "dev", "fake-acp.mjs");

function startBridge(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-acp-retry-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = {
    cwd: home,
    agentId: "antigravity",
    driver: "acp",
    runtimeMode: "full-access",
    customAgent: { id: "antigravity", name: "Fake agy", command: process.execPath, args: [FAKE_ACP] },
  };
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(home, "agent"), FAKE_ACP_AGY: "1", FAKE_ACP_LOG: path.join(home, "fake.jsonl") };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  const child = spawn(process.execPath, [BRIDGE, JSON.stringify(config)], { cwd: home, env, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => child.kill());
  const records = [];
  const waits = new Map();
  let watchers = [];
  let buffer = "";
  let seq = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === "response" && waits.has(record.id)) {
        waits.get(record.id)(record);
        waits.delete(record.id);
        continue;
      }
      records.push(record);
      watchers = watchers.filter((w) => !w());
    }
  });
  const send = (command) =>
    new Promise((resolve) => {
      const id = `t${++seq}`;
      waits.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  const waitFor = (pred, label, ms = 8000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`waited ${ms}ms for ${label}: ${JSON.stringify(records.map((r) => r.type))}`)), ms);
      const check = () => {
        if (!pred()) return false;
        clearTimeout(timer);
        resolve();
        return true;
      };
      if (!check()) watchers.push(check);
    });
  const settles = (count, ms = 8000) =>
    waitFor(() => records.filter((r) => r.type === "agent_settled").length >= count, `settle #${count}`, ms);
  return { records, send, waitFor, settles, prompt: (message) => send({ type: "prompt", message }) };
}

test("a transient ACP API error becomes auto_retry_start/end and never enters prose or splits tool calls", async (t) => {
  const bridge = startBridge(t);
  assert.equal((await bridge.prompt("run retry-ok")).success, true);
  await bridge.settles(1);

  const retryStarts = bridge.records.filter((r) => r.type === "auto_retry_start");
  const retryEnds = bridge.records.filter((r) => r.type === "auto_retry_end");
  assert.equal(retryStarts.length, 1);
  assert.equal(retryStarts[0].attempt, 1);
  assert.equal(retryStarts[0].maxAttempts, 0);
  assert.match(retryStarts[0].errorMessage, /streamGenerateContent\?alt=sse.*EOF/);
  assert.equal(retryEnds.length, 1);
  assert.deepEqual({ success: retryEnds[0].success, attempt: retryEnds[0].attempt }, { success: true, attempt: 1 });

  const streamedText = bridge.records
    .filter((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "text_delta")
    .map((r) => r.assistantMessageEvent.delta)
    .join("");
  assert.equal(streamedText, "Recovered after retry.");

  const { data } = await bridge.send({ type: "get_messages" });
  const assistant = data.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.stopReason, "stop");
  assert.equal(assistant.errorMessage, undefined);
  // Both tool calls remain contiguous with no stray warning text block between them.
  assert.deepEqual(
    assistant.content.map((b) => b.type),
    ["thinking", "toolCall", "toolCall", "text"],
  );
  assert.equal(assistant.content[3].text, "Recovered after retry.");
});

test("an ACP retry sequence that ends without recovery surfaces one error once", async (t) => {
  const bridge = startBridge(t);
  assert.equal((await bridge.prompt("run retry-fail")).success, true);
  await bridge.settles(1);

  const retryStarts = bridge.records.filter((r) => r.type === "auto_retry_start");
  const retryEnds = bridge.records.filter((r) => r.type === "auto_retry_end");
  assert.deepEqual(
    retryStarts.map((r) => r.attempt),
    [1, 2],
  );
  assert.equal(retryEnds.length, 1);
  assert.equal(retryEnds[0].success, false);
  assert.equal(retryEnds[0].attempt, 2);

  const end = bridge.records.find((r) => r.type === "message_end" && r.message?.role === "assistant");
  assert.equal(end.message.stopReason, "error");
  assert.match(end.message.errorMessage, /EOF/);
  assert.equal(
    end.message.content.some((b) => b.type === "text"),
    false,
    "failed retry banner never turns into assistant prose",
  );
});

test("aborting during an ACP retry wait leaves no error behind", async (t) => {
  const bridge = startBridge(t);
  void bridge.prompt("run retry-abort");
  await bridge.waitFor(() => bridge.records.some((r) => r.type === "auto_retry_start"), "auto_retry_start");

  assert.equal((await bridge.send({ type: "abort_retry" })).success, true);
  assert.equal((await bridge.send({ type: "abort" })).success, true);
  await bridge.settles(1);

  const retryEnds = bridge.records.filter((r) => r.type === "auto_retry_end");
  assert.equal(retryEnds.length, 1);
  assert.equal(retryEnds[0].success, false);
  const end = bridge.records.find((r) => r.type === "message_end" && r.message?.role === "assistant");
  assert.equal(end.message.stopReason, "aborted");
  assert.equal(end.message.errorMessage, undefined);
});

test("normal prose quoting the warning string mid-sentence is kept intact", async (t) => {
  const bridge = startBridge(t);
  assert.equal((await bridge.prompt("run retry-quote")).success, true);
  await bridge.settles(1);

  assert.equal(bridge.records.some((r) => r.type === "auto_retry_start"), false);
  const { data } = await bridge.send({ type: "get_messages" });
  const assistant = data.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.stopReason, "stop");
  assert.equal(
    assistant.content.find((b) => b.type === "text")?.text,
    "The log showed ⚠ API error (attempt 1): EOF during the outage.",
  );
});
