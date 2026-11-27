import * as fs from "fs/promises";
import { AudioPlayer, cleanup, context, effect, Image, openUrl, platform, signal, Text, untracked, Video, View, windowSize, type VideoRef } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Menu } from "nsh/desktop";
import { compactPath, tildePath } from "../lib/format";
import { tr } from "../lib/i18n";
import { fitImageBox, imageSizeFromBase64, type ImageDimensions } from "../lib/image-size";
import {
  collectTranscriptImages,
  extensionLabel,
  findMediaImageIndex,
  formatBytes,
  formatMediaDuration,
  isPreviewableImage,
  type MediaItem,
  type MediaKind,
} from "../lib/media";
import { copyText, openLocalFile, revealLocalFile, transcriptRows, workspacePath } from "../store/app";
import { backend } from "../store/backend";
import { IconButton } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { FOCUS_RING, GLASS_REGULAR, HOVER_REVEAL, PRESS, PRESS_SCALE } from "../ui/styles";
import { tip } from "../ui/Tip";
import { uiType } from "../ui/typography";
import { closeZoom, isZoomOpen, openZoom } from "../ui/Zoom";
import { ZoomImage, type ZoomGalleryEntry } from "./ZoomImage";

/**
 * The enclosing conversation's ordered previewable image stream, plus whether
 * its lightboxes use that stream at all. Normal sessions do: opening any photo
 * lets `←` / `→` step across neighboring photos. A personal agent instead
 * keeps each lightbox inside the clicked message or presented-file group — a
 * long-running companionship never becomes one endless filmstrip.
 */
export interface MediaStreamScope {
  images: () => readonly MediaItem[];
  isolateGroups?: () => boolean;
}

export const MediaStreamContext = context<MediaStreamScope | undefined>(undefined);

// ── File probe cache & single-playback coordination ───────────────────────────

interface FileProbe {
  exists: boolean;
  size?: number;
  width?: number;
  height?: number;
}

const fileProbes = new Map<string, FileProbe>();
const probingPaths = new Set<string>();
const probeTick = signal(0);

/** True once a local file path has been probed and confirmed absent on disk. */
export function isKnownMissingPath(filePath: string): boolean {
  return fileProbes.get(filePath)?.exists === false;
}

/** Active inline playback item id so starting one video/audio pauses any sibling player. */
const activePlaybackId = signal<string | undefined>(undefined);

function useFileProbe(filePath: () => string | undefined, wantImageSize: () => boolean): () => FileProbe | undefined {
  effect(() => {
    const target = filePath();
    const wantDims = wantImageSize();
    if (!target) return;
    const cached = fileProbes.get(target);
    if (cached && (!wantDims || !cached.exists || cached.width !== undefined)) return;
    if (probingPaths.has(target)) return;
    probingPaths.add(target);
    void (async () => {
      try {
        const st = await fs.stat(target).catch(() => undefined);
        if (!st || !st.isFile()) {
          fileProbes.set(target, { exists: false });
          return;
        }
        let dims: { width: number; height: number } | undefined;
        if (wantDims) {
          dims = await Image.getSize(target).catch(() => undefined);
        }
        fileProbes.set(target, {
          exists: true,
          size: st.size,
          ...(dims && dims.width > 0 && dims.height > 0 ? { width: dims.width, height: dims.height } : {}),
        });
      } finally {
        probingPaths.delete(target);
        probeTick.update((n) => n + 1);
      }
    })();
  });
  return () => {
    probeTick();
    const target = filePath();
    return target ? fileProbes.get(target) : undefined;
  };
}

function kindIcon(kind: MediaKind): IconName {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (kind === "archive") return "archive";
  return "file";
}

function revealLabel(): string {
  return platform.os === "macos" ? tr("Show in Finder", "在访达中显示") : tr("Show in File Manager", "在文件管理器中显示");
}

function remoteHost(url?: string): string {
  if (!url) return "";
  const hit = /^https?:\/\/([^/]+)/i.exec(url);
  return hit ? hit[1] : url;
}

function openMediaItem(item: MediaItem) {
  if (item.path) void openLocalFile(item.path);
  else if (item.remoteUrl) void openUrl(item.remoteUrl);
}

function showMediaPopup(item: MediaItem, pos: { x: number; y: number }, canZoom = false, zoomOptions?: MediaZoomOptions) {
  const entries = [
    ...(canZoom ? [{ label: tr("Preview", "预览"), onSelect: () => openMediaZoom(item, zoomOptions) }] : []),
    ...(item.path ? [{ label: tr("Open", "打开"), onSelect: () => void openLocalFile(item.path!) }] : []),
    ...(item.path ? [{ label: revealLabel(), onSelect: () => void revealLocalFile(item.path!) }] : []),
    ...(item.remoteUrl ? [{ label: tr("Open Link", "打开链接"), onSelect: () => void openUrl(item.remoteUrl!) }] : []),
    ...(item.path ? [{ label: tr("Copy Path", "复制路径"), onSelect: () => void copyText(item.path!) }] : []),
    ...(item.remoteUrl ? [{ label: tr("Copy Link", "复制链接"), onSelect: () => void copyText(item.remoteUrl!) }] : []),
  ];
  if (entries.length) Menu.popup(entries, pos);
}

