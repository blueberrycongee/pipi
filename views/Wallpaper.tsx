import {
  colorScheme,
  computed,
  createMotion,
  Image,
  ShaderEffect,
  signal,
  Text,
  View,
} from "nsh";
import { Button as BaseButton, Dialog } from "nsh/base";
import { tr } from "../lib/i18n";
import {
  clampAdjustment,
  DEFAULT_WALLPAPER_ADJUSTMENT,
  fittedGeometry,
  isDefaultAdjustment,
  MAX_WALLPAPER_ZOOM,
  MIN_WALLPAPER_ZOOM,
  panAdjustment,
  WALLPAPER_SHADERS,
  wallpaperShaderUniforms,
  zoomAdjustmentAround,
  type WallpaperAdjustment,
  type WallpaperConfig,
  type WallpaperEffect,
} from "../lib/wallpaper";
import {
  updateWallpaperAdjustment,
  wallpaper,
  wallpaperEffect,
} from "../store/app";
import { Button, IconButton } from "../ui/Button";
import { DIALOG_RISE } from "../ui/motion";
import { GLASS_REGULAR, GLASS_SCRIM, POPUP } from "../ui/styles";

const HERO_MAX_HEIGHT = 760;
const HERO_VIEWPORT_RATIO = 0.72;
const HERO_MASK_GRADIENT =
  "linear-gradient(to bottom, black 0%, rgba(0,0,0,0.82) 52%, transparent 100%)";

function EffectSurface(props: {
  effect: WallpaperEffect;
  config: WallpaperConfig;
  offsetX: number;
  offsetY: number;
  scaledWidth: number;
  scaledHeight: number;
}) {
  const isDark = () => colorScheme() === "dark";
  return (
    <View class="pointer-events-none absolute inset-0 overflow-hidden">
      <If
        when={props.effect !== "none"}
        else={
          <Image
            src={props.config.path}
            style={{
              position: "absolute",
              left: props.offsetX,
              top: props.offsetY,
              width: props.scaledWidth,
              height: props.scaledHeight,
              objectFit: "cover",
            }}
          />
        }
      >
        <ShaderEffect
          source={WALLPAPER_SHADERS[props.effect === "none" ? "dither" : props.effect]}
          uniforms={wallpaperShaderUniforms(
            props.effect === "none" ? "dither" : props.effect,
            isDark(),
          )}
          class="absolute inset-0 overflow-hidden"
        >
          <Image
            src={props.config.path}
            style={{
              position: "absolute",
              left: props.offsetX,
              top: props.offsetY,
              width: props.scaledWidth,
              height: props.scaledHeight,
              objectFit: "cover",
            }}
          />
        </ShaderEffect>
      </If>
    </View>
  );
}

/**
 * Renders a cropped wallpaper image inside a frame of `viewportWidth` x `viewportHeight`
 * using cover-fit + focal point + zoom geometry (`fittedGeometry`).
 */
export function CroppedWallpaperSurface(props: {
  config: WallpaperConfig;
  viewportWidth: number;
  viewportHeight: number;
  adjustment?: WallpaperAdjustment;
  effect?: WallpaperEffect;
}) {
  const geom = computed(() =>
    fittedGeometry(
      props.config.width,
      props.config.height,
      props.viewportWidth,
      props.viewportHeight,
      props.adjustment ?? props.config.adjustment,
    ),
  );

  return (
    <EffectSurface
      effect={props.effect ?? "none"}
      config={props.config}
      offsetX={geom().offsetX}
      offsetY={geom().offsetY}
      scaledWidth={geom().scaledWidth}
      scaledHeight={geom().scaledHeight}
    />
  );
}

/**
 * New-thread background hero rendered at the top of the chat pane
 * when on the welcome / new-thread screen, fading smoothly along its bottom edge.
 */
export function NewThreadBackground(props: { visible: boolean }) {
  const size = signal({ width: 960, height: 640 });

  const heroHeight = computed(() => {
    const h = size().height;
    return Math.max(240, Math.min(Math.round(h * HERO_VIEWPORT_RATIO), HERO_MAX_HEIGHT));
  });

  return (
    <If when={props.visible ? wallpaper() : null}>
      {(wp) => (
        <View
          class="pointer-events-none absolute inset-x-0 top-0 overflow-hidden"
          onLayout={(e) => {
            const { width, height } = e.bounds.size;
            if (width > 0 && height > 0) {
              size.set({ width, height: Math.max(height, 480) });
            }
          }}
          style={{
            height: heroHeight(),
            opacity: 0.38,
            maskImage: HERO_MASK_GRADIENT,
          }}
        >
          <CroppedWallpaperSurface
            config={wp()}
            viewportWidth={size().width}
            viewportHeight={heroHeight()}
            adjustment={wp().adjustment}
            effect={wallpaperEffect()}
          />
        </View>
      )}
    </If>
  );
}

