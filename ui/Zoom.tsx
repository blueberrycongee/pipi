import { Scroll, signal, Text, View } from "nsh";
import type { JSX } from "nsh";
import { tr } from "../lib/i18n";
import { IconButton } from "./Button";
import { FloatingLayer, keepLast } from "./Reveal";

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
export interface ZoomContent {
  /** A caption in the strip over the preview (a picture's name); a table needs none. */
  title?: string;
  /** Extra classes on the panel over the default roomy sheet. */
  panelClass?: string;
  render: () => JSX.Element;
}

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
  return (
    <FloatingLayer
      open={zoomed() !== undefined}
      onClose={closeZoom}
      closeLabel={tr("Close preview", "关闭预览")}
      panelClass={`w-full max-w-240 min-h-0 ${shown()?.panelClass ?? ""}`}
    >
      <View class="min-h-0 w-full">
        <View class="flex-row items-center justify-end gap-3 pl-4 pr-2.5 pt-2.5">
          <If when={shown()?.title}>
            {(title) => <Text class="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{title()}</Text>}
          </If>
          <IconButton icon="x" size="sm" label={tr("Close preview", "关闭预览")} onPress={closeZoom} />
        </View>
        <Scroll class="min-h-0 max-h-140" contentClass="px-5 pb-5 pt-3">
          {shown()?.render()}
        </Scroll>
      </View>
    </FloatingLayer>
  );
}
