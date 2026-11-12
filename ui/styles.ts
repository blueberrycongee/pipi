import { platform, type ViewStyle } from "nsh";

/**
 * Class recipes shared by the component kit: one treatment per kind of
 * surface and interaction, so popups, rows and focus never drift apart.
 * Colors are theme tokens only; sizes come from the scale in DESIGN.md.
 */

/** Native Apple Liquid Glass recipes (`glassEffect` on macOS 26 / iOS 26+,
 * with saturated Gaussian backdrop blur fallback on earlier OSes and web). */
export const GLASS_REGULAR: ViewStyle = {
  glassEffect: "regular",
  backdropFilter: "blur(28px) saturate(180%)",
};

export const GLASS_CLEAR: ViewStyle = {
  glassEffect: "clear",
  backdropFilter: "blur(32px) saturate(190%)",
};

/** What stands behind every floating layer — Settings, the palette, a dialog:
 * one backdrop, and no layer picks its own. A layer floats over the window, so
 * the window stays in sight: the `scrim` tint alone sets the layer apart, and
 * what is behind it keeps its shapes and its words. No `backdropFilter` here:
 * macOS draws one as a system material whatever its radius, which leaves
 * nothing of the window to see. */
export const SCRIM = "bg-scrim";

/** The anchored-surface family: popovers, menus, the palette, toasts —
 * translucent popover fill over native Liquid Glass. */
export const POPUP = "rounded-xl border-[0.5px] border-hairline bg-popover/72 shadow-popover dark:bg-popover/68";

/** Toasts stack over the scrolling transcript, unlike other popups: an opaque
 * surface — translucent glass would let rows ghost through — and a tight
 * shadow that does not fall onto the card below. */
export const POPUP_TOAST = "rounded-xl border-[0.5px] border-hairline bg-popover shadow-toast dark:bg-popover";

/** Floating header bar recipe over scrolling pages. */
export const HEADER_GLASS = "border-b-[0.5px] border-border bg-background/62 dark:bg-background/58";

/** How a popup arrives and leaves: a short fade and settle toward its trigger. */
export const POPUP_MOTION = "transition-all duration-200 ease-out-quint motion-reduce:transition-none";
export const POPUP_HIDDEN = "opacity-0 scale-[0.96] translate-y-1";

/** Keyboard focus, the same ring everywhere. */
export const FOCUS_RING = "focus:ring-2 focus:ring-ring";

/** The feedback of anything pressable: smooth color & micro-scale press. */
export const PRESS = "transition duration-150 ease-out-quint motion-reduce:transition-none";
export const PRESS_SCALE = "active:scale-[0.97] disabled:active:scale-100 motion-reduce:active:scale-100";

/** Modern hairline + shadow photography input field recipe. */
export const FIELD_SURFACE =
  "border-[0.5px] border-hairline bg-card/85 shadow-field transition-all duration-200 ease-out-quint hover:border-hairline-hover focus:border-hairline-focus focus-within:border-hairline-focus dark:bg-card/80 dark:shadow-field-dark";

/** Modern hairline + Liquid Glass + multi-layer photographic ambient shadow for the floating composer. */
export const COMPOSER_SURFACE =
  "border-[0.5px] border-hairline bg-card/65 shadow-composer transition-all duration-250 ease-out-quint hover:border-hairline-hover focus-within:border-hairline-focus focus-within:bg-card/78 focus-within:shadow-composer-focus dark:bg-card/58 dark:shadow-composer-dark dark:hover:border-hairline-hover dark:focus-within:border-hairline-focus dark:focus-within:bg-card/72 dark:focus-within:shadow-composer-dark-focus motion-reduce:transition-none";

/** Where the wallpaper laid under the whole window can be frosted — everywhere
 * but Linux, which draws no backdrop filter: there the sidebar keeps its solid
 * fill and a conversation its solid page, and the wallpaper shows where it is
 * shown plain (the empty chat). (`withinWindow` vibrancy cannot see nsh's
 * drawn views, so the frost is `backdropFilter`-based.) */
export const WALLPAPER_FROST = platform.os !== "linux";

/** The sidebar's frost over the wallpaper: light enough that the wallpaper's
 * shapes survive, under a theme tint keeping rows legible. */
export const SIDEBAR_GLASS: ViewStyle = {
  backdropFilter: "blur(18px) saturate(170%)",
};

/** A conversation's page over the wallpaper: the sidebar's frost again, so the
 * two read as one sheet of glass — under the page's own wash, which takes it
 * into the page below the title bar. */
export const PAGE_GLASS: ViewStyle = {
  backdropFilter: "blur(22px) saturate(170%)",
};

/** A row in a list or menu: hover and keyboard highlight share one look. */
export const ROW = `h-8 flex-row items-center gap-2 rounded-md px-2 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`;

/** Text roles. */
export const LABEL = "text-base text-foreground";
export const SECONDARY = "text-sm text-muted-foreground";
export const CAPTION = "text-xs text-subtle";
