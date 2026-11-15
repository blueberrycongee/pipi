import { keyboardFrame, platform, safeArea, windowSize } from "nsh";
import { titleBar } from "nsh/desktop";

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
export const topBarHeight = () => (titleBar().height || 44) + (platform.desktop ? 0 : safeArea().top);

/**
 * What a bottom-docked element rises by: the home indicator's inset, and the
 * software keyboard while it is up — both zero on a desktop.
 */
export const bottomInset = () => Math.max(safeArea().bottom, keyboardFrame().height);
