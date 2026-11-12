import {
  cleanup,
  colorScheme,
  computed,
  createAnimatedValue,
  createMotion,
  effect,
  Image,
  platform,
  reduceMotion,
  ShaderEffect,
  signal,
  Text,
  token,
  untracked,
  View,
  type ImageStyle,
  type ViewStyle,
} from "nsh";
import { Button as BaseButton, Dialog } from "nsh/base";
import { tr } from "../lib/i18n";
import {
  clampAdjustment,
  DEFAULT_WALLPAPER_ADJUSTMENT,
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
import { DIALOG_RISE, EASING } from "../ui/motion";
import { GLASS_REGULAR, HEADER_GLASS, PAGE_GLASS, POPUP, SCRIM, WALLPAPER_FROST } from "../ui/styles";

// The image over-covers its frame by a few percent so a frame where the fit
// runs a resize or two behind still reaches every edge.
const WALLPAPER_OVERSCAN = 1.06;
function EffectSurface(props: {
  effect: WallpaperEffect;
  config: WallpaperConfig;
  adjustment: WallpaperAdjustment;
  alpha?: number;
}) {
  const isDark = () => colorScheme() === "dark";
  // The image lives in a fixed, intrinsic-size box and covering the frame is
  // `fittedGeometry`'s `translate`/`scale`, so a live window resize only ever
  // moves a compositor matrix. Laying the image out at its new bounds each
  // resize frame re-rasterizes it, and the frames that raster misses during a
  // fast drag read as flicker.
  const viewport = signal<{ width: number; height: number } | null>(null);
  const worldStyle = (): ViewStyle => {
    const vp = viewport();
    const { width, height } = props.config;
    if (!vp || width <= 0 || height <= 0) {
      return { position: "absolute", width: 0, height: 0 };
    }
    const s =
      Math.max(vp.width / width, vp.height / height) *
      props.adjustment.zoom *
      WALLPAPER_OVERSCAN;
    return {
      position: "absolute",
      left: 0,
      top: 0,
      width,
      height,
      opacity: props.alpha ?? 1,
      transformOrigin: "0% 0%",
      translate: [
        -Math.max(width * s - vp.width, 0) * props.adjustment.focalX,
        -Math.max(height * s - vp.height, 0) * props.adjustment.focalY,
      ],
      scale: s,
    };
  };
  const contentStyle: ImageStyle = {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    objectFit: "fill",
  };
  return (
    <View
      class="pointer-events-none absolute inset-0 overflow-hidden"
      onLayout={(e) => {
        const { width, height } = e.bounds.size;
        viewport.set({ width, height });
      }}
    >
      <View style={worldStyle()}>
        <If
          when={props.effect !== "none"}
          else={<Image src={props.config.path} style={contentStyle} />}
        >
          <ShaderEffect
            source={WALLPAPER_SHADERS[props.effect === "none" ? "dither" : props.effect]}
            uniforms={wallpaperShaderUniforms(
              props.effect === "none" ? "dither" : props.effect,
              isDark(),
            )}
            class="absolute inset-0 overflow-hidden"
          >
            <Image src={props.config.path} style={contentStyle} />
          </ShaderEffect>
        </If>
      </View>
    </View>
  );
}

/**
 * Renders the wallpaper covering its containing frame, cropped around the
 * adjustment's focal point and scaled by its zoom — `fittedGeometry` carried
 * by a transform over a fixed intrinsic-size box, so a live resize only ever
 * moves a matrix instead of re-laying the image out.
 */
export function CroppedWallpaperSurface(props: {
  config: WallpaperConfig;
  adjustment?: WallpaperAdjustment;
  effect?: WallpaperEffect;
  alpha?: number;
}) {
  const adjustment = computed(() =>
    clampAdjustment(props.adjustment ?? props.config.adjustment),
  );

  return (
    <EffectSurface
      effect={props.effect ?? "none"}
      config={props.config}
      adjustment={adjustment()}
      alpha={props.alpha}
    />
  );
}

/** The wallpaper laid once under the whole window: every region above it —
 * the sidebar's frost, the page's wash — shows the same picture, so it runs
 * on from one into the next. */
export function WallpaperUnderlay() {
  return (
    <If when={wallpaper()}>
      {(wp) => (
        <View class="pointer-events-none absolute inset-0 overflow-hidden">
          <CroppedWallpaperSurface config={wp()} effect={wallpaperEffect()} />
        </View>
      )}
    </If>
  );
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Stops of a wash from `from` to `to` (how much of the page's color covers
 * the wallpaper) between two places, eased at both ends: a linear ramp shows
 * the line where it starts and the line where it lands. */
function ramp(from: number, to: number, start: number, end: number, unit: "%" | "px", steps = 6): [string, number][] {
  const stops: [string, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stops.push([`${Math.round((start + (end - start) * t) * 10) / 10}${unit}`, from + (to - from) * smooth(t)]);
  }
  return stops;
}

/** The page's color at the stops' alphas, as a gradient's color stops. */
function tints(stops: [string, number][]): string {
  const base = String(token("background")).slice(0, 7);
  const alpha = (a: number) =>
    Math.round(Math.max(0, Math.min(1, a)) * 255)
      .toString(16)
      .padStart(2, "0");
  return stops.map(([at, a]) => `${base}${alpha(a)} ${at}`).join(", ");
}

/** A top-to-bottom gradient of the page's color at the stops' alphas. */
const wash = (stops: [string, number][]) => `linear-gradient(to bottom, ${tints(stops)})`;

/** How much of the page's color lies over the picture where it shows most. */
const THIN = 0.42;
/** The same at the pane's upper and lower edges, where the wash gathers. */
const EDGE = 0.58;

/** Under every state of the pane: the picture itself, the whole height of
 * it, and all there is while the composer stands in the middle of the pane
 * (the empty chat) with nothing at the foot to carry. So the wash is the same
 * from either edge: gathered at the top (the title bar's text) and as much at
 * the foot, thin between. */
const HERO_WASH: [string, number][] = [
  ...ramp(EDGE, THIN, 0, 14, "%", 3),
  ...ramp(THIN, EDGE, 86, 100, "%", 3),
];

/** Under what stands in the middle of the empty chat — Pip, the title, the
 * project under the composer — the wash gathers once more: a pool of the
 * page's color, densest behind them and gone well before the pane's edges. A
 * wash as thin as the empty chat's leaves a bright picture bright (dark) and a
 * dark one dark (light); words stand on the pool, and the picture keeps the
 * rest of the pane. Its middle is the figure's: just above the pane's. */
const POOL_WASH: [string, number][] = ramp(0.48, 0, 0, 100, "%", 8);
const pool = () => `radial-gradient(ellipse 40% 46% at 50% 47%, ${tints(POOL_WASH)})`;

/** The page under a composer docked at the pane's foot, over that wash: from
 * where it is thinnest, gone into the page by 72% of the pane, before the
 * composer. Over a wash of `THIN` this ramp is the page's color growing from
 * `THIN` to solid, eased the same way. */
const PAGE_WASH: [string, number][] = ramp(0, 1, 14, 72, "%", 8);

/** A conversation, over those: nothing more behind the title bar — there the
 * picture is the sidebar's frost again, one sheet of glass along the window's
 * top — and the page under it: the reading column stands on the page's own
 * color. */
const READING_WASH: [string, number][] = [...ramp(0, 0.88, 0, 240, "px", 8), ...ramp(0.88, 1, 240, 520, "px", 4).slice(1)];

const VEIL_MS = 200;

/** A layer of the veil that fades in while `on` and out after: how much of it is there, and whether any is. */
function veilLayer(on: () => boolean) {
  const initial = untracked(on);
  const mounted = signal(initial);
  const amount = createAnimatedValue(initial ? 1 : 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const show = on();
    untracked(() => {
      clearTimeout(timer);
      void amount.stop();
      if (show) {
        mounted.set(true);
        if (reduceMotion()) amount.set(1);
        else void amount.timing(1, { duration: VEIL_MS, easing: EASING.out });
      } else if (mounted()) {
        if (reduceMotion()) {
          amount.set(0);
          mounted.set(false);
        } else {
          void amount.timing(0, { duration: VEIL_MS, easing: EASING.out });
          timer = setTimeout(() => mounted.set(false), VEIL_MS + 10);
        }
      }
    });
  });
  cleanup(() => {
    clearTimeout(timer);
    void amount.stop();
  });
  return { mounted, amount };
}

/**
 * What the main pane lays over the wallpaper, in place of a fill of its own.
 * It follows where the composer stands and whether there is anything to read:
 *
 * - The composer in the middle of the pane (the empty chat): the picture, the
 *   whole height of the pane, under a thin wash the same from either edge,
 *   and a pool of the page's color under the figure in the middle.
 * - The composer docked at the foot (`docked`): the page gathers there
 *   instead, solid before the composer.
 * - A conversation (`reading`): over that, frosted like the sidebar along the
 *   top and gone into the page below.
 *
 * The first wash stays under the others, which fade in over it: two layers
 * cross-fading would each be half there midway and let the picture through
 * where both are solid. Only the pool leaves as the page comes — it lies where
 * the page ends up all but solid, so nothing shows through on the way. The
 * pane's content dims and lands above them, so a session change never blinks
 * the picture. Where no backdrop filter draws, a conversation gets the solid page.
 */
export function PaneVeil(props: { docked: boolean; reading: boolean }) {
  const page = veilLayer(() => props.docked);
  const read = veilLayer(() => props.reading);
  return (
    <If when={wallpaper()}>
      <View class="pointer-events-none absolute inset-0" style={{ backgroundImage: wash(HERO_WASH) }} />
      <View
        class="pointer-events-none absolute inset-0"
        style={{ backgroundImage: pool(), opacity: page.amount.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}
      />
      <If when={page.mounted()}>
        <View class="pointer-events-none absolute inset-0" style={{ backgroundImage: wash(PAGE_WASH), opacity: page.amount }} />
      </If>
      <If when={read.mounted()}>
        <If
          when={WALLPAPER_FROST}
          else={<View class="pointer-events-none absolute inset-0 bg-background" style={{ opacity: read.amount }} />}
        >
          <View
            class="pointer-events-none absolute inset-0"
            style={{ ...PAGE_GLASS, backgroundImage: wash(READING_WASH), opacity: read.amount }}
          />
        </If>
      </If>
    </If>
  );
}

/** Where no mask draws (Windows), a conversation's rows do not fade out under
 * the title bar: there it keeps its band over a wallpaper too, the usual glass. */
const HEADER_BAND = platform.os === "windows";

export function HeaderBand(props: { show: boolean; height: number }) {
  return (
    <If when={HEADER_BAND && props.show && wallpaper()}>
      <View
        class={`pointer-events-none absolute inset-x-0 top-0 ${HEADER_GLASS}`}
        style={{ ...GLASS_REGULAR, height: props.height }}
      />
    </If>
  );
}

const PREVIEW_WIDTH = 472;
const PREVIEW_HEIGHT = 295; // 16:10 aspect ratio
const ZOOM_STEP = 0.25;

/**
 * Interactive "Adjust wallpaper" modal dialog.
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
      backdropClass={SCRIM}
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
              {tr("Adjust wallpaper", "调整壁纸")}
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
