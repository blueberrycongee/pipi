// Injected Pi Orchestration & Permission Extension (`sidecar/pipi-orchestrator-extension.mjs`):
//
// Modeled directly on t3code's `packages/provider-pi/src/server/mcpExtensionSource.ts`.
// Passed to Pi via `--extension sidecar/pipi-orchestrator-extension.mjs`:
// 1. Enforces pipi's shared RuntimeMode (`approval-required` / `auto-accept-edits` / `full-access`)
//    using Pi's public blocking `tool_call` hook -> `ctx.ui.confirm(...)` (which renders natively
//    in pipi's `ExtensionDialog.tsx`!).
// 2. Registers first-class multi-agent orchestration tools (`orchestrator_capabilities`,
//    `delegate_task`, `task_status`, `task_cancel`) connected to pipi's local orchestrator daemon.
// 3. Injects concise multi-agent orchestration guidance into `before_agent_start`.
// Tool parameter schemas are plain JSON Schema objects (what TypeBox produces),
// so this extension needs no imports of its own and runs inside any `pi` install.
const jsonSchema = (schema) => schema;

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "orchestrator_capabilities", "task_status"]);
const FILE_CHANGE_TOOLS = new Set(["edit", "write"]);

let currentRuntimeMode = process.env.PIPI_RUNTIME_MODE || "full-access";
const isSubagent = process.env.PIPI_IS_SUBAGENT === "1";
const endpoint = process.env.PIPI_ORCHESTRATOR_URL || "";
const bearerToken = process.env.PIPI_ORCHESTRATOR_TOKEN || "";

const ORCHESTRATION_INSTRUCTIONS = `## Multi-agent orchestration in pipi

Ordinary coding tasks in this repository need no delegation—do them directly.

- When the user asks to delegate, run another coding agent (e.g. Claude Code, Codex, OpenCode, Cursor, or another Pi model), run tasks in parallel, or review/implement in an isolated checkout:
  1. Call \`orchestrator_capabilities\` once first to inspect available agent harnesses, their models, and readiness.
  2. Call \`delegate_task\` with a self-contained \`task\` brief, \`agentId\`, optional \`model\`, \`role\` (\`researcher\`, \`planner\`, \`implementer\`, \`reviewer\`), and \`isolation: "worktree"\` when mutating files in parallel.
  3. For parallel sub-agents, pass \`mode: "async"\` to launch each \`delegate_task\`, then call \`task_status\` with \`wait: true\` on each \`taskId\` (do not poll in a loop or sleep).
  4. Use \`task_cancel\` to stop any running delegated task that is no longer needed.
- If an external agent or model the user named is unavailable, say so clearly rather than silently substituting another.`;

function toolInputSummary(input) {
  try {
    return JSON.stringify(input, null, 2).slice(0, 3000);
  } catch {
    return String(input).slice(0, 3000);
  }
}

async function callOrchestrator(method, params, signal) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal,
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || `Orchestrator ${method} failed`);
  return body.result;
}

export default async function pipiOrchestratorExtension(pi) {
  // Allow live runtime-mode switching without restarting Pi!
  pi.registerCommand("pipi-runtime-mode", {
    description: "Set pipi runtime permission mode (approval-required, auto-accept-edits, full-access)",
    handler: async (args) => {
      const next = String(args || "").trim();
      if (next === "approval-required" || next === "auto-accept-edits" || next === "full-access") {
        currentRuntimeMode = next;
      }
    },
  });

  // Enforce Supervised / Auto-accept-edits permission gates via Pi's blocking tool_call hook
  pi.on("tool_call", async (event, ctx) => {
    if (currentRuntimeMode === "full-access") return;
    if (READ_ONLY_TOOLS.has(event.toolName)) return;
    if (currentRuntimeMode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) return;
    const approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, toolInputSummary(event.input), { signal: ctx.signal });
    if (!approved) {
      return { block: true, reason: `${event.toolName} was declined by the user in pipi.` };
    }
  });

  // Sub-agents do their own focused job and do not recursively spawn more sub-agents unless configured
  if (isSubagent || !endpoint || !bearerToken) return;

  pi.registerTool({
    name: "orchestrator_capabilities",
    label: "orchestrator_capabilities",
    description:
      "List all coding agent harnesses available to pipi (Pi, Claude Code, Codex, OpenCode, Cursor, custom ACP), their models, and supported permission modes.",
    parameters: jsonSchema({ type: "object", properties: {} }),
    async execute(_toolCallId, params, signal) {
      const result = await callOrchestrator("tools/call", { name: "orchestrator_capabilities", arguments: params || {} }, signal);
      return {
        content: result.content || [{ type: "text", text: JSON.stringify(result) }],
        details: result.structuredContent,
      };
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "delegate_task",
    description:
      "Delegate a task to another coding agent harness/model (e.g. Claude Code, Codex, Pi, OpenCode) with clean context and optional Git worktree isolation.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        title: { type: "string", description: "Short 3-6 word title for the sub-agent task." },
        task: { type: "string", description: "Complete task prompt with context and acceptance criteria." },
        agentId: { type: "string", description: "Target agent id from orchestrator_capabilities (pi, claude, codex, opencode, cursor, or custom id)." },
        model: { type: "string", description: "Optional model id offered by the target agent." },
        role: { type: "string", enum: ["general", "researcher", "planner", "implementer", "reviewer"] },
        isolation: { type: "string", enum: ["shared", "worktree"] },
        runtimeMode: { type: "string", enum: ["inherit", "approval-required", "auto-accept-edits", "full-access"] },
        mode: { type: "string", enum: ["sync", "async"] },
      },
      required: ["task", "agentId"],
    }),
    async execute(_toolCallId, params, signal) {
      const result = await callOrchestrator("tools/call", { name: "delegate_task", arguments: params || {} }, signal);
      return {
        content: result.content || [{ type: "text", text: JSON.stringify(result) }],
        details: result.structuredContent,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "task_status",
    label: "task_status",
    description: "Read or await (`wait: true`) a background delegated sub-agent task.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        taskId: { type: "string" },
        wait: { type: "boolean" },
      },
      required: ["taskId"],
    }),
    async execute(_toolCallId, params, signal) {
      const result = await callOrchestrator("tools/call", { name: "task_status", arguments: params || {} }, signal);
      return {
        content: result.content || [{ type: "text", text: JSON.stringify(result) }],
        details: result.structuredContent,
      };
    },
  });

  pi.registerTool({
    name: "task_cancel",
    label: "task_cancel",
    description: "Cancel a running delegated sub-agent task.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    }),
    async execute(_toolCallId, params, signal) {
      const result = await callOrchestrator("tools/call", { name: "task_cancel", arguments: params || {} }, signal);
      return {
        content: result.content || [{ type: "text", text: JSON.stringify(result) }],
        details: result.structuredContent,
      };
    },
  });

  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions?.sections;
    if (sections && typeof sections === "object" && event.systemPromptOptions?.forceSystemPrompt === undefined) {
      sections.pipi_orchestration = ORCHESTRATION_INSTRUCTIONS;
      return undefined;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATION_INSTRUCTIONS}` };
  });
}
