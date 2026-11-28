#!/usr/bin/env node
// Drives the REAL pipi-daemon + external-agent bridge + dev/fake-devin-acp.mjs
// through a persona (Pip-on-Devin) send, and dumps every record the attached
// client sees — the exact stream the UI's Transcript consumes.
//
//   node dev/repro-persona-send.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDaemon } from "../sidecar/daemon-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-repro-"));
const home = path.join(tmp, "home");

const client = await connectDaemon({ home });
let reqSeq = 0;
const pending = new Map();
const sessions = new Map();
const outLog = [];
const t0 = Date.now();
const t = () => Date.now() - t0;

client.onLine((msg) => {
  if (msg.type === "hello") {
    for (const s of msg.sessions ?? []) sessions.set(s.id, s);
    return;
  }
  if (msg.type === "session" && msg.session && !msg.id) {
    sessions.set(msg.session.id, msg.session);
    outLog.push({ at: t(), kind: "session", session: { id: msg.session.id, status: msg.session.status, file: msg.session.file, title: msg.session.title, editBlocked: msg.session.editBlocked } });
    return;
  }
  if (msg.type === "out") {
    let rec;
    try {
      rec = JSON.parse(msg.line);
    } catch {}
    outLog.push({ at: t(), kind: "out", rec: rec ?? msg.line });
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === "error") reject(new Error(msg.error || "daemon error"));
    else resolve(msg);
  }
});
await new Promise((r) => setTimeout(r, 400));

const call = (type, args = {}) => {
  const id = `r_${++reqSeq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    client.send({ id, type, ...args });
  });
};

// Devin over ACP, the same way the engine test registers it.
await call("config", {
  agents: [
    { id: "devin", name: "Devin", driver: "acp", available: true, enabled: true, customAgent: { id: "devin", name: "Devin", command: process.execPath, args: [path.join(__dirname, "fake-devin-acp.mjs")] }, supportedRuntimeModes: ["full-access"], models: [{ id: "devin/swe-2-1-medium", name: "SWE-2.1 Medium", provider: "devin" }] },
    { id: "pi", name: "Pi", driver: "pi", available: true, enabled: true, binaryPath: "/bin/false" },
  ],
  allowAgentTools: true,
  sendScope: "all",
  linger: true,
});

// A persona session on Devin, with a persona file so `withPersona` has something to say.
const { session: pip } = await call("start_session", { input: { persona: true, agentId: "devin" } });
fs.writeFileSync(path.join(pip.cwd, "PERSONA.md"), "# Mochi\n\nKeep this identity.\n");

// Attach like the UI does, then send the first prompt — daemon wraps it in <pipi-persona>.
const attached = await call("attach", { session: { id: pip.id, cwd: pip.cwd, agentId: "devin", driver: "acp" } });
const sid = attached.session.id;
await new Promise((r) => setTimeout(r, 800));
outLog.push({ at: t(), kind: "mark", text: "── prompt sent ──" });
client.send({ type: "in", sessionId: sid, line: JSON.stringify({ id: "p1", type: "prompt", message: "make a plan in steps" }) });

// Collect until agent_settled (or 20s).
await new Promise((resolve) => {
  const check = setInterval(() => {
    if (outLog.some((e) => e.rec?.type === "agent_settled")) {
      clearInterval(check);
      setTimeout(resolve, 400);
    }
  }, 40);
  setTimeout(() => {
    clearInterval(check);
    resolve();
  }, 20_000);
});

for (const e of outLog) {
  if (e.kind === "mark") console.log(`${String(e.at).padStart(5)}ms  ${e.text}`);
  else if (e.kind === "session") console.log(`${String(e.at).padStart(5)}ms  [session] status=${e.session.status} file=${e.session.file ?? "-"} title=${JSON.stringify(e.session.title)} editBlocked=${e.session.editBlocked}`);
  else {
    const r = e.rec;
    const msg = r?.message ? ` role=${r.message.role}${r.message.stopReason ? ` stop=${r.message.stopReason}` : ""} text=${JSON.stringify((Array.isArray(r.message.content) ? r.message.content.map((b) => b?.text || b?.type).join("") : r.message.content || "").slice(0, 60))}` : "";
    console.log(`${String(e.at).padStart(5)}ms  ${r?.type ?? "?"}${r?.command ? ` cmd=${r.command}` : ""}${msg}`);
  }
}
process.exit(0);