// ── Zoom Layer Preview (Images & Video) ───────────────────────────────────────

export interface MediaZoomOptions {
  startAtSeconds?: number;
  /** Primary ordered image gallery (typically the conversation's full photo stream). */
  gallery?: readonly MediaItem[];
  /** Local sibling gallery fallback when the clicked item isn't in `gallery`. */
  fallbackGallery?: readonly MediaItem[];
}

/**
 * Resolves the gallery a clicked image belongs to. The stream remains primary
 * in ordinary coding sessions; an isolated scope (Personal Agent) makes the
 * clicked item's own siblings the whole gallery, with an empty array standing
 * for "just this one" rather than asking for the transcript fallback.
 */
export function mediaZoomOptions(scope: MediaStreamScope | undefined, siblings?: readonly MediaItem[]): MediaZoomOptions {
  if (scope?.isolateGroups?.()) return { gallery: siblings ?? [] };
  return { gallery: scope?.images(), fallbackGallery: siblings };
}

function mediaImageSrc(item: MediaItem): string | undefined {
  return item.src ?? (item.data ? `data:${item.mimeType ?? "image/png"};base64,${item.data}` : undefined);
}

function ZoomActions(props: { item: MediaItem }) {
  return (
    <If when={props.item.path || props.item.remoteUrl}>
      <View class="flex-row items-center gap-1">
        <IconButton
          icon="external"
          size="sm"
          label={tr("Open", "打开")}
          onPress={() => openMediaItem(props.item)}
        />
        <If when={props.item.path}>
          {(p) => (
            <IconButton
              icon="folder"
              size="sm"
              label={revealLabel()}
              onPress={() => void revealLocalFile(p())}
            />
          )}
        </If>
      </View>
    </If>
  );
}

function ZoomVideoPlayer(props: { src: string; title: string; startAt?: number; natural?: ImageDimensions }) {
  const paused = signal(false);
  const dims = signal<ImageDimensions | undefined>(props.natural);
  const win = untracked(windowSize);
  const topPad = platform.os === "macos" ? 44 : 12;
  const stage = signal<ImageDimensions>({
    width: Math.max(360, (win.width || 1120) - 24),
    height: Math.max(240, (win.height || 820) - topPad - 12 - 44),
  });
  let videoRef: VideoRef | undefined;
  let sought = false;
  const box = () => {
    const s = stage();
    const maxWidth = Math.max(320, Math.floor(s.width - 36));
    const maxHeight = Math.max(200, Math.floor(s.height - 28));
    return fitImageBox(dims(), {
      maxWidth,
      maxHeight,
      minWidth: Math.min(360, maxWidth),
      minHeight: Math.min(200, maxHeight),
      fallback: { width: Math.min(maxWidth, 960), height: Math.min(maxHeight, 540) },
      upscale: false,
    });
  };

  return (
    <View
      class="size-full items-center justify-center bg-sunken/55"
      onLayout={(e) => {
        const w = Math.round(e.bounds.size.width);
        const h = Math.round(e.bounds.size.height);
        if (w > 0 && h > 0) stage.set({ width: w, height: h });
      }}
    >
      <View class="overflow-hidden rounded-xl corner-squircle border-[0.5px] border-hairline-hover bg-sunken shadow-sm" style={{ width: box().width, height: box().height }}>
        <Video
          ref={(r) => {
            videoRef = r;
          }}
          src={props.src}
          controls
          paused={paused() || !isZoomOpen()}
          audioSession="playback"
          class="size-full"
          style={{ width: box().width, height: box().height }}
          onLoad={(e) => {
            if (e.size.width > 0 && e.size.height > 0) dims.set({ width: e.size.width, height: e.size.height });
            if (!sought && props.startAt && props.startAt > 0.25) {
              sought = true;
              videoRef?.seek(props.startAt);
            }
          }}
          onEnd={() => paused.set(true)}
        />
      </View>
    </View>
  );
}

function resolveGallery(item: MediaItem, options?: MediaZoomOptions): { items: MediaItem[]; index: number } {
  const filterPreviewable = (list?: readonly MediaItem[]) =>
    (list ?? []).filter((entry) => isPreviewableImage(entry, isKnownMissingPath) && Boolean(mediaImageSrc(entry)));

  const candidates: readonly (readonly MediaItem[] | undefined)[] = [
    options?.gallery,
    options?.fallbackGallery,
    options?.gallery === undefined && options?.fallbackGallery === undefined
      ? collectTranscriptImages(untracked(transcriptRows), {
          cwd: untracked(workspacePath),
          home: backend().home(),
          isMissingPath: isKnownMissingPath,
        })
      : undefined,
  ];

  for (const list of candidates) {
    const valid = filterPreviewable(list);
    if (!valid.length) continue;
    const hit = findMediaImageIndex(valid, item);
    if (hit >= 0) return { items: valid, index: hit };
  }
  return { items: [item], index: 0 };
}

