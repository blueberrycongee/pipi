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
 * The pane's top bar: the app's title bar height, plus where system UI sits
 * over the surface (a phone's notch and status bar) its inset — on a desktop
 * the title bar's own.
 */
export const topBarHeight = () => (titleBarArea().height || 44) + (platform.desktop ? 0 : safeArea().top);

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
