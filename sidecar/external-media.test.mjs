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
  return { home, records, request, waitUntil, sendRaw: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`) };
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

test("ACP normalizes Antigravity Run mcp_pipi_present_files and preserves args/rawOutput across updates", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-mock-acp-agy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "mock-acp-agy.mjs");
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
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-agy" } }));
  } else if (msg.method === "session/prompt") {
    // 1. Exact Antigravity shape: "Run mcp_pipi_present_files" with rawInput on tool_call and empty completed update.
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-agy",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc_agy_1",
          title: "Run mcp_pipi_present_files",
          status: "in_progress",
          rawInput: {
            title: "Previews",
            files: [{ path: "/tmp/before.png", title: "Before" }, { path: "/tmp/after.png", title: "After" }]
          }
        }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-agy",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tc_agy_1", status: "completed" }
      }
    }));
    // 2. Generic title on tool_call, late name + rawInput + direct pipiMedia rawOutput on tool_call_update.
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-agy",
        update: { sessionUpdate: "tool_call", toolCallId: "tc_agy_2", title: "Show artifacts", status: "pending" }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-agy",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_agy_2",
          name: "mcp_pipi_present_files",
          status: "completed",
          rawInput: { files: [{ path: "/tmp/late.png" }] },
          rawOutput: { pipiMedia: true, items: [{ path: "/tmp/late.png", kind: "image", exists: true }] }
        }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-agy", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Shown above." } } }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
  }
});
`,
    { mode: 0o755 },
  );
  const bridge = startBridge(t, "acp", "antigravity", bin);
  await bridge.request("prompt", { message: "show previews" });
  await bridge.waitUntil(() => bridge.records.some((r) => r.type === "agent_settled"));

  const ends = bridge.records.filter((r) => r.type === "tool_execution_end");
  assert.equal(ends.length, 2);
  assert.equal(ends[0].toolName, "present_files");
  assert.equal(ends[1].toolName, "present_files");
  assert.equal(ends[1].result.details?.pipiMedia, true);

  const assistantEnd = bridge.records.find((r) => r.type === "message_end" && r.message?.role === "assistant");
  const calls = assistantEnd.message.content.filter((b) => b.type === "toolCall");
  assert.equal(calls[0].name, "present_files");
  assert.equal(calls[0].arguments.files.length, 2);
  assert.equal(calls[1].name, "present_files");
  assert.deepEqual(calls[1].arguments.files, [{ path: "/tmp/late.png" }]);
});

test("external-agent accepts daemon present_media side-channel mid-turn, exposes it in pending(), and persists it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-mock-acp-sc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "mock-acp-hold.mjs");
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
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-hold" } }));
  } else if (msg.method === "session/prompt") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-hold", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working..." } } }
    }));
    setTimeout(() => {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "acp-hold", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " All done." } } }
      }));
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));
    }, 250);
  }
});
`,
    { mode: 0o755 },
  );
  const bridge = startBridge(t, "acp", "antigravity", bin);
  await bridge.request("prompt", { message: "show gallery" });
  await bridge.waitUntil(() =>
    bridge.records.some((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "text_delta"),
  );

  // Daemon pushes side-channel `present_media` while the turn is still streaming.
  bridge.sendRaw({
    type: "present_media",
    payload: {
      pipiMedia: true,
      title: "Direct Gallery",
      items: [{ path: "/tmp/direct.png", kind: "image", width: 320, height: 240, size: 1024, exists: true }],
    },
  });
  await bridge.waitUntil(() =>
    bridge.records.some((r) => r.type === "message_update" && r.assistantMessageEvent?.type === "media_block"),
  );

  // Mid-turn `get_messages` carries the pending `presented_media` block for reattaching clients.
  const mid = await bridge.request("get_messages");
  const pendingMsg = mid.data.messages.find((m) => m.role === "assistant" && m.stopReason === "pending");
  assert.ok(pendingMsg?.content?.some((b) => b.type === "presented_media" && b.title === "Direct Gallery"));

  await bridge.waitUntil(() => bridge.records.some((r) => r.type === "agent_settled"));
  const finalMsgs = await bridge.request("get_messages");
  const doneAssistant = finalMsgs.data.messages.find((m) => m.role === "assistant");
  assert.ok(doneAssistant?.content?.some((b) => b.type === "presented_media" && b.items[0]?.width === 320));
});

function writeAcpPromptImageMock(file, logFile, { capability, modelImages = true, rejectImages = false }) {
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const CAPABILITY = ${JSON.stringify(capability)};
const MODEL_IMAGES = ${JSON.stringify(modelImages)};
const REJECT_IMAGES = ${JSON.stringify(rejectImages)};
const LOG = ${JSON.stringify(logFile)};
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => console.log(JSON.stringify(msg));
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: CAPABILITY }, sessionCapabilities: {} }, agentInfo: { name: "mock-acp", version: "1" } } });
    return;
  }
  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "acp-img",
        models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M1", _meta: { "cognition.ai/supportsImages": MODEL_IMAGES } }] },
      },
    });
    return;
  }
  if (msg.method === "session/prompt") {
    fs.appendFileSync(LOG, JSON.stringify(msg.params.prompt) + "\\n");
    if (REJECT_IMAGES && msg.params.prompt.some((block) => block.type === "image")) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unsupported image input for this model" } });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-img", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
}

async function runAcpImageCase(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-acp-image-cap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "mock-acp.mjs");
  const logFile = path.join(dir, "prompts.jsonl");
  writeAcpPromptImageMock(bin, logFile, options);
  const bridge = startBridge(t, "acp", "dsh", bin);
  const images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
  await bridge.request("prompt", { message: "look", images });
  await bridge.waitUntil(() => bridge.records.some((r) => r.type === "agent_settled"));
  const prompts = fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { bridge, prompts };
}

test("ACP prompt images are forwarded when transport and model both accept images", async (t) => {
  const { prompts } = await runAcpImageCase(t, { capability: true, modelImages: true });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].some((block) => block.type === "image" && block.data === "aGVsbG8="));
});

test("ACP prompt images are withheld when either prompt capability or model metadata is text-only", async (t) => {
  for (const options of [
    { capability: false, modelImages: true },
    { capability: true, modelImages: false },
  ]) {
    const { bridge, prompts } = await runAcpImageCase(t, options);
    assert.equal(prompts.length, 1);
    assert.ok(!prompts[0].some((block) => block.type === "image"));
    assert.equal(prompts[0][0]?.type, "text");
    assert.ok(!bridge.records.some((r) => r.type === "message_end" && r.message?.stopReason === "error"));
  }
});

test("ACP retries a rejected image prompt as text-only instead of failing the turn", async (t) => {
  const { bridge, prompts } = await runAcpImageCase(t, { capability: true, modelImages: true, rejectImages: true });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].some((block) => block.type === "image"));
  assert.ok(!prompts[1].some((block) => block.type === "image"));
  assert.ok(!bridge.records.some((r) => r.type === "message_end" && r.message?.stopReason === "error"));
});
