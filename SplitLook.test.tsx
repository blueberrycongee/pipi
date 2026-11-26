import * as fs from "fs/promises";
import { open, test } from "nsh/test";

// Visual verification for drag-to-split drop zones and live split chat on macOS:
//
//   nsh test SplitLook.test.tsx --target macos

const REFACTOR = "Refactor the transcript reducer";
const NOTES = "Release notes for 0.1";
const row = (title: string) => `id:sidebar-recents >> text:${title}`;

const launch = (colorScheme: "light" | "dark", extra: Record<string, string> = {}) =>
  open("./Harness.tsx", {
    width: 1220,
    height: 780,
    platform: "macos",
    locale: "en-US",
    colorScheme,
    storage: {
      "harness.scenario": "welcome",
      "harness.distinct": "1",
      "pipi.prefs.v1": JSON.stringify({ appearance: colorScheme }),
      ...extra,
    },
  });

test("split drop zones and side-by-side chat screenshots", async () => {
  await fs.mkdir(".nsh/shots", { recursive: true });
  // 1. Mid-drag drop zones over a live conversation (light).
  const dragShot = await launch("light", { "harness.then": "900:splitdrag:right" });
  await dragShot.waitFor("text:What are we building?");
  await dragShot.press(row(REFACTOR));
  await dragShot.waitFor(`label:Conversation >> text:${REFACTOR}`);
  await dragShot.waitFor("id:split-drop-right");
  await dragShot.wait(220);
  await dragShot.screenshot(".nsh/shots/split-drop-zones.png");

  // 2. Side-by-side live split chat (light).
  const light = await launch("light");
  await light.waitFor("text:What are we building?");
  await light.press(row(REFACTOR));
  await light.waitFor(`label:Conversation >> text:${REFACTOR}`);
  await light.rightClick(row(NOTES));
  await light.chooseMenuItem("Split Right");
  await light.waitFor("id:split-pane");
  await light.waitFor(`id:split-pane >> text:${NOTES}`);
  await light.wait(220);
  await light.screenshot(".nsh/shots/split-chat-light.png");

  // 3. Side-by-side live split chat (dark).
  const dark = await launch("dark");
  await dark.waitFor("text:What are we building?");
  await dark.press(row(REFACTOR));
  await dark.waitFor(`label:Conversation >> text:${REFACTOR}`);
  await dark.rightClick(row(NOTES));
  await dark.chooseMenuItem("Split Right");
  await dark.waitFor("id:split-pane");
  await dark.waitFor(`id:split-pane >> text:${NOTES}`);
  await dark.wait(220);
  await dark.screenshot(".nsh/shots/split-chat-dark.png");
});
