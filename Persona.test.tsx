import { expect, open, test } from "nsh/test";
import wallpaperPicture from "./assets/brand/dmg-background@2x.png";

// Multiple personal agents: sidebar creation, persona boundaries, the centered
// chat identity, rename propagation, custom avatar surfaces, and per-persona
// engine memory.
//
//   nsh test Persona.test.tsx

const launch = (storage: Record<string, string> = {}) =>
  open("./Harness.tsx", {
    width: 1180,
    height: 920,
    platform: "macos",
    locale: "en-US",
    clock: {},
    storage: { "harness.scenario": "multi", ...storage },
  });

const weight = (app: any, selector: string) => (app.count(selector) ? app.spanStyle(selector).fontWeight : 0);

test("creating personal agents keeps each in the top persona area and their work in projects", async () => {
  const now = Date.now();
  const app = await launch({
    "harness.daemonSessions": JSON.stringify([
      {
        id: "s_pip",
        title: "Pip",
        titleLocked: true,
        persona: true,
        personaId: "default",
        cwd: "/Users/pip/.pipi/persona",
        agentId: "pi",
        agentName: "Pi",
        driver: "pi",
        runtimeMode: "full-access",
        status: "idle",
        unread: false,
        loaded: true,
        depth: 0,
        createdAt: now - 80_000,
        lastActive: now - 10_000,
      },
      {
        id: "s_researcher",
        title: "Researcher",
        titleLocked: true,
        persona: true,
        personaId: "researcher",
        cwd: "/Users/pip/.pipi/personas/researcher",
        agentId: "pi",
        agentName: "Pi",
        driver: "pi",
        runtimeMode: "full-access",
        status: "idle",
        unread: false,
        loaded: true,
        depth: 0,
        createdAt: now - 70_000,
        lastActive: now - 9_000,
      },
      {
        id: "s_persona_work",
        title: "Survey parser options",
        titleLocked: true,
        parentId: "s_researcher",
        cwd: "/Users/pip/code/pipi",
        agentId: "pi",
        agentName: "Pi",
        driver: "pi",
        runtimeMode: "full-access",
        status: "idle",
        unread: false,
        loaded: true,
        depth: 1,
        createdAt: now - 20_000,
        lastActive: now - 1_000,
      },
    ]),
  });
  await app.waitFor("text:What are we building?");

  // Existing personas are all pinned at the top; their folders never become projects.
  expect(app.count("id:sidebar-pip >> text:Pip")).toBe(1);
  expect(app.count("id:sidebar-persona-researcher >> text:Researcher")).toBe(1);
  expect(app.count("id:sidebar-workspaces >> text:persona")).toBe(0);
  expect(app.count("id:sidebar-workspaces >> text:personas")).toBe(0);

  // Work a persona started is a normal project row at the same level as user work.
  expect(app.count("id:sidebar-workspaces >> text:Survey parser options")).toBe(1);

  // The creation affordance opens a compact form; a name and optional role become a new persona.
  await app.press("id:sidebar-persona-add");
  await app.waitFor("id:persona-create-form");
  await app.type("id:persona-name-input", "Nova");
  await app.type("id:persona-description-input", "A careful researcher");
  await app.press("id:persona-create-submit");
  await app.waitUntil(() => app.count("id:persona-create-form") === 0);
  await app.waitFor("id:persona-header");
  expect(app.count("id:sidebar-persona-nova >> text:Nova")).toBe(1);
  expect(app.count("id:sidebar-workspaces >> text:personas")).toBe(0);
  expect(app.count("id:sidebar-workspaces >> text:nova")).toBe(0);

  // Opening another persona keeps the first one intact rather than replacing it.
  await app.press("id:sidebar-persona-researcher");
  await app.waitUntil(() => app.count("id:persona-header >> text:Researcher") > 0);
  expect(app.count("id:sidebar-persona-nova >> text:Nova")).toBe(1);
  expect(app.count("id:sidebar-pip >> text:Pip")).toBe(1);
});

