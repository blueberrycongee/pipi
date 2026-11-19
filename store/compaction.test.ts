import { expect, test } from "nsh/test";
import { fakeBackend } from "../dev/fake-pi";
import { useBackend } from "./backend";
import * as store from "./app";

test("attaching to a compacted Pi session restores the conversation, not the model's shortened context", async () => {
  useBackend(fakeBackend({ history: [
    { role: "user", content: "The original brief", timestamp: 1 },
    { role: "compactionSummary", summary: "Short summary", tokensBefore: 259000, timestamp: 2 },
    { role: "user", content: "Continue", timestamp: 3 },
  ] }));
  await store.boot();
  for (let i = 0; i < 500 && store.sidecarPhase().name !== "ready"; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(store.transcriptRows().map(row => "text" in row ? row.text : row.kind)).toEqual([
    "The original brief", "Short summary", "Continue",
  ]);
});
