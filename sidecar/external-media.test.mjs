import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "external-agent.mjs");

function startBridge(t, driver, agentId, binaryPath) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `pipi-ext-media-${driver}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = {
    cwd: home,
    agentId,
    driver,
    runtimeMode: "full-access",
    binaryPath,
  };
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(home, "agent") };
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
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      records.push(rec);
      if (rec.type === "response" && rec.id && waits.has(rec.id)) {
        const resolve = waits.get(rec.id);
        waits.delete(rec.id);
        resolve(rec);
      }
      for (const w of watchers) w();
    }
  });
  const request = (type, args = {}) => {
    const id = `r${++seq}`;
    return new Promise((resolve) => {
      waits.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
    });
  };
  const waitUntil = (pred, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (pred()) {
          watchers = watchers.filter((w) => w !== check);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        watchers = watchers.filter((w) => w !== check);
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      watchers.push(check);
      check();
    });
  return { home, records, request, waitUntil };
}

test("Claude tool_result preserves image blocks alongside text", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-mock-claude-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "mock-claude.mjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "c1", name: "screenshot", input: {} }] } }));
console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "Captured" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] }] } }));
console.log(JSON.stringify({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Done." }] } }));
console.log(JSON.stringify({ type: "result", is_error: false }));
`,
    { mode: 0o755 },
  );
  const bridge = startBridge(t, "claude", "claude", bin);
  await bridge.request("prompt", { message: "take shot" });
  await bridge.waitUntil(() => bridge.records.some((r) => r.type === "agent_settled"));
  const toolEnd = bridge.records.find((r) => r.type === "tool_execution_end");
  assert.ok(toolEnd);
  assert.deepEqual(toolEnd.result.content, [
    { type: "text", text: "Captured" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ]);
});

test("Codex mcp_tool_call preserves structuredContent and media blocks", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-mock-codex-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "mock-codex.mjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    id: "m1",
    type: "mcp_tool_call",
    tool: "present_files",
    arguments: { files: [{ path: "demo.mp4" }] },
    result: {
      content: [{ type: "text", text: "{}" }],
      structuredContent: { pipiMedia: true, items: [{ path: "/tmp/demo.mp4", kind: "video", exists: true }] }
    }
  }
}));
console.log(JSON.stringify({ type: "item.completed", item: { id: "a1", type: "agent_message", text: "Ready" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    { mode: 0o755 },
  );
  const bridge = startBridge(t, "codex", "codex", bin);
  await bridge.request("prompt", { message: "render" });
  await bridge.waitUntil(() => bridge.records.some((r) => r.type === "agent_settled"));
  const toolEnd = bridge.records.find((r) => r.type === "tool_execution_end");
  assert.ok(toolEnd);
  assert.equal(toolEnd.result.details?.pipiMedia, true);
  assert.equal(toolEnd.result.details?.items?.[0]?.kind, "video");
});

test("ACP forwards image/resource blocks from tool_call_update and agent_message_chunk", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-mock-acp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "mock-acp.mjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-1" } }));
  } else if (msg.method === "session/prompt") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-1", update: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "present_files", status: "in_progress" } } }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc1",
          status: "completed",
          content: [{ type: "resource_link", uri: "file:///tmp/clip.mp4", name: "clip.mp4", mimeType: "video/mp4" }],
          rawOutput: { structuredContent: { pipiMedia: true, items: [{ path: "/tmp/clip.mp4", kind: "video", exists: true }] } }
        }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "audio", data: "SUQz", mimeType: "audio/mpeg" } } }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
`,
    { mode: 0o755 },
  );
  const bridge = startBridge(t, "acp", "dsh", bin);
  await bridge.request("prompt", { message: "show me" });
  await bridge.waitUntil(() => bridge.records.some((r) => r.type === "agent_settled"));
  const toolEnd = bridge.records.find((r) => r.type === "tool_execution_end");
  assert.equal(toolEnd.result.details?.pipiMedia, true);
  assert.equal(toolEnd.result.content.some((b) => b.type === "resource" && b.uri === "file:///tmp/clip.mp4"), true);
  const assistantEnd = bridge.records.find((r) => r.type === "message_end" && r.message?.role === "assistant");
  assert.ok(assistantEnd.message.content.some((b) => b.type === "audio" && b.mimeType === "audio/mpeg"));
});
