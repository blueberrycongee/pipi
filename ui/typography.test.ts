import { expect, test } from "nsh/test";
import { FONT_SIZES, resetFontSizes, setFontSize } from "../store/prefs";
import { uiHeight, uiIconSize, uiMinHeight, uiRowHeight, uiType } from "./typography";

test("default 13pt interface size emits original Tailwind tokens verbatim", () => {
  resetFontSizes();
  expect(uiType("2xs")).toBe("text-2xs");
  expect(uiType("xs")).toBe("text-xs");
  expect(uiType("sm")).toBe("text-sm");
  expect(uiType("base")).toBe("text-base");
  expect(uiType("xl")).toBe("text-xl");
  expect(uiHeight(24)).toBe("h-6");
  expect(uiHeight(26)).toBe("h-6.5");
  expect(uiHeight(28)).toBe("h-7");
  expect(uiHeight(32)).toBe("h-8");
  expect(uiMinHeight(44)).toBe("min-h-11");
  expect(uiIconSize(14)).toBe(14);
});

test("interface scale preserves type ladder, row heights, and title bar ceiling across 11–16pt", () => {
  try {
    setFontSize("ui", FONT_SIZES.ui.min);
    expect(uiType("base")).toBe("text-[11px]/[1.54]");
    expect(uiType("sm")).toBe("text-[10px]/[1.5]");
    expect(uiType("2xs")).toBe("text-[9px]/[1.4]");
    expect(uiRowHeight(24)).toBe(24);
    expect(uiRowHeight(28)).toBe(26);
    expect(uiRowHeight(32)).toBe(28);
    expect(uiHeight(28)).toBe("h-[26px]");

    setFontSize("ui", FONT_SIZES.ui.max);
    expect(uiType("base")).toBe("text-[16px]/[1.54]");
    expect(uiType("sm")).toBe("text-[15px]/[1.5]");
    expect(uiRowHeight(24)).toBe(30);
    expect(uiRowHeight(28)).toBe(34);
    expect(uiRowHeight(32)).toBe(38);
    // Tab pills stay well inside the 44pt window title bar even at 16pt.
    expect(uiRowHeight(28, { max: 34 })).toBe(34);
    expect(uiRowHeight(24, { max: 28 })).toBe(28);
    expect(uiHeight(28, { max: 34 })).toBe("h-[34px]");
    expect(uiIconSize(14)).toBe(16);
  } finally {
    resetFontSizes();
  }
});
