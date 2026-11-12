// Screenshots of every state, for design review, from the scripted Pi:
//
//   nsh test Shots.test.tsx --target macos      # writes .nsh/shots/*.png
//
// Only a real platform draws the app, so headless runs skip.
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

type Scheme = "dark" | "light";
const launch = (scenario: string, colorScheme: Scheme = "dark") =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", colorScheme, storage: { "harness.scenario": scenario } });

let drawn = true;
async function shot(app: App, name: string) {
  if (!drawn) return;
  await app.wait(500);
  try {
    await app.screenshot(`.nsh/shots/${name}.png`);
  } catch {
    drawn = false;
  }
}

test("states", async () => {
  for (const scheme of ["dark", "light"] as Scheme[]) {
    let app = await launch("welcome", scheme);
    await app.waitFor("text:What are we building?");
    await shot(app, `welcome-${scheme}`);
    if (!drawn) return;
    await app.press("text:Claude Sonnet 4.5");
    await shot(app, `models-${scheme}`);
    await app.press("label:Message");
    await app.paste("label:Message", { files: ["icon.png", "icon.png"] });
    await app.waitFor("label:icon.png");
    await shot(app, `attachments-${scheme}`);

    app = await launch("multi", scheme);
    await app.waitFor("text:What are we building?");
    await shot(app, `multi-workspaces-${scheme}`);

    app = await launch("history", scheme);
    await app.waitFor("text:Here is the plan.");
    await app.press("text:Finished in under 1 second");
    await app.press("text:Ran ls, Read package.json");
    await app.waitFor("text:ls -la");
    await app.press("text:ls -la");
    await shot(app, `history-${scheme}`);
    await app.press("label:Settings");
    await shot(app, `settings-general-${scheme}`);
    for (const section of ["agents", "usage", "about"]) {
      await app.press(`id:settings-nav-${section}`);
      await shot(app, `settings-${section}-${scheme}`);
    }
    // An agent's own page opens from its row in Agents.
    await app.press("id:settings-nav-agents");
    await app.press("text:Providers");
    await app.waitFor("text:Anthropic");
    await shot(app, `settings-providers-${scheme}`);

    app = await launch("connect", scheme);
    await app.waitFor("text:Connect a model to begin");
    await shot(app, `connect-${scheme}`);

    app = await launch("failed", scheme);
    await app.waitFor("text:Pi could not start");
    await shot(app, `failed-${scheme}`);

    app = await launch("slow", scheme);
    await app.waitFor("text:What are we building?");
    await app.type("label:Message", "make a plan");
    await app.submit("label:Message");
    await app.wait(2600);
    await shot(app, `running-${scheme}`);
    await app.type("label:Message", "also update the readme");
    await app.keyboard.press("mod+enter");
    await app.wait(400);
    await shot(app, `queued-${scheme}`);
  }
}, 120000);