test("the centered persona header renames inline and puts a custom avatar on every persona surface", async () => {
  const app = await launch({ "harness.scenario": "stream", "harness.pickedImage": wallpaperPicture.url });
  await app.waitFor("text:What are we building?");

  await app.press("id:sidebar-persona-add");
  await app.waitFor("id:persona-create-form");
  await app.type("id:persona-name-input", "Nova");
  await app.press("id:persona-create-submit");
  await app.waitUntil(() => app.count("id:persona-create-form") === 0);
  await app.waitFor("id:persona-header");
  await app.waitUntil(() => app.count("id:persona-header >> text:Nova") > 0);

  // Rename inline from the centered identity; sidebar and tab follow the daemon title.
  await app.press("id:persona-name-button");
  await app.waitFor("id:persona-header >> label:Personal agent name");
  await app.clear("id:persona-header >> label:Personal agent name");
  await app.type("id:persona-header >> label:Personal agent name", "Nebula");
  await app.submit("id:persona-header >> label:Personal agent name");
  await app.waitUntil(() => app.count("id:sidebar-persona-nova >> text:Nebula") === 1);
  expect(app.count("id:tab-0 >> text:Nebula")).toBe(1);
  expect(app.count("id:persona-header >> text:Nebula")).toBe(1);
  expect(app.count("id:sidebar-pip >> text:Pip")).toBe(1);

  // Escape cancels a second edit without touching the saved name.
  await app.press("id:persona-name-button");
  await app.waitFor("id:persona-header >> label:Personal agent name");
  await app.clear("id:persona-header >> label:Personal agent name");
  await app.type("id:persona-header >> label:Personal agent name", "Discarded");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.count("id:persona-header >> label:Personal agent name") === 0);
  expect(app.texts()).not.toContain("Discarded");
  expect(app.count("id:persona-header >> text:Nebula")).toBe(1);

  // Clicking anywhere outside the editor commits it like Enter: native AppKit
  // never moves first responder to the plain transcript, so the header listens
  // for the outside press itself. The mouse lands in the plain conversation,
  // away from every badge control.
  await app.press("id:persona-name-button");
  await app.waitFor("id:persona-header >> label:Personal agent name");
  await app.clear("id:persona-header >> label:Personal agent name");
  await app.type("id:persona-header >> label:Personal agent name", "Nova Prime");
  await app.drag("text:Hey, what's up?", { x: 1, y: 0 });
  await app.waitUntil(() => app.count("id:persona-header >> label:Personal agent name") === 0);
  expect(app.count("id:persona-header >> text:Nova Prime")).toBe(1);
  expect(app.count("id:sidebar-persona-nova >> text:Nova Prime")).toBe(1);

  // Choosing an image uses the native picker answer and exposes image-backed avatars
  // in the centered header and the pinned sidebar row (the mascot itself has no such label).
  expect(app.count("label:Personal agent avatar")).toBe(0);
  await app.press("id:persona-avatar-button");
  await app.waitUntil(() => app.count("label:Personal agent avatar") >= 2, { timeout: 5000 });
  expect(app.count("id:persona-header-avatar")).toBe(1);

  // The same image backs the working footer, each delivered message avatar, and
  // the hover status card — never only the centered header.
  await app.type("label:Message", "make a plan in steps");
  await app.submit("label:Message");
  await app.waitFor("id:pip-active-avatar");
  expect(app.count("label:Personal agent avatar")).toBeGreaterThanOrEqual(3);
  await app.waitUntil(() => app.count("id:pip-message-avatar") > 0, { timeout: 20_000 });
  expect(app.count("label:Personal agent avatar")).toBeGreaterThanOrEqual(3);
  await app.hover("id:pip-message-avatar");
  await app.waitFor("id:pip-status-card");
  expect(app.count("id:pip-status-card >> label:Personal agent avatar")).toBe(1);

  // Reset returns every surface to the mascot.
  await app.hover("id:sidebar-pip");
  await app.press("id:persona-actions-button");
  await app.chooseMenuItem("Reset Avatar");
  await app.waitUntil(() => app.count("label:Personal agent avatar") === 0);
});

