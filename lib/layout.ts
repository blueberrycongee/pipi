import { keyboardFrame, platform, safeArea, signal, windowSize } from "nsh";
import { focusedWindow, isAvailable, Window, windows, type TitleBarArea, type WindowRef } from "nsh/desktop";

const ZERO_TITLE_BAR: TitleBarArea = { height: 0, left: 0, right: 0 };
const boundWindow = signal<WindowRef | null>(null);

/**
 * Registers the `WindowRef` captured while rendering the window root (`Shell`).
 * All layout helpers read `win.titleBar()` through this ref rather than calling
 * the render-scoped global `titleBar()`, which throws outside a `<Window>`
 * render frame (event handlers, rAF, Promise callbacks, timers).
 */
export function bindWindow(win: WindowRef | null): () => void {
  boundWindow.set(win);
  return () => {
    if (boundWindow() === win) boundWindow.set(null);
  };
}

/**
 * Reactive title bar insets for the active window, safe to read from any
 * context (render, reactive props/effects, event handlers, async callbacks).
 */
export function titleBarArea(win?: WindowRef | null): TitleBarArea {
  const target =
    win ??
    boundWindow() ??
    (isAvailable ? (Window.get("main") ?? focusedWindow() ?? windows()[0] ?? null) : null);
  return target ? target.titleBar() : ZERO_TITLE_BAR;
}

/**
 * Under this width the sidebar stops taking a slice of the window and floats
 * over the pane as a drawer — a phone's width, or a desktop window dragged
 * that narrow.
 */
export const SIDEBAR_DRAWER_BELOW = 700;
export const compactLayout = () => windowSize().width < SIDEBAR_DRAWER_BELOW;

/**
 * Without a wallpaper the main pane floats as a paper sheet inside the window
 * tray, this many points in from the window's edges (the `py-[7px]`/`p-[7px]`
 * in `SidebarSplit`). The sheet's title strip — and everything centered in it,
 * the tab pills — sits this far below the window's top edge, so the window
 * controls and the sidebar's header button aim at the same line rather than at
 * the strip's geometric center.
 */
export const SHEET_INSET = 7;

/**
 * The app title bar's height in points — nsh.json's `window.titleBar.height`.
 * The strips and the content below them size themselves from this constant
 * rather than `titleBarArea().height`: on macOS the runtime keeps the traffic
 * lights centered in the height it reports, and raising `controlsOffset.y` to
 * drop them onto the strip's line inflates that report (twice the offset
 * center) — a number nothing in the layout may follow, or the strip grows
 * under the pills and undoes the alignment.
 */
export const TITLE_BAR_HEIGHT = 44;

/** The visible radius of macOS's traffic lights: their center rests this far below `controlsOffset.y`. */
const TRAFFIC_LIGHT_RADIUS = 6.5;

/**
 * The horizontal line the title strip's contents sit on, measured from the
 * window's top edge: the sheet's margin plus half the strip. Everything at the
 * window's top — tab pills, the sidebar's hide button, the traffic lights —
 * centers on this one line. Pure on purpose: the strip's height is the app's
 * own (`TITLE_BAR_HEIGHT`), and the window's `titleBar` signal must not be
 * read where writing it back would loop (`Shell`'s controls effect).
 */
export const stripLine = (sheetInset: number) => sheetInset + TITLE_BAR_HEIGHT / 2;

/**
 * The `controlsOffset` that centers macOS's traffic lights on the strip's
 * line: the sheet inset's line, or the window top's own over a wallpaper (the
 * sheet runs edge-to-edge there). `x` is nsh.json's 16 — the runtime takes the
 * pair whole, so it is repeated here.
 */
export const trafficLightsOffset = (sheetInset: number) => ({
  x: 16,
  y: stripLine(sheetInset) - TRAFFIC_LIGHT_RADIUS,
});

/**
 * The pane's top bar: the app's title bar height, plus where system UI sits
 * over the surface (a phone's notch and status bar) its inset — on a desktop
 * the title bar's own.
 */
export const topBarHeight = () => TITLE_BAR_HEIGHT + (platform.desktop ? 0 : safeArea().top);

/**
 * What a bottom-docked element rises by: the home indicator's inset, and the
 * software keyboard while it is up — both zero on a desktop.
 */
export const bottomInset = () => Math.max(safeArea().bottom, keyboardFrame().height);

/**
 * A document's column (`DESIGN.md` → Documents): a 720pt measure, a step
 * narrower than the conversation's 760, on the conversation's 24pt margin.
 */
export const DOC_COLUMN = "mx-auto w-full max-w-192 px-6";
