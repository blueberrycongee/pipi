import { expect, test } from "nsh/test";
import { TAB_MAX_W, TAB_MIN_W, stripTabWidth, tabWidthBounds } from "./strip-width";

test("a few pills fill out to the widest width", () => {
  expect(stripTabWidth(800, 1)).toBe(TAB_MAX_W);
  expect(stripTabWidth(800, 4)).toBe(TAB_MAX_W);
});

test("more pills share the viewport evenly, squeezing as they go", () => {
  // (800 - 8 - 5*4 - 24) / 5 = 149.6 → 149
  expect(stripTabWidth(800, 5)).toBe(149);
  expect(stripTabWidth(800, 6)).toBe(124);
});

test("past the floor the pills hold the narrowest width (the strip scrolls)", () => {
  // (800 - 8 - 10*4 - 24) / 10 = 72.8 → under TAB_MIN_W
  expect(stripTabWidth(800, 10)).toBe(TAB_MIN_W);
  expect(stripTabWidth(400, 20)).toBe(TAB_MIN_W);
});

test("a strip not laid out yet (or empty) keeps the widest width", () => {
  expect(stripTabWidth(0, 8)).toBe(TAB_MAX_W);
  expect(stripTabWidth(800, 0)).toBe(TAB_MAX_W);
});

test("larger interface scale widens pill bounds while smaller scale keeps full room for titles", () => {
  expect(tabWidthBounds(1)).toEqual({ min: TAB_MIN_W, max: TAB_MAX_W });
  expect(tabWidthBounds(11 / 13)).toEqual({ min: TAB_MIN_W, max: TAB_MAX_W });
  const large = tabWidthBounds(16 / 13);
  expect(large.max).toBe(Math.round(TAB_MAX_W * (16 / 13)));
  expect(large.min).toBe(Math.round(TAB_MIN_W * (16 / 13)));
  expect(stripTabWidth(1200, 2, 16 / 13)).toBe(large.max);
  expect(stripTabWidth(400, 20, 16 / 13)).toBe(large.min);
});