function ZoomImageStage(props: {
  items: readonly MediaItem[];
  activeIndex: () => number;
  setIndex: (index: number) => void;
  natural: () => ImageDimensions | undefined;
  onMeasureNatural: (dims: ImageDimensions) => void;
}) {
  const current = () => props.items[props.activeIndex()] ?? props.items[0];
  // Probe on-disk size/dimensions for whichever stream photo is currently shown (even if scrolled off-screen earlier).
  useFileProbe(
    () => current().path,
    () => Boolean(current().path),
  );
  const galleryEntries: ZoomGalleryEntry[] = props.items.map((entry, idx) => ({
    id: `${idx}:${entry.id}`,
    src: mediaImageSrc(entry) ?? "",
    title: entry.title,
  }));

  const step = (delta: number) => {
    const next = props.activeIndex() + delta;
    if (next < 0 || next >= props.items.length) return;
    props.setIndex(next);
  };

  return (
    <ZoomImage
      src={mediaImageSrc(current()) ?? ""}
      title={current().title}
      natural={props.natural()}
      gallery={galleryEntries}
      activeIndex={props.activeIndex()}
      canPrev={props.activeIndex() > 0}
      canNext={props.activeIndex() < props.items.length - 1}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      onSelectIndex={(idx) => {
        if (idx >= 0 && idx < props.items.length) props.setIndex(idx);
      }}
      onMeasureNatural={props.onMeasureNatural}
      onClose={closeZoom}
    />
  );
}

export function openMediaZoom(item: MediaItem, startOrOptions?: number | MediaZoomOptions) {
  const options: MediaZoomOptions | undefined =
    typeof startOrOptions === "number" ? { startAtSeconds: startOrOptions } : startOrOptions;
  activePlaybackId.set(undefined);
  if (item.kind === "video" && item.src && !item.remoteUrl) {
    const sizeText = formatBytes(item.size ?? (item.path ? fileProbes.get(item.path)?.size : undefined));
    openZoom({
      layout: "stage",
      title: item.title,
      subtitle: sizeText || undefined,
      actions: () => <ZoomActions item={item} />,
      render: () => (
        <ZoomVideoPlayer
          src={item.src!}
          title={item.title}
          startAt={options?.startAtSeconds}
          natural={item.width && item.height ? { width: item.width, height: item.height } : undefined}
        />
      ),
    });
    return;
  }

  const src = mediaImageSrc(item);
  if (!src) {
    openMediaItem(item);
    return;
  }

  const { items, index: initialIndex } = resolveGallery(item, options);
  const activeIndex = signal(initialIndex);
  const measuredDims = signal<Record<string, ImageDimensions>>({});

  const current = () => items[activeIndex()] ?? items[0];
  const currentKey = () => `${activeIndex()}:${mediaImageSrc(current()) ?? current().id}`;
  const currentProbe = () => {
    probeTick();
    const p = current().path;
    return p ? fileProbes.get(p) : undefined;
  };
  const currentNatural = (): ImageDimensions | undefined => {
    const it = current();
    if (it.width && it.height) return { width: it.width, height: it.height };
    const p = currentProbe();
    if (p?.width && p?.height) return { width: p.width, height: p.height };
    if (it.data) {
      const parsed = imageSizeFromBase64({ data: it.data, mimeType: it.mimeType ?? "image/png" });
      if (parsed) return parsed;
    }
    return measuredDims()[currentKey()];
  };

  openZoom({
    layout: "stage",
    badge: () => (items.length > 1 ? `${activeIndex() + 1} / ${items.length}` : undefined),
    title: () => current().title,
    subtitle: () => {
      const it = current();
      const p = currentProbe();
      const nat = currentNatural();
      const sizeText = formatBytes(it.size ?? p?.size);
      const dimText = nat ? `${nat.width} × ${nat.height}` : "";
      return [dimText, sizeText].filter(Boolean).join(" · ") || undefined;
    },
    actions: () => <ZoomActions item={current()} />,
    render: () => (
      <ZoomImageStage
        items={items}
        activeIndex={activeIndex}
        setIndex={(idx) => activeIndex.set(idx)}
        natural={currentNatural}
        onMeasureNatural={(dims) => {
          const key = untracked(currentKey);
          const prev = untracked(measuredDims)[key];
          if (prev && prev.width === dims.width && prev.height === dims.height) return;
          measuredDims.update((map) => ({ ...map, [key]: dims }));
        }}
      />
    ),
  });
}

// ── File / Document / Fallback Card ───────────────────────────────────────────

