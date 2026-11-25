// The agent's question card above the composer: the popup panel every anchored
// surface shares, with the picks marked the way a menu marks them.
//
//   nsh test QuestionLook.test.tsx --target macos   # writes .nsh/shots/question-*.png
import { open, test } from "nsh/test";

type Scheme = "dark" | "light";
const launch = (colorScheme: Scheme) =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", colorScheme, storage: { "harness.scenario": "history" } });

test("the question card", async () => {
  for (const scheme of ["dark", "light"] as Scheme[]) {
    const app = await launch(scheme);
    await app.waitFor("text:Here is the plan.");
    await app.type("label:Message", "ask a question");
    await app.submit("label:Message");
    await app.waitFor("text:Antigravity asks");
    await app.waitFor("text:Which fruit should we use for the recipe?");
    await app.press("text:Pear");
    await app.screenshot(`.nsh/shots/question-${scheme}.png`);
    await app.scroll("id:question-fields", 220);
    await app.press("text:Honey");
    await app.press("text:Yogurt");
    await app.screenshot(`.nsh/shots/question-picked-${scheme}.png`);
  }
}, 120000);
