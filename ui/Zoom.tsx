import { platform, Scroll, signal, Text, View } from "nsh";
import type { JSX } from "nsh";
import { tr } from "../lib/i18n";
import { IconButton } from "./Button";
import { FloatingLayer, keepLast } from "./Reveal";
import { uiType } from "./typography";

/**
 * The window's one zoom layer: content that wants more room than its place in
 * the transcript gives it — a wide table, a picture — previewed in the glass
 * sheet every floating surface shares (`FloatingLayer` over `SCRIM`).
 *
 * `openZoom` hands it a render; whatever wants the same surface later (image
 * preview, diff, …) mounts nothing new. The preview is given whole — a
 * snapshot, not a view of the row it came from — so a recycled `List` cell or
 * a switched session leaves it standing.
 */
type ZoomText = string | (() => string | undefined);

export interface ZoomContent {
  /** `"sheet"` (default): roomy scrollable card for tables/prose. `"stage"`: full-window lightbox for media. */
  layout?: "sheet" | "stage";
  /** Optional compact badge ahead of the title (e.g. gallery position `"2 / 5"`). */
  badge?: ZoomText;
  /** A caption in the strip over the preview (a picture's name); a table needs none. */
  title?: ZoomText;
  /** Optional metadata beside the title (dimensions, file size). */
  subtitle?: ZoomText;
  /** Extra classes on the panel over the default sheet/stage. */
  panelClass?: string;
  /** Optional header actions placed next to the close button (Open, Show in Finder). */
  actions?: () => JSX.Element;
  render: () => JSX.Element;
}

const readZoomText = (value?: ZoomText): string | undefined => (typeof value === "function" ? value() : value);

const zoomed = signal<ZoomContent | undefined>(undefined);

/** Opens the zoom layer on the window — the same surface whatever it previews. */
export function openZoom(content: ZoomContent) {
  zoomed.set(content);
}

export function closeZoom() {
  zoomed.set(undefined);
}

/** Whether the zoom layer is up — Escape leaves it before anything under it. */
export function isZoomOpen() {
  return zoomed() !== undefined;
}

/** The zoom layer itself, mounted once at the shell's root. */
export function ZoomLayer() {
  const shown = keepLast(() => zoomed());
  const isStage = () => shown()?.layout === "stage";
  const badge = () => readZoomText(shown()?.badge);
  const title = () => readZoomText(shown()?.title);
  const subtitle = () => readZoomText(shown()?.subtitle);

  const stageFrameClass = platform.os === "macos" ? "items-center justify-center px-3 pb-3 pt-11" : "items-center justify-center p-3";

  return (
    <FloatingLayer
      open={zoomed() !== undefined}
      onClose={closeZoom}
      closeLabel={tr("Close preview", "关闭预览")}
      frameClass={isStage() ? stageFrameClass : undefined}
      panelClass={isStage() ? `h-full w-full min-h-0 ${shown()?.panelClass ?? ""}` : `w-full max-w-240 min-h-0 ${shown()?.panelClass ?? ""}`}
    >
      <If
        when={isStage()}
        else={
          <View class="min-h-0 w-full">
            <View class="flex-row items-center justify-end gap-2 pl-4 pr-2.5 pt-2.5">
              <If when={badge() || title() || subtitle()}>
                <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
                  <If when={title()}>
                    {(t) => <Text class={`min-w-0 shrink truncate ${uiType("sm")} font-medium text-foreground`}>{t()}</Text>}
                  </If>
                  <If when={subtitle()}>
                    {(sub) => <Text class={`shrink-0 ${uiType("xs")} tabular-nums text-subtle`}>{sub()}</Text>}
                  </If>
                </View>
              </If>
              {shown()?.actions?.()}
              <IconButton icon="x" size="sm" label={tr("Close preview", "关闭预览")} onPress={closeZoom} />
            </View>
            <Scroll class="min-h-0 max-h-140" contentClass="px-5 pb-5 pt-3">
              {shown()?.render()}
            </Scroll>
          </View>
        }
      >
        <View class="min-h-0 size-full">
          <View class="h-11 shrink-0 flex-row items-center justify-end gap-2 border-b-[0.5px] border-hairline pl-3.5 pr-2.5">
            <If when={badge() || title() || subtitle()}>
              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                <If when={badge()}>
                  {(b) => (
                    <View
                      testID="zoom-gallery-counter"
                      class="shrink-0 rounded-md corner-squircle border-[0.5px] border-hairline bg-secondary/90 px-2 py-0.5"
                    >
                      <Text class={`${uiType("xs")} font-medium tabular-nums text-muted-foreground`}>{b()}</Text>
                    </View>
                  )}
                </If>
                <If when={title()}>
                  {(t) => <Text class={`min-w-0 shrink truncate ${uiType("sm")} font-medium text-foreground`}>{t()}</Text>}
                </If>
                <If when={subtitle()}>
                  {(sub) => <Text class={`shrink-0 ${uiType("xs")} tabular-nums text-subtle`}>{sub()}</Text>}
                </If>
              </View>
            </If>
            {shown()?.actions?.()}
            <IconButton icon="x" size="sm" label={tr("Close preview", "关闭预览")} onPress={closeZoom} />
          </View>
          <View class="min-h-0 w-full flex-1">{shown()?.render()}</View>
        </View>
      </If>
    </FloatingLayer>
  );
}