test("engine choices are remembered independently for each personal agent", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");

  // Create a second persona, then switch only it to Claude Code.
  await app.press("id:sidebar-persona-add");
  await app.waitFor("id:persona-create-form");
  await app.type("id:persona-name-input", "Nova");
  await app.press("id:persona-create-submit");
  await app.waitUntil(() => app.count("id:persona-create-form") === 0);
  await app.waitFor("id:persona-header");
  await app.press("id:agent-chip");
  await app.waitFor("id:agent-picker");
  await app.press("id:agent-picker >> text:Claude Code");
  await app.waitUntil(() => app.texts().includes("Claude Code"));

  // The default Pip still opens on Pi, while Nova returns to Claude Code.
  await app.press("id:sidebar-pip");
  await app.waitUntil(() => app.count("id:persona-header >> text:Pip") > 0);
  expect(app.texts()).toContain("Pi");
  expect(app.texts()).not.toContain("Claude Code");
  await app.press("id:sidebar-persona-nova");
  await app.waitUntil(() => app.count("id:persona-header >> text:Nova") > 0);
  await app.waitUntil(() => app.texts().includes("Claude Code"));
});


test("model and thinking choices drift independently per personal agent", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");

  // Pip chooses GPT-5.1 + High in its own scope.
  await app.press("id:sidebar-pip");
  await app.waitFor("id:persona-header");
  await app.press("text:Claude Sonnet 4.5");
  await app.press("text:GPT-5.1");
  await app.waitUntil(() => app.texts().includes("GPT-5.1"));
  await app.press("text:Medium");
  await app.press("text:High");
  await app.waitUntil(() => app.texts().includes("High"));

  // A new persona begins in its own preference scope, then drifts independently:
  // Nova's DeepSeek pick never rewrites Pip's GPT/High.
  await app.press("id:sidebar-persona-add");
  await app.waitFor("id:persona-create-form");
  await app.type("id:persona-name-input", "Nova");
  await app.press("id:persona-create-submit");
  await app.waitUntil(() => app.count("id:persona-create-form") === 0);
  await app.waitFor("id:persona-header");
  await app.waitUntil(() => app.texts().includes("Claude Sonnet 4.5"));

  await app.press("text:Claude Sonnet 4.5");
  await app.press("text:DeepSeek Chat");
  await app.waitUntil(() => app.texts().includes("DeepSeek Chat"));
  expect(app.texts()).not.toContain("High");

  await app.press("id:sidebar-pip");
  await app.waitUntil(() => app.count("id:persona-header >> text:Pip") > 0);
  await app.waitUntil(() => app.texts().includes("GPT-5.1"));
  expect(app.texts()).toContain("High");
  expect(app.texts()).not.toContain("DeepSeek Chat");

  await app.press("id:sidebar-persona-nova");
  await app.waitUntil(() => app.count("id:persona-header >> text:Nova") > 0);
  await app.waitUntil(() => app.texts().includes("DeepSeek Chat"));
  expect(app.texts()).not.toContain("GPT-5.1");
});


test("legacy Pip preferences migrate into the default persona scope unchanged", async () => {
  const app = await launch({
    "pipi.prefs.v1": JSON.stringify({
      defaultAgentId: "pi",
      agentSessionChoices: { pi: { model: { provider: "openai", id: "gpt-5.1" }, thinkingLevel: "high" } },
    }),
  });
  await app.waitFor("text:What are we building?");

  await app.press("id:sidebar-pip");
  await app.waitFor("id:persona-header");
  await app.waitUntil(() => app.texts().includes("GPT-5.1"));
  expect(app.texts()).toContain("High");
  expect(app.texts()).not.toContain("Claude Sonnet 4.5");
});

test("delete is protected on the default persona and removes a confirmed custom persona", async () => {
  const app = await launch();
  await app.waitFor("text:What are we building?");

  // The built-in Pip is never deletable, even though every other lightweight action remains.
  await app.press("id:sidebar-pip");
  await app.waitFor("id:persona-header");
  await app.press("id:persona-actions-button");
  let defaultDeleteOffered = false;
  try {
    await app.chooseMenuItem("Delete Personal Agent…");
    defaultDeleteOffered = true;
  } catch {
    defaultDeleteOffered = false;
  }
  expect(defaultDeleteOffered).toBe(false);
  await app.keyboard.press("escape");

  // A custom persona can be deleted only through the confirmation dialog; its row
  // and header leave while the protected default Pip remains.
  await app.press("id:sidebar-persona-add");
  await app.waitFor("id:persona-create-form");
  await app.type("id:persona-name-input", "Nova");
  await app.press("id:persona-create-submit");
  await app.waitUntil(() => app.count("id:persona-create-form") === 0);
  await app.waitFor("id:persona-header");
  expect(app.count("id:sidebar-persona-nova")).toBe(1);

  app.onDialog(() => "Delete");
  await app.press("id:persona-actions-button");
  await app.chooseMenuItem("Delete Personal Agent…");
  await app.waitUntil(() => app.dialogs().length === 1);
  expect(app.dialogs()[0]?.title).toBe("Delete this personal agent?");
  await app.waitUntil(() => app.count("id:sidebar-persona-nova") === 0);
  expect(app.count("id:sidebar-pip >> text:Pip")).toBe(1);
  expect(app.count("id:persona-header")).toBe(0);
});

