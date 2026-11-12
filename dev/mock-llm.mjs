// A stand-in model provider for developing pipi without credentials:
//
//   node dev/mock-llm.mjs            # serves http://127.0.0.1:8787/v1
//   PI_CODING_AGENT_DIR=$PWD/dev/agent nsh dev .
//
// It speaks the OpenAI Chat Completions streaming API, which dev/agent's
// models.json points Pi at. Replies are scripted from the last user message,
// so every part of the client can be exercised with the real Pi sidecar:
// thinking, streamed Markdown, tool calls that Pi really executes, errors.
//
//   "…tools…"   thinks, runs `ls` and reads package.json, then answers
//   "…error…"   fails with HTTP 500 (Pi retries, then reports the failure)
//   "…slow…"    streams slowly, to try steering, follow-ups and Stop
//   else        thinks briefly and answers in Markdown
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ANSWER = `Here's what I found in this workspace.

## Summary

The project is a **native desktop control surface** for coding agents. Three things stand out:

1. The UI is TSX on \`nsh\`, with no web view.
2. The agent runs as a *sidecar* over JSONL.
3. Sessions are plain files you can inspect.

\`\`\`ts
const client = new PiClient(transport, handlers);
const state = await client.request("get_state");
console.log(state.model?.name);
\`\`\`

| Layer | Owns |
|---|---|
| \`pi/\` | protocol, transport, transcript |
| \`store/\` | signals and actions |
| \`views/\` | the screens |

> [!TIP]
> Ask me to run the tests next.
`;

const LONG_ANSWER = Array.from(
  { length: 20 },
  (_, i) => `### Part ${i + 1} of the plan\n\nSection ${i + 1} explains a step of the work in a few lines, so the reply grows well past the viewport while it streams.`,
).join("\n\n");

const words = (text) => text.match(/\s*\S+\s*/g) ?? [];

async function reply(res, body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1) ?? {};
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((c) => c.text ?? "").join(" ");
  const pace = /slow/i.test(prompt) ? 140 : 28;

  if (/error/i.test(prompt) && last.role === "user") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mock provider: simulated failure", type: "server_error" } }));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `chatcmpl-${Date.now()}`;
  const send = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const done = (finish, usage) => {
    send({}, finish);
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  const usage = { prompt_tokens: 1200 + messages.length * 310, completion_tokens: 180, total_tokens: 1380 + messages.length * 310 };
  const stream = async (key, text) => {
    for (const word of words(text)) {
      if (res.destroyed) return;
      send({ [key]: word });
      await sleep(pace);
    }
  };

  send({ role: "assistant", content: "" });
  const wantsTools = /tool/i.test(prompt) && (body.tools?.length ?? 0) > 0;
  if (wantsTools && last.role === "user") {
    await stream("reasoning_content", "The user wants a look around. I'll list the directory first, then read the manifest to see what this project depends on.");
    await stream("content", "Let me take a look around.");
    const calls = [
      { name: "bash", args: { command: "ls -la | head -20" } },
      { name: "read", args: { path: "package.json" } },
    ];
    for (const [index, call] of calls.entries()) {
      send({ tool_calls: [{ index, id: `call_${Date.now()}_${index}`, type: "function", function: { name: call.name, arguments: "" } }] });
      const json = JSON.stringify(call.args);
      for (let i = 0; i < json.length; i += 12) {
        send({ tool_calls: [{ index, function: { arguments: json.slice(i, i + 12) } }] });
        await sleep(pace);
      }
    }
    return done("tool_calls", usage);
  }
  if (last.role !== "tool") await stream("reasoning_content", "A short question. I can answer directly, with a small code sample and a table to keep it scannable.");
  await stream(
    "content",
    /^(hi|hello|hey)\b/i.test(prompt.trim())
      ? "Hi! I'm a mock model standing in for a real provider. Ask me about **tools** to see Pi run some."
      : /long/i.test(prompt)
        ? LONG_ANSWER
        : ANSWER,
  );
  done("stop", usage);
}

createServer((req, res) => {
  if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => reply(res, JSON.parse(raw)).catch((error) => (console.error(error), res.end())));
    return;
  }
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-large", object: "model" }, { id: "mock-small", object: "model" }] }));
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => console.log(`mock provider on http://127.0.0.1:${PORT}/v1`));
