import { expect, test } from "nsh/test";
import { edgeFadeMask } from "./scroll-mask";

test("no hidden content means no mask", () => {
  expect(edgeFadeMask(120, 0, 0)).toBeUndefined();
  expect(edgeFadeMask(120, -4, -8)).toBeUndefined();
  expect(edgeFadeMask(0, 20, 20)).toBeUndefined();
});

test("content below fades the foot while the head stays whole", () => {
  const mask = edgeFadeMask(120, 0, 120)!;
  expect(mask.startsWith("linear-gradient(to bottom, #000000ff 0px")).toBe(true);
  expect(mask.endsWith("#00000000 120px)")).toBe(true);
});

test("content in both directions fades both ends, proportionally at first", () => {
  const mask = edgeFadeMask(120, 6, 6)!;
  expect(mask.startsWith("linear-gradient(to bottom, #00000080 0px")).toBe(true);
  expect(mask.endsWith("#00000080 120px)")).toBe(true);
});

test("reaching an end lifts that end's fade", () => {
  const top = edgeFadeMask(120, 12, 30)!;
  expect(top.startsWith("linear-gradient(to bottom, #00000000 0px")).toBe(true);
  const bottom = edgeFadeMask(120, 30, 0)!;
  expect(bottom.endsWith("#000000ff 120px)")).toBe(true);
});

test("the fade never takes more than a third of a short viewport", () => {
  const mask = edgeFadeMask(36, 12, 12)!;
  expect(mask).toContain("#000000ff 12px");
  expect(mask).toContain("#000000ff 24px");
});
