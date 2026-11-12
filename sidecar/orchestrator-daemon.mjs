// Local multi-agent orchestrator sidecar daemon (`sidecar/orchestrator-daemon.mjs`):
//
//   node sidecar/orchestrator-daemon.mjs
//
// Inspired by t3code's `OrchestratorMcpService` + `McpHttpServer` + `WorktreeMcpService`:
// - Listens on an ephemeral `127.0.0.1` HTTP port secured with a random bearer token,
//   emitting `{ type: "ready", url, token }` on stdout so pipi's QuickJS store can pass
//   `PIPI_ORCHESTRATOR_URL` & `PIPI_ORCHESTRATOR_TOKEN` to coordinator agents (Pi, Claude Code, Codex, ACP).
// - Spawns and supervises delegated child agents across ANY harness (`pi`, `claude`, `codex`,
//   `opencode`, `cursor`, or custom `acp`) with optional Git worktree isolation (`isolation: "worktree"`),
//   role framing (`researcher`, `planner`, `implementer`, `reviewer`), and non-escalating
//   runtime permission mode (`resolveRuntimeMode`).
// - Streams live child task progress & SessionEvents back to pipi's UI over JSONL stdout!
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { childEnv, resolveBinary, spawnBinary } from "./env-paths.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const piExtension = path.join(__dirname, "pipi-orchestrator-extension.mjs");
const externalAgentScript = path.join(__dirname, "external-agent.mjs");
const probeScript = path.join(__dirname, "probe-agents.mjs");
const worktreeScript = path.join(__dirname, "worktree.mjs");

const token = crypto.randomBytes(24).toString("hex");
let currentWorkspace = process.cwd();
let parentRuntimeMode = "full-access";
let agentOverrides = {};
let customAgents = [];
let cachedCapabilities = null;

// taskId -> TaskRecord
const tasks = new Map();

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function runtimeRank(mode) {
  if (mode === "approval-required") return 0;
  if (mode === "auto-accept-edits") return 1;
  return 2;
}

function resolveChildRuntimeMode(parentMode, requested, supported) {
  const inherited = !requested || requested === "inherit";
  const candidate = inherited ? parentMode : requested;
  if (runtimeRank(candidate) > runtimeRank(parentMode)) {
    throw new Error(`Child runtime mode "${candidate}" cannot escalate above parent mode "${parentMode}".`);
  }
  if (!Array.isArray(supported) || supported.length === 0 || supported.includes(candidate)) {
    return candidate;
  }
  if (!inherited) {
    throw new Error(`Target agent does not support runtime mode "${candidate}". Supported: ${supported.join(", ")}.`);
  }
  return (
    supported
      .filter((m) => runtimeRank(m) <= runtimeRank(candidate))
      .sort((a, b) => runtimeRank(b) - runtimeRank(a))[0] || "approval-required"
  );
}

function formatRolePrompt(task, role = "general") {
  const trimmed = String(task || "").trim();
  switch (role) {
    case "researcher":
      return `Act as the researcher sub-agent for this task. Investigate thoroughly using read-only inspection, cite exact files and symbols, and return a concise, structured report.\n\n${trimmed}`;
    case "planner":
      return `Act as the planner sub-agent for this task. Analyze the codebase, identify constraints and edge cases, and return a concrete step-by-step implementation plan without editing files.\n\n${trimmed}`;
    case "implementer":
      return `Act as the implementer sub-agent for this task. Carry out the requested code changes cleanly, run relevant checks/tests, and summarize what changed.\n\n${trimmed}`;
    case "reviewer":
      return `Act as the reviewer sub-agent for this task. Audit the code or diff critically for bugs, regressions, security issues, and style violations. Report concrete findings.\n\n${trimmed}`;
    default:
      return trimmed;
  }
}

async function getCapabilities(force = false) {
  if (cachedCapabilities && !force) return cachedCapabilities;
  const payload = JSON.stringify({ overrides: agentOverrides, customAgents });
  const { stdout } = await execFileAsync(process.execPath, [probeScript, payload], { env: childEnv(), timeout: 15_000 });
  cachedCapabilities = JSON.parse(stdout || "[]");
  return cachedCapabilities;
}