export function InlineFileCard(props: { item: MediaItem; compact?: boolean; statusNote?: string }) {
  const probe = useFileProbe(() => props.item.path, () => false);
  const home = backend().home();
  const isMissing = () => props.item.missing === true || (props.item.path !== undefined && probe()?.exists === false);
  const byteSize = () => props.item.size ?? probe()?.size;
  const ext = () => extensionLabel(props.item.path ?? props.item.remoteUrl ?? props.item.title, props.item.mimeType);
  const metaText = () => {
    const parts: string[] = [ext()];
    if (isMissing()) parts.push(tr("File not found", "文件不存在"));
    else if (props.statusNote) parts.push(props.statusNote);
    else {
      const sz = formatBytes(byteSize());
      if (sz) parts.push(sz);
      if (props.item.path) parts.push(compactPath(tildePath(props.item.path, home), props.compact ? 26 : 38));
      else if (props.item.remoteUrl) parts.push(remoteHost(props.item.remoteUrl));
    }
    return parts.filter(Boolean).join(" · ");
  };

  return (
    <View
      testID="media-file-card"
      class={`group flex-row items-center overflow-hidden rounded-xl corner-squircle border border-border bg-card ${
        props.compact ? "max-w-88" : "w-full max-w-120"
      }`}
      onContextMenu={(e: { pagePosition: { x: number; y: number } }) => showMediaPopup(props.item, e.pagePosition)}
    >
      <BaseButton
        onPress={() => openMediaItem(props.item)}
        disabled={isMissing()}
        accessibilityLabel={props.item.title}
        tooltip={tip(props.item.path ? tildePath(props.item.path, home) : props.item.remoteUrl ?? props.item.title)}
        class={`min-w-0 flex-1 flex-row items-center gap-2.5 px-2.5 py-2 ${PRESS} ${FOCUS_RING} hover:bg-accent/45 disabled:opacity-65`}
      >
        <View class={`size-9 shrink-0 items-center justify-center rounded-lg corner-squircle ${isMissing() ? "bg-destructive/10" : "bg-muted"}`}>
          <Icon name={kindIcon(props.item.kind)} size={16} tone={isMissing() ? "destructive" : "muted-foreground"} />
        </View>
        <View class="min-w-0 flex-1">
          <Text class={`truncate ${uiType("sm")} font-medium text-foreground`}>{props.item.title}</Text>
          <Text class={`truncate ${uiType("xs")} tabular-nums ${isMissing() ? "text-destructive" : "text-subtle"}`}>{metaText()}</Text>
        </View>
      </BaseButton>
      <If when={!isMissing() && (props.item.path || props.item.remoteUrl)}>
        <View class="shrink-0 flex-row items-center gap-0.5 pr-2">
          <IconButton
            icon="external"
            size="sm"
            label={tr("Open", "打开")}
            onPress={() => openMediaItem(props.item)}
          />
          <If when={props.item.path}>
            {(p) => (
              <IconButton
                icon="folder"
                size="sm"
                label={revealLabel()}
                onPress={() => void revealLocalFile(p())}
              />
            )}
          </If>
        </View>
      </If>
    </View>
  );
}

// ── Inline Image Card ─────────────────────────────────────────────────────────

