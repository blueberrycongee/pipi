// The sidebar's two running marks side by side: Pip for persona-driven work,
// the neutral dot-matrix loader for user-started work.
//
//   nsh test SidebarRunningLook.test.tsx --target macos   # writes .nsh/shots/sidebar-running-*.png
import { expect, open, test } from "nsh/test";
import { decodeLumGrid, pixelDiff } from "./dev/frames";

type Scheme = "dark" | "light";

const daemonSessions = () => {
  const now = Date.now();
  const base = {
    cwd: "/Users/pip/code/pipi",
    agentId: "pi",
    agentName: "Pi",
    driver: "pi",
    runtimeMode: "full-access",
    unread: false,
    loaded: true,
    createdAt: now,
    lastActive: now,
  };
  return JSON.stringify([
    { ...base, id: "s_pip", persona: true, title: "Pip", titleLocked: true, cwd: "/Users/pip/.pipi/persona", status: "idle", depth: 0 },
    {
      ...base,
      id: "s_persona_work",
      title: "Refactor the transcript reducer",
      file: "/sessions/two.jsonl",
      parentId: "s_pip",
      initiator: "s_pip",
      upstreamInitiator: "s_pip",
      status: "working",
      depth: 1,
    },
    {
      ...base,
      id: "s_persona_grandchild",
      title: "Nested persona repair",
      parentId: "s_persona_work",
      initiator: "s_persona_work",
      upstreamInitiator: "s_persona_work",
      status: "working",
      depth: 2,
    },
    {
      ...base,
      id: "s_user_work",
      title: "Look around and tell me what this project is",
      file: "/sessions/one.jsonl",
      initiator: "user",
      upstreamInitiator: "user",
      status: "working",
      depth: 0,
    },
  ]);
};

test("persona and user running marks in the sidebar", async () => {
  for (const colorScheme of ["light", "dark"] as Scheme[]) {
    const app = await open("./Harness.tsx", {
      width: 1180,
      height: 900,
      platform: "macos",
      locale: "en-US",
      colorScheme,
      storage: {
        "harness.scenario": "multi",
        "harness.daemonSessions": daemonSessions(),
      },
    });
    await app.waitFor("text:What are we building?");
    await app.wait(420);
    const first = decodeLumGrid(await app.screenshot(), 2);
    await app.wait(180);
    const second = decodeLumGrid(await app.screenshot(), 2);
    const spinner = app.layout("id:sidebar-workspaces >> id:sidebar-running-spinner")!;
    const changed = pixelDiff(
      first,
      second,
      Math.floor(spinner.x),
      Math.ceil(spinner.x + spinner.width),
      Math.floor(spinner.y),
      Math.ceil(spinner.y + spinner.height),
      12,
    );
    expect(changed).toBeGreaterThan(0);
    await app.screenshot(`.nsh/shots/sidebar-running-${colorScheme}.png`);
  }
}, 60000);
