// Stdio-to-HTTP MCP proxy (`sidecar/pipi-mcp-stdio.mjs`):
//
// Injected into external coordinator agents (`Claude Code`, `Codex`, `ACP`) so they
// receive the exact same `orchestrator_capabilities`, `delegate_task`, `task_status`,
// and `task_cancel` MCP tools as Pi!
const endpoint = process.env.PIPI_ORCHESTRATOR_URL || "";
const token = process.env.PIPI_ORCHESTRATOR_TOKEN || "";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (line.trim()) {
      void forward(line);
    }
    nl = buf.indexOf("\n");
  }
});

async function forward(rawLine) {
  let msg;
  try {
    msg = JSON.parse(rawLine);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(msg),
    });
    const text = await res.text();
    if (text.trim()) {
      process.stdout.write(`${text.trim()}\n`);
    }
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      })}\n`,
    );
  }
}