export function InlineImageCard(props: {
  item: MediaItem;
  gallery?: boolean;
  compact?: boolean;
  siblings?: readonly MediaItem[];
}) {
  const stream = MediaStreamContext();
  const zoomOptions = (): MediaZoomOptions => mediaZoomOptions(stream, props.siblings);
  const src = () => props.item.src ?? (props.item.data ? `data:${props.item.mimeType ?? "image/png"};base64,${props.item.data}` : undefined);
  const probe = useFileProbe(
    () => props.item.path,
    () => Boolean(props.item.path && !(props.item.width && props.item.height)),
  );
  const loadedDims = signal<ImageDimensions | undefined>(undefined);
  const errored = signal(false);
  let trackedSrc = untracked(src);

  effect(() => {
    const next = src();
    if (next !== trackedSrc) {
      trackedSrc = next;
      untracked(() => {
        loadedDims.set(undefined);
        errored.set(false);
      });
    }
  });

  const isMissing = () => props.item.missing === true || (props.item.path !== undefined && probe()?.exists === false);
  const canRenderNative = () => Boolean(src()) && !props.item.remoteUrl && !isMissing() && !errored();

  const box = (): ImageDimensions => {
    if (props.compact) return { width: 144, height: 108 };
    if (props.gallery) return { width: 224, height: 152 };
    const p = probe();
    const natural =
      loadedDims() ??
      (props.item.width && props.item.height ? { width: props.item.width, height: props.item.height } : undefined) ??
      (p?.width && p?.height ? { width: p.width, height: p.height } : undefined) ??
      (props.item.data ? imageSizeFromBase64({ data: props.item.data, mimeType: props.item.mimeType ?? "image/png" }) : undefined);
    return fitImageBox(natural, {
      maxWidth: 520,
      maxHeight: 340,
      minWidth: 120,
      minHeight: 84,
      fallback: { width: 320, height: 210 },
      upscale: false,
    });
  };

  return (
    <If when={canRenderNative()} else={<InlineFileCard item={props.item} compact={props.compact} statusNote={errored() ? tr("Cannot preview", "无法预览") : undefined} />}>
      <View
        testID="media-image-card"
        class="group relative self-start overflow-hidden rounded-xl corner-squircle bg-sunken"
        style={{ width: box().width, height: box().height }}
        onContextMenu={(e: { pagePosition: { x: number; y: number } }) => showMediaPopup(props.item, e.pagePosition, true, zoomOptions())}
      >
        <BaseButton
          onPress={() => openMediaZoom(props.item, zoomOptions())}
          accessibilityLabel={props.item.title || tr("Preview image", "预览图片")}
          tooltip={tip(props.item.caption || props.item.title || tr("Preview image", "预览图片"))}
          class={`size-full ${PRESS} ${FOCUS_RING}`}
        >
          <Image
            src={src()!}
            class="size-full"
            style={{ objectFit: props.gallery || props.compact ? "cover" : "contain" }}
            accessibilityLabel={props.item.title}
            onLoad={(e) => {
              if (e.size.width > 0 && e.size.height > 0) loadedDims.set({ width: e.size.width, height: e.size.height });
            }}
            onError={() => errored.set(true)}
          />
        </BaseButton>
        <View class="pointer-events-none absolute inset-0 rounded-xl corner-squircle border-[0.5px] border-hairline-hover" />
        <View class={`absolute right-1.5 top-1.5 flex-row items-center gap-1 ${HOVER_REVEAL}`}>
          <IconButton
            icon="expand"
            size="sm"
            label={tr("Expand", "放大")}
            class="border-[0.5px] border-hairline-hover bg-popover/90 shadow-sm"
            onPress={() => openMediaZoom(props.item, zoomOptions())}
          />
          <If when={props.item.path}>
            {(p) => (
              <IconButton
                icon="folder"
                size="sm"
                label={revealLabel()}
                class="border-[0.5px] border-hairline-hover bg-popover/90 shadow-sm"
                onPress={() => void revealLocalFile(p())}
              />
            )}
          </If>
        </View>
      </View>
    </If>
  );
}

// ── Inline Video Card & Player ────────────────────────────────────────────────