test("a persona the daemon already holds is adopted instead of started again", async () => {
  const now = Date.now();
  const personaSeed = (id: string, personaId: string, title: string, cwd: string) => ({
    id,
    title,
    titleLocked: true,
    persona: true,
    personaId,
    cwd,
    agentId: "pi",
    agentName: "Pi",
    driver: "pi",
    runtimeMode: "full-access",
    status: "idle",
    unread: false,
    loaded: true,
    depth: 0,
    createdAt: now - 80_000,
    lastActive: now - 10_000,
  });
  // The daemon's registry holds both personas but never pushed them to this
  // window — the mirror the sidebar reads knows nothing of them (the shape a
  // push filtered or lost across a restart leaves).
  const app = await launch({
    "harness.unannouncedDaemonSessions": JSON.stringify([
      personaSeed("s_pip", "default", "Pip", "/Users/pip/.pipi/persona"),
      personaSeed("s_nova", "nova", "Nova", "/Users/pip/.pipi/personas/nova"),
    ]),
  });
  await app.waitFor("text:What are we building?");

  // Pressing Pip's pinned row must adopt the held session, not start a duplicate.
  await app.press("id:sidebar-pip");
  await app.waitFor("id:persona-header");
  await app.waitUntil(() => app.count("id:persona-header >> text:Pip") > 0);
  expect(app.texts().filter((t) => t.includes("already runs as") || t.includes("启动失败"))).toEqual([]);

  // Creating a persona whose id the daemon already holds adopts it too —
  // the toast this used to raise was "Nova 启动失败: the personal agent already runs as s_nova".
  await app.press("id:sidebar-persona-add");
  await app.waitFor("id:persona-create-form");
  await app.type("id:persona-name-input", "Nova");
  await app.press("id:persona-create-submit");
  await app.waitUntil(() => app.count("id:persona-create-form") === 0);
  await app.waitUntil(() => app.count("id:sidebar-persona-nova") === 1);
  await app.waitUntil(() => app.count("id:persona-header >> text:Nova") > 0);
  expect(app.texts().filter((t) => t.includes("already runs as") || t.includes("启动失败"))).toEqual([]);
  expect(app.count("id:sidebar-pip >> text:Pip")).toBe(1);
});

test("a custom persona start upgrades a deferred stale daemon instead of colliding with Pip", async () => {
  const now = Date.now();
  const app = await launch({
    "harness.legacyPersonaDaemon": "1",
    "harness.daemonSessions": JSON.stringify([
      {
        id: "s_legacy_pip",
        title: "Pip",
        titleLocked: true,
        persona: true,
        cwd: "/Users/pip/.pipi/persona",
        agentId: "pi",
        agentName: "Pi",
        driver: "pi",
        runtimeMode: "full-access",
        status: "idle",
        unread: false,
        loaded: true,
        depth: 0,
        createdAt: now - 80_000,
        lastActive: now - 10_000,
      },
    ]),
  });
  await app.waitFor("text:What are we building?");

  await app.press("id:sidebar-persona-add");
  await app.waitFor("id:persona-create-form");
  await app.type("id:persona-name-input", "nsh");
  await app.type("id:persona-description-input", "Native shell helper");
  await app.press("id:persona-create-submit");
  await app.waitUntil(() => app.count("id:persona-create-form") === 0);
  await app.waitUntil(() => app.count("id:sidebar-persona-nsh") === 1);

  expect(app.count("id:sidebar-persona-nsh >> text:nsh")).toBe(1);
  expect(app.count("id:sidebar-pip >> text:Pip")).toBe(1);
  expect(app.texts().filter((t) => t.includes("already runs as") || t.includes("could not start") || t.includes("finishing an update"))).toEqual([]);
});