const PREVIEW_WIDTH = 472;
const PREVIEW_HEIGHT = 295; // 16:10 aspect ratio
const ZOOM_STEP = 0.25;

/**
 * Interactive "Adjust background" modal dialog.
 *
 * Supports drag-to-pan with a rule-of-thirds composition grid overlay while dragging,
 * zoom slider / step buttons (`100%`–`400%`), Reset, Cancel, and Apply.
 */
export function WallpaperAdjustDialog(props: {
  open: boolean;
  onClose: () => void;
}) {
  const draft = signal<WallpaperAdjustment>({ ...DEFAULT_WALLPAPER_ADJUSTMENT });
  const dragging = signal(false);
  const frameSize = signal({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
  const sliderWidth = signal(220);
  let lastPointer: { x: number; y: number } | null = null;
  let wasOpen = false;

  const ensureSynced = () => {
    if (props.open && !wasOpen) {
      wasOpen = true;
      const wp = wallpaper();
      draft.set(clampAdjustment(wp?.adjustment ?? DEFAULT_WALLPAPER_ADJUSTMENT));
      dragging.set(false);
      lastPointer = null;
    } else if (!props.open && wasOpen) {
      wasOpen = false;
    }
  };

  const applyZoom = (targetZoom: number, anchorX?: number, anchorY?: number) => {
    const wp = wallpaper();
    if (!wp) return;
    const { width, height } = frameSize();
    const next = zoomAdjustmentAround(
      wp.width,
      wp.height,
      width,
      height,
      draft(),
      targetZoom,
      anchorX ?? width * 0.5,
      anchorY ?? height * 0.5,
    );
    draft.set(next);
  };

  const zoomPercent = computed(() => `${Math.round(draft().zoom * 100)}%`);
  const zoomRatio = computed(
    () => (draft().zoom - MIN_WALLPAPER_ZOOM) / (MAX_WALLPAPER_ZOOM - MIN_WALLPAPER_ZOOM),
  );

  return (
    <Dialog
      open={(ensureSynced(), props.open && Boolean(wallpaper()))}
      animation="fade"
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropClass="bg-scrim"
      backdropStyle={GLASS_SCRIM}
      class="mx-auto my-auto w-full max-w-130 px-4"
    >
      <View
        class={`gap-4 overflow-hidden p-5 ${POPUP}`}
        style={{ ...GLASS_REGULAR, ...createMotion({ enter: DIALOG_RISE }).style }}
      >
        {/* Header */}
        <View class="flex-row items-start justify-between gap-3">
          <View class="min-w-0 flex-1 gap-1">
            <Text class="text-md font-semibold text-foreground">
              {tr("Adjust background", "调整背景")}
            </Text>
            <Text class="text-xs leading-relaxed text-muted-foreground">
              {tr(
                "Drag the image to reposition it, or zoom in to frame a detail.",
                "拖动图片以调整构图位置，或缩放以聚焦局部细节。",
              )}
            </Text>
          </View>
          <IconButton
            icon="x"
            label={tr("Close", "关闭")}
            onPress={props.onClose}
          />
        </View>

        {/* Interactive 16:10 Preview Viewport */}
        <If when={wallpaper()}>
          {(wp) => (
            <View
              class="relative w-full overflow-hidden rounded-lg border border-border bg-sunken"
              style={{ height: PREVIEW_HEIGHT }}
              onLayout={(e) => {
                const { width, height } = e.bounds.size;
                if (width > 0 && height > 0) frameSize.set({ width, height });
              }}
              onPressDown={(e) => {
                dragging.set(true);
                lastPointer = { x: e.pagePosition.x, y: e.pagePosition.y };
              }}
              onMouseMove={(e) => {
                if (!dragging() || !lastPointer) return;
                if (e.pressedButton === null) {
                  dragging.set(false);
                  lastPointer = null;
                  return;
                }
                const dx = e.pagePosition.x - lastPointer.x;
                const dy = e.pagePosition.y - lastPointer.y;
                lastPointer = { x: e.pagePosition.x, y: e.pagePosition.y };
                const { width, height } = frameSize();
                draft.set(panAdjustment(wp().width, wp().height, width, height, draft(), dx, dy));
              }}
              onPressUp={() => {
                dragging.set(false);
                lastPointer = null;
              }}
            >
              <CroppedWallpaperSurface
                config={wp()}
                viewportWidth={frameSize().width}
                viewportHeight={frameSize().height}
                adjustment={draft()}
                effect={wallpaperEffect()}
              />

              {/* Rule-of-thirds composition grid shown while dragging */}
              <If when={dragging()}>
                <View class="pointer-events-none absolute inset-0">
                  <View
                    class="absolute inset-y-0 w-px bg-foreground/25"
                    style={{ left: Math.round(frameSize().width / 3) }}
                  />
                  <View
                    class="absolute inset-y-0 w-px bg-foreground/25"
                    style={{ left: Math.round((frameSize().width * 2) / 3) }}
                  />
                  <View
                    class="absolute inset-x-0 h-px bg-foreground/25"
                    style={{ top: Math.round(frameSize().height / 3) }}
                  />
                  <View
                    class="absolute inset-x-0 h-px bg-foreground/25"
                    style={{ top: Math.round((frameSize().height * 2) / 3) }}
                  />
                </View>
              </If>

              {/* Corner hint pill */}
              <View class="pointer-events-none absolute bottom-2.5 left-2.5 flex-row items-center gap-1.5 rounded-md border border-border bg-popover/85 px-2.5 py-1">
                <Text class="text-2xs font-medium text-foreground">
                  {tr("Drag to reposition", "拖动以调整位置")}
                </Text>
              </View>
            </View>
          )}
        </If>

        {/* Zoom Controls Row */}
        <View class="flex-row items-center gap-2.5">
          <Text class="w-11 text-xs font-medium text-muted-foreground">
            {tr("Zoom", "缩放")}
          </Text>

          <IconButton
            icon="minus"
            size="sm"
            label={tr("Zoom out", "缩小")}
            disabled={draft().zoom <= MIN_WALLPAPER_ZOOM + 0.001}
            onPress={() => applyZoom(draft().zoom - ZOOM_STEP)}
          />

          {/* Interactive Zoom Track */}
          <View
            accessibilityLabel={tr("Zoom level", "缩放比例")}
            class="relative h-6 flex-1 justify-center"
            onLayout={(e) => {
              const w = e.bounds.size.width;
              if (w > 0) sliderWidth.set(w);
            }}
            onPressDown={(e) => {
              const ratio = Math.max(0, Math.min(1, e.position.x / Math.max(sliderWidth(), 1)));
              const target =
                MIN_WALLPAPER_ZOOM + ratio * (MAX_WALLPAPER_ZOOM - MIN_WALLPAPER_ZOOM);
              applyZoom(Math.round(target * 20) / 20);
            }}
          >
            <View class="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <View
                class="h-full rounded-full bg-brand"
                style={{ width: `${Math.round(zoomRatio() * 100)}%` }}
              />
            </View>
          </View>

          <IconButton
            icon="plus"
            size="sm"
            label={tr("Zoom in", "放大")}
            disabled={draft().zoom >= MAX_WALLPAPER_ZOOM - 0.001}
            onPress={() => applyZoom(draft().zoom + ZOOM_STEP)}
          />

          <Text class="w-11 text-right font-mono text-xs text-muted-foreground">
            {zoomPercent()}
          </Text>
        </View>

        {/* Footer Actions */}
        <View class="flex-row items-center justify-between pt-1">
          <Button
            label={tr("Reset", "重置")}
            variant="ghost"
            size="sm"
            disabled={isDefaultAdjustment(draft())}
            onPress={() => draft.set({ ...DEFAULT_WALLPAPER_ADJUSTMENT })}
          />
          <View class="flex-row items-center gap-2">
            <Button
              label={tr("Cancel", "取消")}
              variant="secondary"
              size="md"
              onPress={props.onClose}
            />
            <Button
              label={tr("Apply", "应用")}
              variant="primary"
              size="md"
              onPress={() => {
                updateWallpaperAdjustment(draft());
                props.onClose();
              }}
            />
          </View>
        </View>
      </View>
    </Dialog>
  );
}
