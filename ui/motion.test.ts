import { expect, test } from "nsh/test";
import { DURATION, isRowSeen, markRowsSeen, popupStyle, useRowEntrance, useSmsBubbleEntrance } from "./motion";
import { COMPOSER_SURFACE } from "./styles";

test("delegated SMS rows are claimed only by their bubble, not the outer row", () => {
  markRowsSeen([]);
  for (const [id, side] of [["user-live", "right"], ["reply#b0", "left"], ["reply#b1", "left"]] as const) {
    useRowEntrance(() => id, undefined, () => "delegate");
    expect(isRowSeen(id)).toBe(false);
    useSmsBubbleEntrance(() => id, () => side);
    expect(isRowSeen(id)).toBe(true);
  }
});

test("ordinary skipped rows still seed seen IDs and delegation preserves history seeds", () => {
  markRowsSeen(["history"]);
  useRowEntrance(() => "coding-prose", undefined, () => true);
  expect(isRowSeen("coding-prose")).toBe(true);
  useRowEntrance(() => "history", undefined, () => "delegate");
  expect(isRowSeen("history")).toBe(true);
});

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
