import { expect, open, test } from "nsh/test";

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