export function InlineVideoCard(props: { item: MediaItem; compact?: boolean }) {
  const src = () => props.item.src;
  const probe = useFileProbe(() => props.item.path, () => false);
  const paused = signal(true);
  const muted = signal(false);
  const duration = signal(0);
  const currentTime = signal(0);
  const videoDims = signal<ImageDimensions | undefined>(
    props.item.width && props.item.height ? { width: props.item.width, height: props.item.height } : undefined,
  );
  const errored = signal(false);
  const scrubWidth = signal(0);
  let videoRef: VideoRef | undefined;
  let trackedSrc = untracked(src);

  effect(() => {
    const nextSrc = src();
    if (nextSrc !== trackedSrc) {
      trackedSrc = nextSrc;
      untracked(() => {
        if (activePlaybackId() === props.item.id) activePlaybackId.set(undefined);
        paused.set(true);
        duration.set(0);
        currentTime.set(0);
        videoDims.set(props.item.width && props.item.height ? { width: props.item.width, height: props.item.height } : undefined);
        errored.set(false);
        videoRef = undefined;
      });
    }
  });

  // Pause automatically if another inline player or the zoom layer takes over.
  effect(() => {
    const active = activePlaybackId();
    if (active !== props.item.id && !untracked(paused)) {
      untracked(() => paused.set(true));
    }
  });

  cleanup(() => {
    if (untracked(activePlaybackId) === props.item.id) activePlaybackId.set(undefined);
  });

  const isMissing = () => props.item.missing === true || (props.item.path !== undefined && probe()?.exists === false);
  const canRenderNative = () => Boolean(src()) && !props.item.remoteUrl && !isMissing() && !errored();

  const frameBox = () =>
    props.compact
      ? { width: 224, height: 126 }
      : fitImageBox(videoDims(), {
          maxWidth: 520,
          maxHeight: 320,
          minWidth: 260,
          minHeight: 156,
          fallback: { width: 440, height: 248 },
          upscale: false,
        });

  const togglePlay = () => {
    if (paused()) {
      activePlaybackId.set(props.item.id);
      paused.set(false);
    } else {
      paused.set(true);
      if (activePlaybackId() === props.item.id) activePlaybackId.set(undefined);
    }
  };

  const progress = () => (duration() > 0 ? Math.min(1, Math.max(0, currentTime() / duration())) : 0);
  const sizeLabel = () => formatBytes(props.item.size ?? probe()?.size);

  if (props.compact) {
    return (
      <If when={canRenderNative()} else={<InlineFileCard item={props.item} compact statusNote={errored() ? tr("Cannot play", "无法播放") : undefined} />}>
        <View
          testID="media-video-card"
          class="group overflow-hidden rounded-xl corner-squircle border border-border bg-card"
          style={{ width: frameBox().width }}
          onContextMenu={(e: { pagePosition: { x: number; y: number } }) => showMediaPopup(props.item, e.pagePosition, true)}
        >
          <BaseButton
            onPress={() => openMediaZoom(props.item)}
            accessibilityLabel={props.item.title}
            tooltip={tip(tr("Play video", "播放视频"))}
            class={`relative w-full bg-sunken ${PRESS} ${FOCUS_RING}`}
            style={{ height: frameBox().height }}
          >
            <Each of={[src()!]} key={(s) => s}>
              {(videoSrc) => (
                <Video
                  src={videoSrc()}
                  paused
                  muted
                  style={{ width: frameBox().width, height: frameBox().height }}
                  onError={() => errored.set(true)}
                />
              )}
            </Each>
            <View class="pointer-events-none absolute inset-0 items-center justify-center">
              <View class="size-9 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover/85 shadow-sm" style={GLASS_REGULAR}>
                <Icon name="play" size={14} tone="foreground" />
              </View>
            </View>
          </BaseButton>
          <View class="flex-row items-center gap-1.5 px-2.5 py-1.5">
            <Icon name="video" size={13} tone="muted-foreground" class="shrink-0" />
            <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} font-medium text-foreground`}>{props.item.title}</Text>
            <If when={sizeLabel()}>
              {(sz) => <Text class={`shrink-0 ${uiType("2xs")} tabular-nums text-subtle`}>{sz()}</Text>}
            </If>
          </View>
        </View>
      </If>
    );
  }

  return (
    <If when={canRenderNative()} else={<InlineFileCard item={props.item} statusNote={errored() ? tr("Cannot play", "无法播放") : undefined} />}>
      <View
        testID="media-video-card"
        class="group overflow-hidden rounded-xl corner-squircle border border-border bg-card"
        style={{ width: frameBox().width }}
        onContextMenu={(e: { pagePosition: { x: number; y: number } }) => showMediaPopup(props.item, e.pagePosition, true)}
      >
        <View class="relative w-full bg-sunken" style={{ height: frameBox().height }}>
          <Each of={[src()!]} key={(s) => s}>
            {(videoSrc) => (
              <Video
                ref={(r) => {
                  videoRef = r;
                }}
                src={videoSrc()}
                paused={paused()}
                muted={muted()}
                progressUpdateInterval={200}
                audioSession="playback"
                style={{ width: frameBox().width, height: frameBox().height }}
                onLoadStart={() => {
                  duration.set(0);
                  currentTime.set(0);
                }}
                onLoad={(e) => {
                  if (e.duration > 0) duration.set(e.duration);
                  if (e.size.width > 0 && e.size.height > 0) videoDims.set({ width: e.size.width, height: e.size.height });
                }}
                onProgress={(e) => {
                  currentTime.set(e.currentTime);
                  if (e.duration > 0) duration.set(e.duration);
                }}
                onEnd={() => {
                  paused.set(true);
                  currentTime.set(0);
                  videoRef?.seek(0);
                  if (activePlaybackId() === props.item.id) activePlaybackId.set(undefined);
                }}
                onError={() => errored.set(true)}
              />
            )}
          </Each>
          <BaseButton
            onPress={togglePlay}
            accessibilityLabel={paused() ? tr("Play video", "播放视频") : tr("Pause video", "暂停视频")}
            class="absolute inset-0 items-center justify-center"
          >
            <If when={paused()}>
              <View class={`size-11 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover/85 shadow-sm ${PRESS_SCALE}`} style={GLASS_REGULAR}>
                <Icon name="play" size={18} tone="foreground" />
              </View>
            </If>
          </BaseButton>
        </View>
        {/* Quiet sunken control bar beneath the video frame so controls never cover video pixels. */}
        <View class="gap-1.5 border-t border-border bg-sunken/70 px-2.5 py-2">
          <View class="flex-row items-center gap-2">
            <IconButton
              icon={paused() ? "play" : "pause"}
              size="sm"
              label={paused() ? tr("Play", "播放") : tr("Pause", "暂停")}
              onPress={togglePlay}
            />
            <Text class={`shrink-0 ${uiType("xs")} tabular-nums text-muted-foreground`}>
              {`${formatMediaDuration(currentTime())} / ${formatMediaDuration(duration())}`}
            </Text>
            <View
              role="adjustable"
              onLayout={(e) => scrubWidth.set(e.bounds.size.width)}
              onPressDown={(e) => {
                const dur = duration();
                const w = scrubWidth();
                if (dur <= 0 || w <= 0) return;
                const ratio = Math.max(0, Math.min(1, e.position.x / w));
                const nextSec = dur * ratio;
                currentTime.set(nextSec);
                videoRef?.seek(nextSec);
              }}
              accessibilityLabel={tr("Seek video", "调整播放进度")}
              class="h-4 flex-1 justify-center"
            >
              <View class="h-1.5 w-full overflow-hidden rounded-full bg-input">
                <View class="h-full rounded-full bg-brand" style={{ width: `${Math.round(progress() * 1000) / 10}%` }} />
              </View>
            </View>
            <IconButton
              icon={muted() ? "volumeOff" : "volume"}
              size="sm"
              label={muted() ? tr("Unmute", "取消静音") : tr("Mute", "静音")}
              onPress={() => muted.update((v) => !v)}
            />
            <IconButton
              icon="expand"
              size="sm"
              label={tr("Expand", "放大")}
              onPress={() => {
                paused.set(true);
                openMediaZoom(props.item, currentTime());
              }}
            />
            <If when={props.item.path}>
              {(p) => (
                <IconButton
                  icon="folder"
                  size="sm"
                  label={revealLabel()}
                  onPress={() => void revealLocalFile(p())}
                />
              )}
            </If>
          </View>
          <View class="flex-row items-center gap-2 px-1">
            <Text class={`min-w-0 flex-1 truncate ${uiType("xs")} font-medium text-foreground`}>{props.item.title}</Text>
            <If when={sizeLabel()}>
              {(sz) => <Text class={`shrink-0 ${uiType("2xs")} tabular-nums text-subtle`}>{sz()}</Text>}
            </If>
          </View>
        </View>
      </View>
    </If>
  );
}

// ── Inline Audio Player Card ──────────────────────────────────────────────────

export function InlineAudioCard(props: { item: MediaItem; compact?: boolean }) {
  const probe = useFileProbe(() => props.item.path, () => false);
  const playing = signal(false);
  const currentTime = signal(0);
  const duration = signal(0);
  const failed = signal(false);
  const barWidth = signal(0);
  let player: AudioPlayer | undefined;
  let playerSrc: string | undefined;
  let trackedSrc = untracked(() => props.item.src);

  const isMissing = () => props.item.missing === true || (props.item.path !== undefined && probe()?.exists === false);
  const canPlay = () => Boolean(props.item.src) && !props.item.remoteUrl && !isMissing() && !failed();

  const disposePlayer = () => {
    if (player) {
      try {
        player.dispose();
      } catch {}
      player = undefined;
      playerSrc = undefined;
    }
  };

  effect(() => {
    const active = activePlaybackId();
    if (active !== props.item.id && untracked(playing)) {
      untracked(() => {
        playing.set(false);
        try {
          player?.pause();
        } catch {}
      });
    }
  });

  effect(() => {
    const nextSrc = props.item.src;
    if (nextSrc !== trackedSrc || (player && nextSrc !== playerSrc)) {
      trackedSrc = nextSrc;
      untracked(() => {
        if (activePlaybackId() === props.item.id) activePlaybackId.set(undefined);
        disposePlayer();
        playing.set(false);
        currentTime.set(0);
        duration.set(0);
        failed.set(false);
      });
    }
  });

  cleanup(() => {
    disposePlayer();
    if (untracked(activePlaybackId) === props.item.id) activePlaybackId.set(undefined);
  });

  const togglePlay = () => {
    const src = props.item.src;
    if (!src) return;
    if (!player) {
      try {
        const next = new AudioPlayer(src);
        player = next;
        playerSrc = src;
        next.on("load", (e) => {
          if (Number.isFinite(e.duration) && e.duration > 0) duration.set(e.duration);
        });
        next.on("progress", (e) => {
          currentTime.set(e.currentTime);
          if (Number.isFinite(e.duration) && e.duration > 0) duration.set(e.duration);
        });
        next.on("end", () => {
          playing.set(false);
          currentTime.set(0);
          if (activePlaybackId() === props.item.id) activePlaybackId.set(undefined);
        });
        next.on("error", () => {
          playing.set(false);
          failed.set(true);
          disposePlayer();
        });
      } catch {
        failed.set(true);
        if (props.item.path) void openLocalFile(props.item.path);
        return;
      }
    }

    if (playing()) {
      playing.set(false);
      player.pause();
      if (activePlaybackId() === props.item.id) activePlaybackId.set(undefined);
    } else {
      activePlaybackId.set(props.item.id);
      playing.set(true);
      void player.play().catch(() => {
        playing.set(false);
        failed.set(true);
        disposePlayer();
      });
    }
  };

  const sizeText = () => formatBytes(props.item.size ?? probe()?.size);
  const progress = () => (duration() > 0 ? Math.min(1, Math.max(0, currentTime() / duration())) : 0);

  return (
    <If when={canPlay()} else={<InlineFileCard item={props.item} compact={props.compact} statusNote={failed() ? tr("Open externally", "使用外部应用打开") : undefined} />}>
      <View
        testID="media-audio-card"
        class={`flex-row items-center gap-2.5 rounded-xl corner-squircle border border-border bg-card px-3 py-2.5 ${
          props.compact ? "max-w-88" : "w-full max-w-110"
        }`}
        onContextMenu={(e: { pagePosition: { x: number; y: number } }) => showMediaPopup(props.item, e.pagePosition)}
      >
        <BaseButton
          onPress={togglePlay}
          accessibilityLabel={playing() ? tr("Pause audio", "暂停音频") : tr("Play audio", "播放音频")}
          class={`size-8 shrink-0 items-center justify-center rounded-full bg-secondary ${PRESS} ${PRESS_SCALE} ${FOCUS_RING} hover:bg-accent`}
        >
          <Icon name={playing() ? "pause" : "play"} size={14} tone="foreground" />
        </BaseButton>
        <View class="min-w-0 flex-1 gap-1">
          <View class="flex-row items-baseline justify-between gap-2">
            <Text class={`min-w-0 flex-1 truncate ${uiType("sm")} font-medium text-foreground`}>{props.item.title}</Text>
            <Text class={`shrink-0 ${uiType("2xs")} tabular-nums text-subtle`}>
              {duration() > 0
                ? `${formatMediaDuration(currentTime())} / ${formatMediaDuration(duration())}`
                : [extensionLabel(props.item.path ?? props.item.title, props.item.mimeType), sizeText()].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <View
            role="adjustable"
            onLayout={(e) => barWidth.set(e.bounds.size.width)}
            onPressDown={(e) => {
              const dur = duration();
              const w = barWidth();
              if (!player || dur <= 0 || w <= 0) return;
              const ratio = Math.max(0, Math.min(1, e.position.x / w));
              const nextSec = dur * ratio;
              currentTime.set(nextSec);
              player.seek(nextSec);
            }}
            accessibilityLabel={tr("Seek audio", "调整音频进度")}
            class="h-3 justify-center"
          >
            <View class="h-1 w-full overflow-hidden rounded-full bg-input">
              <View class="h-full rounded-full bg-brand" style={{ width: `${Math.round(progress() * 1000) / 10}%` }} />
            </View>
          </View>
        </View>
        <View class="shrink-0 flex-row items-center gap-0.5">
          <If when={props.item.path}>
            {(p) => (
              <>
                <IconButton icon="external" size="sm" label={tr("Open", "打开")} onPress={() => void openLocalFile(p())} />
                <IconButton icon="folder" size="sm" label={revealLabel()} onPress={() => void revealLocalFile(p())} />
              </>
            )}
          </If>
        </View>
      </View>
    </If>
  );
}

// ── Media Gallery Layout ──────────────────────────────────────────────────────

export function MediaGallery(props: {
  items: readonly MediaItem[];
  title?: string;
  compact?: boolean;
  align?: "start" | "end";
  class?: string;
}) {
  const images = () => props.items.filter((item) => item.kind === "image");
  const videos = () => props.items.filter((item) => item.kind === "video");
  const audios = () => props.items.filter((item) => item.kind === "audio");
  const files = () => props.items.filter((item) => item.kind !== "image" && item.kind !== "video" && item.kind !== "audio");
  const alignClass = () => (props.align === "end" ? "items-end" : "items-start");
  const rowJustify = () => (props.align === "end" ? "justify-end" : "justify-start");

  return (
    <View testID="media-gallery" class={`gap-2 ${alignClass()} ${props.class ?? ""}`}>
      <If when={props.title}>
        {(t) => <Text class={`${uiType("xs")} font-medium text-subtle`}>{t()}</Text>}
      </If>
      <If when={images().length > 0}>
        <View class={`max-w-full flex-row flex-wrap gap-2 ${rowJustify()}`}>
          <Each of={images()} key={(item) => item.id}>
            {(item) => <InlineImageCard item={item()} gallery={images().length > 1} compact={props.compact} siblings={images()} />}
          </Each>
        </View>
      </If>
      <If when={videos().length > 0}>
        <View class={`max-w-full gap-2 ${alignClass()}`}>
          <Each of={videos()} key={(item) => item.id}>
            {(item) => <InlineVideoCard item={item()} compact={props.compact} />}
          </Each>
        </View>
      </If>
      <If when={audios().length > 0}>
        <View class={`w-full gap-1.5 ${alignClass()}`}>
          <Each of={audios()} key={(item) => item.id}>
            {(item) => <InlineAudioCard item={item()} compact={props.compact} />}
          </Each>
        </View>
      </If>
      <If when={files().length > 0}>
        <View class={`w-full gap-1.5 ${alignClass()}`}>
          <Each of={files()} key={(item) => item.id}>
            {(item) => <InlineFileCard item={item()} compact={props.compact} />}
          </Each>
        </View>
      </If>
    </View>
  );
}
