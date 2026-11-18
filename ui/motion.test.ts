import { expect, test } from "nsh/test";
import { DURATION, popupStyle } from "./motion";
import { COMPOSER_SURFACE } from "./styles";

test("composer focus stays within the 220ms state-transition budget", () => {
  expect(COMPOSER_SURFACE.split(" ")).toContain("duration-220");
  expect(COMPOSER_SURFACE.split(" ")).toContain("motion-reduce:transition-none");
});

test("popup entry uses the shared 120ms duration for every anchor", () => {
  for (const placement of ["top", "bottom", "left", "right"] as const) {
    for (const align of ["start", "center", "end"] as const) {
      expect(popupStyle(placement, align).transitionDuration).toBe(DURATION.instant);
      expect(popupStyle(placement, align).transitionDuration).toBe(120);
    }
  }
  expect(popupStyle().transitionDuration).toBe(120);
});
