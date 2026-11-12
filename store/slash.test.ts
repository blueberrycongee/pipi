// What a slash command puts on the wire, across engines: the store on the
// scripted backend (`dev/fake-pi.ts`), no UI.
//
//   nsh test store/slash.test.ts
import { expect, test } from "nsh/test";

const until = async (condition: () => boolean, what: string) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("an engine's command reaches it as written, a shell-owned name never does, and a handoff waits its turn", async () => {
  const { fakeBackend, sampleHistory } = await import("../dev/fake-pi");
  const { useBackend } = await import("./backend");
  const store = await import("./app");

  const backend = fakeBackend({ history: sampleHistory() });
  useBackend(backend);
  const prompts = () => backend.sent.filter((command) => command.type === "prompt").map((command) => String(command.message));
  const names = () => store.slashCommands().map((command) => command.name);

  await store.boot();
  await until(() => store.sidecarPhase().name === "ready" && store.transcriptRows().length > 0, "Pi and its history");
  await until(() => names().includes("fix-tests"), "Pi's commands");
  // pipi's own Pi extension registers a command for itself: not the user's.
  expect(names()).not.toContain("pipi-runtime-mode");
  expect(names()).toContain("compact");

  // Mid-conversation, onto another engine: the conversation so far is handed over with the next message.
  await until(() => store.availableAgents().some((agent) => agent.id === "claude" && agent.available), "the agents probe");
  await store.switchAgentHarness("claude");
  await until(() => names().includes("security-review"), "the engine's commands");
  // Pi's commands left with Pi; what only Pi's RPC does is not offered here.
  expect(names()).not.toContain("fix-tests");
  expect(names()).not.toContain("compact");
  // The engine reports `clear`, `model` and `rename` too: those are the shell's.
  expect(names()).not.toContain("clear");
  expect(names()).not.toContain("rename");
  expect(names().filter((name) => name === "model").length).toBe(1);
  expect(store.slashCommands().find((command) => command.name === "model")?.source).toBe("app");

  // The engine's own command is sent as written: behind a handoff it would not start with its slash.
  store.setDraft("/security-review src");
  await store.send();
  expect(prompts().at(-1)).toBe("/security-review src");
  await until(() => !store.isRunning(), "the command's run");

  // The handoff was kept for the next message, and goes with it.
  store.setDraft("and now explain it");
  await store.send();
  expect(prompts().at(-1)).toContain("User message:\nand now explain it");
  expect(prompts().at(-1)).toContain("Look around and tell me what this project is");
  await until(() => !store.isRunning(), "the message's run");

  // A name the shell owns runs in the shell, under the engine's name for it too: nothing goes to the engine.
  const sent = prompts().length;
  store.setDraft("/rename Audit");
  await store.send();
  await until(() => store.sessionState()?.sessionName === "Audit", "the rename");
  store.setDraft("/clear");
  await store.send();
  await until(() => store.transcriptRows().length === 0, "the new session");
  expect(prompts().length).toBe(sent);
  expect(backend.sent.some((command) => command.type === "new_session")).toBe(true);
});
