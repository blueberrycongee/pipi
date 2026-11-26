#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";
let spec;
const send = (record) => console.log(JSON.stringify(record));
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const text = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "edit-test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } } });
function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const pair of spec.env || []) env[pair.name] = pair.value;
    const child = spawn(spec.command, spec.args || [], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", reject);
    const lines = readline.createInterface({ input: child.stdout });
    lines.once("line", (line) => { child.kill(); resolve(JSON.parse(line)); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1 });
  else if (msg.method === "session/new") {
    spec = msg.params.mcpServers.find((server) => server.name === "pipi");
    reply(msg.id, { sessionId: "edit-test" });
  } else if (msg.method === "session/prompt") {
    const prompt = JSON.stringify(msg.params.prompt);
    const destination = /deliver-to:(s_[a-z0-9]+)/.exec(prompt)?.[1];
    if (destination) {
      await callTool("session_send", { session: destination, message: "edit-summary with-extra" });
      text("Report sent.");
    } else if (prompt.includes("edit-summary")) {
      let result;
      for (let i = 1; i <= 7; i++) {
        result = await callTool("message_edit", { content: `Consolidated progress ${i}.\n\nAll details together.` });
        if (result.result?.isError || result.error) break;
      }
      text(result.result?.isError || result.error ? "Edit rejected; new reply." : prompt.includes("with-extra") ? "Please review this decision." : "<no-reply/>");
    } else text("Initial summary.");
    reply(msg.id, { stopReason: "end_turn" });
  }
});
