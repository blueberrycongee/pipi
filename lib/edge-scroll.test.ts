import { expect, test } from "nsh/test";
import { EDGE_INSIDE, EDGE_MAX, EDGE_MIN, EDGE_RAMP, edgeStep, edgeTarget } from "./edge-scroll";

test("a pointer between the edges scrolls nothing", () => {
  expect(edgeStep(300, 44, 668)).toBe(0);
  expect(edgeStep(44 + EDGE_INSIDE, 44, 668)).toBe(0);
  expect(edgeStep(668 - EDGE_INSIDE, 44, 668)).toBe(0);
});

test("it starts slow just inside an edge and speeds up outward, to a limit", () => {
  const step = (at: number) => edgeStep(at, 44, 668);
  expect(step(668 - EDGE_INSIDE + 1)).toBeGreaterThan(0);
  expect(step(668 - EDGE_INSIDE + 1)).toBeLessThan(EDGE_MIN + 1);
  expect(step(700)).toBeGreaterThan(step(660));
  expect(step(668 - EDGE_INSIDE + EDGE_RAMP)).toBe(EDGE_MAX);
  expect(step(5000)).toBe(EDGE_MAX);
  expect(step(44 + EDGE_INSIDE - 1)).toBeLessThan(0);
  expect(step(10)).toBeLessThan(step(50));
  expect(step(-5000)).toBe(-EDGE_MAX);
});

test("a band with no middle scrolls nothing", () => {
  expect(edgeStep(10, 0, 40)).toBe(0);
  expect(edgeStep(10, 0, 0)).toBe(0);
});

test("a step goes on from where the last one aimed until the list reports again", () => {
  // Nothing sent yet: from where the list is.
  expect(edgeTarget(10, 500, 2000, undefined, undefined)).toBe(510);
  // The list has not reported since the last step: from its aim.
  expect(edgeTarget(10, 500, 2000, 500, 510)).toBe(520);
  // It has (wherever it landed): from there.
  expect(edgeTarget(10, 508, 2000, 500, 510)).toBe(518);
});

test("a target stops at the start, and a step past the last end the list reported", () => {
  expect(edgeTarget(-30, 12, 2000, undefined, undefined)).toBe(0);
  expect(edgeTarget(30, 2000, 2000, undefined, undefined)).toBe(2030);
  expect(edgeTarget(30, 2000, 2000, 2000, 2030)).toBe(2000 + EDGE_MAX);
  expect(edgeTarget(30, 2000, 2000, 2000, 2000 + EDGE_MAX)).toBe(2000 + EDGE_MAX);
});
