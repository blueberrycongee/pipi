import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import { decodeLumGrid, pixelDiff } from "./dev/frames";

for (const colorScheme of ["light", "dark"] as const) {
  test(`Pip quiet working states ${colorScheme}`, async () => {
    const now = Date.now();
    const app = await open("./Harness.tsx", {
      width: 1180,
      height: 780,
      platform: "macos",
      locale: "en-US",
      colorScheme,
      clock: {},
      storage: {
        "harness.scenario": "stream",
        "harness.daemonSessions": JSON.stringify([
          {
            id: "s_pip_1", title: "Pip", titleLocked: true, persona: true,
            cwd: "/Users/pip/.pipi/persona", agentId: "pi", agentName: "Pi", driver: "pi",
            runtimeMode: "full-access", status: "idle", unread: false, loaded: true,
            depth: 0, createdAt: now - 60_000, lastActive: now - 5000,
          },
          ...[1, 2, 3].map((n) => ({
            id: `s_child_${n}`, title: `Review module ${n}`, titleLocked: true, parentId: "s_pip_1",
            cwd: "/Users/pip/code/pipi", agentId: "claude", agentName: "Claude Code", driver: "claude",
            runtimeMode: "full-access", status: "working", unread: false, loaded: true,
            depth: 1, createdAt: now - 30_000, lastActive: now - 1000,
          })),
        ]),
      },
    });
    await app.waitFor("id:sidebar-pip");
    await app.press("id:sidebar-pip");
    await app.waitFor("text:Hey, what's up?");
    await app.type("label:Message", "make a plan in steps");
    await app.submit("label:Message");
    await app.waitFor("id:pip-typing-bubble");
    await app.wait(200);
    await app.screenshot(`.nsh/shots/pip-working-${colorScheme}.png`);
    await app.waitFor("id:pip-waiting-label", { timeout: 60_000 });
    expect(app.shows("id:pip-typing-bubble")).toBe(false);
    await app.wait(200);
    await app.screenshot(`.nsh/shots/pip-waiting-${colorScheme}.png`);
    await app.hover("id:pip-working-label");
    await app.waitFor("id:pip-status-card");
    await app.wait(200);
    await app.screenshot(`.nsh/shots/pip-status-${colorScheme}.png`);
    expect(app.count("id:pip-status-child-s_child_1")).toBe(1);
  });
}

async function typingBubbleDiff(app: App): Promise<number> {
  await app.waitFor("id:pip-typing-bubble", { timeout: 20_000 });
  const box = app.layout("id:pip-typing-bubble")!;
  const first = decodeLumGrid(await app.screenshot(), 2);
  await app.wait(140);
  const second = decodeLumGrid(await app.screenshot(), 2);
  expect(app.layout("id:pip-typing-bubble")).toEqual(box);
  const x0 = Math.max(0, Math.floor(box.x) - 4);
  const x1 = Math.min(first.width, Math.ceil(box.x + box.width) + 4);
  const y0 = Math.max(0, Math.floor(box.y) - 4);
  const y1 = Math.min(first.height, Math.ceil(box.y + box.height) + 4);
  return pixelDiff(first, second, x0, x1, y0, y1, 4);
}

test("Pip typing dots animate inside a fixed bubble, and Reduced Motion holds them still", async () => {
  const reply = `A quiet answer. ${"The reply keeps writing so the typing indicator stays visible. ".repeat(8)}`;
  const launch = (reducedMotion: boolean) =>
    open("./Harness.tsx", {
      width: 1180,
      height: 780,
      platform: "macos",
      locale: "en-US",
      colorScheme: "light",
      clock: {},
      reducedMotion,
      storage: { "harness.scenario": "stream", "harness.reply": reply },
    });
  const send = async (app: App) => {
    await app.waitFor("id:sidebar-pip");
    await app.press("id:sidebar-pip");
    await app.waitFor("text:Hey, what's up?");
    await app.type("label:Message", "hello Pip");
    await app.submit("label:Message");
  };

  const live = await launch(false);
  await send(live);
  expect(await typingBubbleDiff(live)).toBeGreaterThan(0);

  const reduced = await launch(true);
  await send(reduced);
  expect(await typingBubbleDiff(reduced)).toBe(0);
}, 60000);
