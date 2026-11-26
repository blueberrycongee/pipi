import { expect, open, test } from "nsh/test";
import { decodeLumGrid, pixelDiff } from "./dev/frames";

test("live SMS bubbles enter once; recycled and historical bubbles land still", async () => {
  const app = await open("./dev/PipMotionStage.tsx", {
    width: 800, height: 520, platform: "macos", locale: "en-US", clock: {},
  });
  await app.press("id:deliver");
  await app.waitUntil(() => app.count("id:pip-sms-bubble") === 2);
  const early = decodeLumGrid(await app.screenshot(), 2);
  await app.wait(400);
  const settled = decodeLumGrid(await app.screenshot(), 2);
  const half = settled.width / 2;
  expect(pixelDiff(early, settled, half, settled.width, 0, settled.height, 4)).toBeGreaterThan(0.001);
  expect(pixelDiff(early, settled, 0, half, 100, settled.height, 4)).toBeGreaterThan(0.001);
  for (const action of ["remount", "history"]) {
    await app.press(`id:${action}`);
    await app.waitUntil(() => app.count("id:pip-sms-bubble") === 2);
    const landed = decodeLumGrid(await app.screenshot(), 2);
    await app.wait(400);
    const later = decodeLumGrid(await app.screenshot(), 2);
    expect(pixelDiff(landed, later, 0, later.width, 100, later.height, 4)).toBe(0);
  }
  await app.press("id:single");
  await app.waitUntil(() => app.count("id:pip-sms-bubble") === 1);
  const singleEarly = decodeLumGrid(await app.screenshot(), 2);
  await app.wait(400);
  const singleSettled = decodeLumGrid(await app.screenshot(), 2);
  expect(pixelDiff(singleEarly, singleSettled, 0, half, 100, settled.height, 4)).toBeGreaterThan(0.001);
});