async function createWorktree(cwd, label) {
  const { stdout } = await execFileAsync(process.execPath, [worktreeScript, "create", cwd, label], { env: childEnv(), timeout: 20_000 });
  return JSON.parse(stdout);
}

async function inspectWorktreeDiff(wtPath) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [worktreeScript, "diff", wtPath], { env: childEnv(), timeout: 10_000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function spawnChildAgentRpc(agentSpec, taskCwd, resolvedMode) {
  if (agentSpec.driver === "pi") {
    const piBin = resolveBinary(agentOverrides["pi"]?.binaryPath || "pi");
    if (!piBin) {
      throw new Error(
        "Pi is not installed: `pi` was not found on PATH. Install it with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.",
      );
    }
    const env = childEnv({
      PIPI_RUNTIME_MODE: resolvedMode,
      PIPI_IS_SUBAGENT: "1",
    });
    const args = ["--mode", "rpc", "--no-session"];
    if (fs.existsSync(piExtension)) args.push("--extension", piExtension);
    return spawnBinary(piBin, args, { cwd: taskCwd, env, stdio: ["pipe", "pipe", "pipe"] });
  }
  const customCfg = customAgents.find((c) => c.id === agentSpec.id);
  const cfg = {
    cwd: taskCwd,
    agentId: agentSpec.id,
    driver: agentSpec.driver,
    runtimeMode: resolvedMode,
    binaryPath: agentOverrides[agentSpec.id]?.binaryPath,
    extraArgs: agentOverrides[agentSpec.id]?.extraArgs,
    customAgent: customCfg,
    isSubagent: true,
  };
  return spawnBinary(process.execPath, [externalAgentScript, JSON.stringify(cfg)], {
    cwd: taskCwd,
    env: childEnv({ PIPI_RUNTIME_MODE: resolvedMode, PIPI_IS_SUBAGENT: "1" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function startDelegatedTask(input) {
  const capabilities = await getCapabilities();
  const targetId = input.agentId || "pi";
  const agentSpec = capabilities.find((a) => a.id === targetId) || capabilities.find((a) => a.driver === targetId);
  if (!agentSpec) {
    throw new Error(`Unknown agent harness "${targetId}". Available: ${capabilities.map((a) => a.id).join(", ")}.`);
  }
  if (!agentSpec.available) {
    throw new Error(`Agent "${agentSpec.name}" (${agentSpec.id}) is not installed or unavailable: ${agentSpec.statusText}`);
  }

  const ceiling = input.parentRuntimeMode || parentRuntimeMode;
  const resolvedMode = resolveChildRuntimeMode(ceiling, input.runtimeMode, agentSpec.supportedRuntimeModes);
  const role = input.role || "general";
  const isolation = input.isolation === "worktree" ? "worktree" : "shared";
  const baseCwd = input.cwd || currentWorkspace;

  let worktree = undefined;
  let taskCwd = baseCwd;
  if (isolation === "worktree") {
    worktree = await createWorktree(baseCwd, `${agentSpec.id}-${role}`);
    taskCwd = worktree.path;
  }

  const taskId = `task_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const title = input.title || `${agentSpec.name} · ${role}`;
  const record = {
    id: taskId,
    groupId: input.groupId,
    workflowKind: input.workflowKind || "delegate",
    stepIndex: input.stepIndex,
    title,
    task: String(input.task || ""),
    role,
    agentId: agentSpec.id,
    agentName: agentSpec.name,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    runtimeMode: resolvedMode,
    isolation,
    cwd: taskCwd,
    worktree,
    status: "running",
    activityLabel: "Starting…",
    summary: "",
    error: undefined,
    startedAt: Date.now(),
    completedAt: undefined,
    child: null,
    waiters: [],
  };
  tasks.set(taskId, record);

  const publicTask = () => ({
    id: record.id,
    groupId: record.groupId,
    workflowKind: record.workflowKind,
    stepIndex: record.stepIndex,
    title: record.title,
    task: record.task,
    role: record.role,
    agentId: record.agentId,
    agentName: record.agentName,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    runtimeMode: record.runtimeMode,
    isolation: record.isolation,
    cwd: record.cwd,
    worktree: record.worktree,
    status: record.status,
    activityLabel: record.activityLabel,
    summary: record.summary,
    error: record.error,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  });

  emit({ type: "task_started", task: publicTask() });

  const child = spawnChildAgentRpc(agentSpec, taskCwd, resolvedMode);
  record.child = child;

  let rpcSeq = 1;
  const pendingRpc = new Map();
  let stdoutBuf = "";
  let stderrBuf = "";
  let latestText = "";

  const sendCmd = (type, args = {}) => {
    const id = `sub_${rpcSeq++}`;
    return new Promise((resolve, reject) => {
      pendingRpc.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
    });
  };

  const finishTask = async (status, errorText) => {
    if (record.status !== "running") return;
    record.status = status;
    record.completedAt = Date.now();
    record.activityLabel = status === "completed" ? "Done" : status === "cancelled" ? "Cancelled" : "Failed";
    if (errorText) record.error = errorText;
    if (latestText.trim()) record.summary = latestText.trim();
    if (record.worktree?.path) {
      const diff = await inspectWorktreeDiff(record.worktree.path);
      if (diff) {
        record.worktree = { ...record.worktree, dirty: diff.dirty, diffStat: diff.diffStat };
      }
    }
    emit({ type: "task_updated", task: publicTask() });
    try {
      child.kill();
    } catch {}
    for (const resolve of record.waiters.splice(0)) resolve(publicTask());
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    stderrBuf = (stderrBuf + c).slice(-4000);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl = stdoutBuf.indexOf("\n");
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.trim()) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "response" && ev.id) {
            const w = pendingRpc.get(ev.id);
            if (w) {
              pendingRpc.delete(ev.id);
              if (ev.success) w.resolve(ev.data);
              else w.reject(new Error(ev.error || `${ev.command} failed`));
            }
          } else if (ev.type === "extension_ui_request" && ev.id) {
            // Forward subagent approval prompts to pipi's main ExtensionDialog with subagent title!
            emit({
              type: "subagent_ui_request",
              taskId,
              request: {
                ...ev,
                id: `${taskId}::${ev.id}`,
                title: `[${record.agentName} · ${record.role}] ${ev.title || "Approval needed"}`,
              },
            });
          } else {
            // Forward live session event to pipi UI so subagent's full transcript can be inspected!
            emit({ type: "task_event", taskId, event: ev });
            if (ev.type === "message_update" && ev.assistantMessageEvent) {
              const ame = ev.assistantMessageEvent;
              if (ame.type === "thinking_start" || ame.type === "thinking_delta") record.activityLabel = "Thinking";
              else if (ame.type === "text_delta") {
                record.activityLabel = "Writing";
                latestText += ame.delta || "";
              } else if (ame.type === "toolcall_start") {
                record.activityLabel = `Running ${ame.toolName}`;
              }
              emit({ type: "task_updated", task: publicTask() });
            } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
              const texts = (ev.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
              if (texts.trim()) latestText = texts;
              if (ev.message.stopReason === "error" && ev.message.errorMessage) {
                record.error = ev.message.errorMessage;
              }
            } else if (ev.type === "agent_settled") {
              void finishTask(ev.aborted ? "cancelled" : record.error ? "failed" : "completed", record.error);
            }
          }
        } catch {}
      }
      nl = stdoutBuf.indexOf("\n");
    }
  });

  child.on("close", (code) => {
    if (record.status === "running") {
      void finishTask(code === 0 ? "completed" : "failed", code !== 0 ? stderrBuf.trim() || `Subagent exited with code ${code}` : undefined);
    }
  });

  // Handshake, optional model/thinking config, and dispatch task prompt
  (async () => {
    try {
      const init = await sendCmd("get_state");
      if (!record.model && init?.model?.id && init.model.id !== "unknown") {
        record.model = init.model.name || init.model.id;
      }
      if (input.model) {
        const modelsRes = await sendCmd("get_available_models").catch(() => ({ models: [] }));
        const match = (modelsRes?.models || []).find(
          (m) => m.id === input.model || `${m.provider}/${m.id}` === input.model || m.name === input.model,
        );
        if (match) {
          await sendCmd("set_model", { provider: match.provider, modelId: match.id }).catch(() => undefined);
          record.model = match.name || match.id;
        }
      }
      if (input.thinkingLevel) {
        await sendCmd("set_thinking_level", { level: input.thinkingLevel }).catch(() => undefined);
      }
      emit({ type: "task_updated", task: publicTask() });
      await sendCmd("prompt", { message: formatRolePrompt(input.task, role) });
    } catch (err) {
      await finishTask("failed", err instanceof Error ? err.message : String(err));
    }
  })();

  if (input.mode === "async") {
    return publicTask();
  }
  return await new Promise((resolve) => {
    if (record.status !== "running") return resolve(publicTask());
    record.waiters.push(resolve);
  });
}

function cancelTask(taskId) {
  const record = tasks.get(taskId);
  if (!record) throw new Error(`Task not found: ${taskId}`);
  if (record.status !== "running") {
    return { id: record.id, status: record.status, summary: record.summary };
  }
  record.status = "cancelled";
  record.completedAt = Date.now();
  record.activityLabel = "Cancelled";
  try {
    record.child?.stdin.write(`${JSON.stringify({ id: "abort_1", type: "abort" })}\n`);
    setTimeout(() => {
      try {
        record.child?.kill("SIGTERM");
      } catch {}
    }, 300);
  } catch {}
  const pub = {
    id: record.id,
    title: record.title,
    role: record.role,
    agentId: record.agentId,
    agentName: record.agentName,
    model: record.model,
    runtimeMode: record.runtimeMode,
    isolation: record.isolation,
    cwd: record.cwd,
    worktree: record.worktree,
    status: record.status,
    activityLabel: record.activityLabel,
    summary: record.summary,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
  emit({ type: "task_updated", task: pub });
  for (const resolve of record.waiters.splice(0)) resolve(pub);
  return pub;
}

// ── MCP / JSON-RPC Tool Definitions (exposed to Pi Extension & External MCP) ─

const MCP_TOOLS = [
  {
    name: "orchestrator_capabilities",
    description:
      "List all coding agent harnesses configured on this machine (Pi, Claude Code, Codex, OpenCode, Cursor, custom ACP), their availability, models, and supported permission modes. Call once before delegating.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delegate_task",
    description:
      "Delegate a focused coding, research, planning, or review task to another coding agent harness/model (with clean context and optional isolated Git worktree).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short 3-6 word title for this delegated sub-agent task." },
        task: { type: "string", description: "Self-contained instructions, relevant file paths, and acceptance criteria." },
        agentId: { type: "string", description: "Target agent harness id from orchestrator_capabilities (e.g. 'pi', 'claude', 'codex', 'opencode', 'cursor')." },
        model: { type: "string", description: "Optional model id offered by the target agent." },
        role: { type: "string", enum: ["general", "researcher", "planner", "implementer", "reviewer"], description: "Sub-agent role framing." },
        isolation: { type: "string", enum: ["shared", "worktree"], description: "Use 'worktree' for parallel or mutating work on an isolated Git branch." },
        runtimeMode: { type: "string", enum: ["inherit", "approval-required", "auto-accept-edits", "full-access"] },
        mode: { type: "string", enum: ["sync", "async"], description: "'sync' (default) waits for completion and returns summary; 'async' runs in background." },
      },
      required: ["task", "agentId"],
    },
  },
  {
    name: "task_status",
    description: "Inspect a delegated task's current status, worktree branch/diff, and output summary. Set wait=true to await completion.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        wait: { type: "boolean", description: "Wait until the task settles before returning." },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_cancel",
    description: "Stop a running delegated sub-agent task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
];

async function executeMcpTool(name, args = {}) {
  if (name === "orchestrator_capabilities") {
    const caps = await getCapabilities();
    const summary = caps.map((c) => ({
      agentId: c.id,
      name: c.name,
      available: c.available,
      status: c.statusText,
      models: (c.models || []).map((m) => m.id),
      supportedRuntimeModes: c.supportedRuntimeModes,
      supportsWorktree: c.supportsWorktree,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ parentRuntimeMode, agents: summary }, null, 2) }],
      structuredContent: { parentRuntimeMode, agents: summary },
    };
  }
  if (name === "delegate_task") {
    const res = await startDelegatedTask(args);
    const lines = [
      `Task ID: ${res.id}`,
      `Agent: ${res.agentName} (${res.agentId})${res.model ? ` · ${res.model}` : ""}`,
      `Role: ${res.role} · Status: ${res.status}`,
      ...(res.worktree ? [`Worktree: ${res.worktree.path} (branch ${res.worktree.branch})`, ...(res.worktree.diffStat ? [`Changes:\n${res.worktree.diffStat}`] : [])] : []),
      ...(res.error ? [`Error: ${res.error}`] : []),
      ...(res.summary ? [`\n--- Sub-agent Output ---\n${res.summary}`] : res.status === "running" ? ["\nTask is running in background. Use task_status({ taskId, wait: true }) when ready."] : []),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: res,
      ...(res.status === "failed" ? { isError: true } : {}),
    };
  }
  if (name === "task_status") {
    const rec = tasks.get(args.taskId);
    if (!rec) throw new Error(`Task not found: ${args.taskId}`);
    if (args.wait && rec.status === "running") {
      await new Promise((resolve) => rec.waiters.push(resolve));
    }
    const payload = {
      id: rec.id,
      title: rec.title,
      agentId: rec.agentId,
      status: rec.status,
      activity: rec.activityLabel,
      worktree: rec.worktree,
      summary: rec.summary,
      error: rec.error,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }
  if (name === "task_cancel") {
    const cancelled = cancelTask(args.taskId);
    return {
      content: [{ type: "text", text: `Cancelled ${cancelled.id} (${cancelled.status}).` }],
      structuredContent: cancelled,
    };
  }
  throw new Error(`Unknown orchestrator tool: ${name}`);
}

// ── Localhost HTTP MCP Server (127.0.0.1 only, Bearer auth) ─────────────────

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  let reqCwd = "";
  try {
    reqCwd = new URL(req.url || "/mcp", "http://127.0.0.1").searchParams.get("cwd") || "";
  } catch {}
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) body += chunk;
  let rpc;
  try {
    rpc = JSON.parse(body || "{}");
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }
  if (rpc.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  try {
    let result;
    if (rpc.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pipi-orchestrator", version: "0.1.0" },
      };
    } else if (rpc.method === "tools/list") {
      result = { tools: MCP_TOOLS };
    } else if (rpc.method === "tools/call") {
      const toolArgs = { ...(rpc.params?.arguments || {}) };
      if (reqCwd && !toolArgs.cwd) toolArgs.cwd = reqCwd;
      result = await executeMcpTool(rpc.params?.name, toolArgs);
    } else {
      throw new Error(`Unsupported method: ${rpc.method}`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  } catch (err) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      }),
    );
  }
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  emit({ type: "ready", url, token });
});

// ── Control Channel from QuickJS Store on stdin ─────────────────────────────

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let nl = stdinBuf.indexOf("\n");
  while (nl !== -1) {
    const line = stdinBuf.slice(0, nl).replace(/\r$/, "");
    stdinBuf = stdinBuf.slice(nl + 1);
    if (line.trim()) {
      try {
        const cmd = JSON.parse(line);
        if (cmd.type === "configure") {
          if (cmd.cwd) currentWorkspace = cmd.cwd;
          if (cmd.runtimeMode) parentRuntimeMode = cmd.runtimeMode;
          if (cmd.overrides) agentOverrides = cmd.overrides;
          if (cmd.customAgents) customAgents = cmd.customAgents;
          cachedCapabilities = null;
        } else if (cmd.type === "delegate") {
          Promise.resolve(startDelegatedTask(cmd.input || {}))
            .then((data) => emit({ id: cmd.id, type: "response", success: true, data }))
            .catch((err) => emit({ id: cmd.id, type: "response", success: false, error: err instanceof Error ? err.message : String(err) }));
        } else if (cmd.type === "cancel") {
          try {
            const data = cancelTask(cmd.taskId);
            emit({ id: cmd.id, type: "response", success: true, data });
          } catch (err) {
            emit({ id: cmd.id, type: "response", success: false, error: err instanceof Error ? err.message : String(err) });
          }
        } else if (cmd.type === "subagent_ui_response" && typeof cmd.compositeId === "string") {
          const [taskId, innerId] = cmd.compositeId.split("::");
          const rec = tasks.get(taskId);
          if (rec?.child) {
            rec.child.stdin.write(`${JSON.stringify({ ...cmd.answer, id: innerId, type: "extension_ui_response" })}\n`);
          }
        }
      } catch {}
    }
    nl = stdinBuf.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  for (const rec of tasks.values()) {
    try {
      rec.child?.kill();
    } catch {}
  }
  server.close();
  process.exit(0);
});
