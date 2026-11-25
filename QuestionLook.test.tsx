// The agent's stepped question card inside the composer surface:
// single-question focus, folded "Other…" option, and clear progress across steps.
//
//   nsh test QuestionLook.test.tsx --target macos   # writes .nsh/shots/question-*.png
import { open, test } from "nsh/test";

type Scheme = "dark" | "light";
const launch = (colorScheme: Scheme) =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale: "en-US", colorScheme, storage: { "harness.scenario": "history" } });

test("the stepped question card", async () => {
  for (const scheme of ["dark", "light"] as Scheme[]) {
    const app = await launch(scheme);
    await app.waitFor("text:Here is the plan.");
    await app.type("label:Message", "ask a question");
    await app.submit("label:Message");
    await app.waitFor("id:question-form");
    await app.waitFor("text:Which fruit should we use for the recipe?");
    await app.screenshot(`.nsh/shots/question-${scheme}.png`);

    // Expanding "Other…" inline on step 1
    if (scheme === "light") {
      await app.press("text:Other…");
      await app.type("label:Custom answer for Which fruit should we use for the recipe?", "Mango");
      await app.screenshot(".nsh/shots/question-other-light.png");
      await app.press("id:question-next");
    } else {
      // Choosing a standard radio option auto-advances to step 2
      await app.press("text:Pear");
    }

    await app.waitFor("text:Which toppings do you want?");
    await app.press("text:Honey");
    await app.press("text:Yogurt");
    await app.screenshot(`.nsh/shots/question-picked-${scheme}.png`);
  }
}, 120000);
