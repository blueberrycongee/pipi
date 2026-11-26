// Native streaming Markdown & Prose renderer.
//
// Architecture:
// 1. A reply is one row of the chat's list per Markdown block (`proseRows`),
//    with an O(tail) stable-prefix boundary cache so settled top-level blocks
//    are neither re-parsed nor re-stringified on subsequent stream deltas.
// 2. While streaming, `mendStreamingMarkdown` repairs unclosed inline emphasis,
//    code spans, links, setext underlines, math shielding, and open code fences
//    on the display parse so blocks never jitter or flip raw syntax mid-word.
// 3. `RowVeil` tracks each rendered element (`p:i`, `h:i`, `li:i:j:k`, `bq:i:k`,
//    `code:i`, `th:i:c`, `td:i:r:c`) independently in a single pass per parse.
//    Text lands in layout at once (zero positional offset, no trailing width-shifting
//    caret); each appended chunk's foreground, background wash, and text-decoration
//    alpha then runs smoothly from 0 to 1, safe across recycled `List` cells.
// 4. The fade is recolored once per frame while any
//    chunk is fading (`veilClock`). A span inside a `<Text>` is a run of its
//    attributed string, not a view, so it takes no native animated color.

import { computed, createAnimatedValue, openUrl, reduceMotion, Scroll, signal, Text, token, View } from "nsh";
import type { AnimatedValue, JSX, TextStyle } from "nsh";
import { Button as BaseButton, TextView } from "nsh/base";
import type { TextViewBlock, TextViewDocument, TextViewImage, TextViewInline, TextViewListItem } from "nsh/base";
import { tr } from "../lib/i18n";
import { extractBlockMedia, resolveMediaTarget, type MediaItem } from "../lib/media";
import { mendStreamingMarkdown, PENDING_LINK_URL } from "../lib/mend";
import { groupPipMessageBlocks } from "../lib/pip-bubbles";
import { clearPacers, pacedStreamText } from "../lib/stream-pacer";
import {
  advanceElemVeil,
  beginVeilPass,
  chunkAlpha,
  clearVeils,
  finishVeilPass,
  pruneSettledChunks,
  rowVeil,
  settleVeil,
  sliceChunks,
  veilEnd,
  type RowVeil,
  type VeilChunk,
} from "../lib/veil";
import { openLocalFile, workspacePath } from "../store/app";
import type { PipRowSlot } from "../pi/turns";
import { backend } from "../store/backend";
import { Icon } from "../ui/Icon";
import { EASING } from "../ui/motion";
import { FOCUS_RING, HOVER_REVEAL, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { readingType, codeType } from "../ui/typography";
import { readingSize, FONT_SIZES } from "../store/prefs";
import { openZoom } from "../ui/Zoom";
import { MediaGallery, MediaStreamContext, openMediaZoom } from "./Media";

/** Shared typography classes for `TextView` fallback blocks (alerts, math, settled code). */
export const proseClasses = computed(() => ({
  root: `gap-3 ${readingType()} text-foreground`,
  heading: "text-foreground font-semibold tracking-tight",
  heading1: `mt-2 ${readingType("xl")}`,
  heading2: `mt-2 ${readingType("lg")}`,
  heading3: `mt-1.5 ${readingType()}`,
  heading4: `mt-1 ${readingType()}`,
  code: `rounded-[4px] bg-muted/85 px-1 ${readingType("sm")} text-foreground`,
  codeBlock: "rounded-xl corner-squircle border-[0.5px] border-border bg-sunken",
  codeBlockCode: `p-3.5 ${codeType()} leading-relaxed`,
  link: "text-brand-text",
  blockquote: "border-l-2 border-border pl-3.5 text-muted-foreground",
  table: "rounded-lg corner-squircle border border-border",
  tableHead: "bg-muted",
  tableCell: `px-3 py-1.5 ${readingType("sm")}`,
  tableHeaderCell: `${readingType("xs")} font-semibold text-muted-foreground`,
  rule: "border-hairline",
  listMarker: "text-subtle",
}));

/** Typography classes for Markdown rendered inside Pip's incoming SMS bubble. */
const bubbleProseClasses = computed(() => ({
  ...proseClasses(),
  root: `gap-2 ${readingType()} text-foreground`,
  code: `rounded-[4px] bg-sms-incoming-code px-1 ${readingType("sm")} text-foreground`,
  codeBlock: "rounded-xl corner-squircle border-[0.5px] border-hairline bg-background/85",
  codeBlockCode: `p-3 ${codeType()} leading-relaxed`,
  table: "rounded-lg corner-squircle border-[0.5px] border-hairline bg-background/70",
  tableHead: "bg-background/90",
}));

/** Gentle opacity entrance for newly created structural blocks (tables, rules, code cards). */
const BLOCK_FADE_MS = 220;

/** The table's typography inside the zoom layer: the same recipe, a step roomier. */
const zoomTableClasses = computed(() => ({
  ...proseClasses(),
  tableCell: `px-3.5 py-2 ${readingType("base")}`,
  tableHeaderCell: `${readingType("sm")} font-semibold text-muted-foreground`,
}));

function openProseLink(url: string) {
  const resolved = resolveMediaTarget(url, workspacePath(), backend().home());
  if (resolved?.path) {
    void openLocalFile(resolved.path);
    return;
  }
  void openUrl(url);
}

/** Opens a table in the window's zoom layer: a snapshot rendered through `TextView`, wide tables scroll inside it. */
function zoomTable(block: Extract<TextViewBlock, { type: "table" }>) {
  openZoom({
    render: () => <TextView document={{ blocks: [block] }} classes={zoomTableClasses()} selectable links="report" onLinkPress={({ url }) => openProseLink(url)} />,
  });
}

/** Opens an image in the same zoom layer (`TextView`'s `onImagePress`). */
function zoomImage(image: TextViewImage, gallery?: readonly MediaItem[]) {
  const resolved = resolveMediaTarget(image.src, workspacePath(), backend().home());
  const item: MediaItem = resolved
    ? {
        id: `tv-img:${image.src}`,
        kind: "image",
        title: image.title || image.alt || resolved.title,
        ...(resolved.path ? { path: resolved.path } : {}),
        ...(resolved.src ? { src: resolved.src } : {}),
        ...(resolved.remoteUrl ? { remoteUrl: resolved.remoteUrl } : {}),
        ...(resolved.mimeType ? { mimeType: resolved.mimeType } : {}),
        ...(resolved.data ? { data: resolved.data } : {}),
      }
    : {
        id: `tv-img:${image.src}`,
        kind: "image",
        title: image.title || image.alt || "image",
        src: image.src,
      };
  openMediaZoom(item, gallery ? { gallery } : undefined);
}

/** A block's hover-revealed expand button: a floating chip at its top-right corner that opens it in the zoom layer. */
function ExpandButton(props: { onPress: () => void }) {
  return (
    <BaseButton
      onPress={props.onPress}
      accessibilityLabel={tr("Expand", "放大")}
      tooltip={tip(tr("Expand", "放大"))}
      class={`absolute right-1 top-1 size-6 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover shadow-sm ${PRESS} ${FOCUS_RING} hover:bg-secondary ${HOVER_REVEAL}`}
    >
      <Icon name="expand" size={13} tone="foreground" />
    </BaseButton>
  );
}

/* ── Inline Tree Inspection & Flattening ─────────────────────────────────── */

const SIMPLE_INLINE = new Set([
  "text",
  "strong",
  "emphasis",
  "strikethrough",
  "underline",
  "highlight",
  "small",
  "superscript",
  "subscript",
  "code",
  "keyboard",
  "link",
  "break",
]);

function isSimpleInline(content: readonly TextViewInline[]): boolean {
  return content.every(
    (n) => SIMPLE_INLINE.has(n.type) && (!("content" in n) || !n.content || isSimpleInline(n.content)),
  );
}

function isSimpleList(items: readonly TextViewListItem[]): boolean {
  return items.every((item) =>
    item.children.every(
      (child) =>
        (child.type === "paragraph" && isSimpleInline(child.content)) ||
        (child.type === "list" && isSimpleList(child.items)),
    ),
  );
}

function isSimpleBlockquote(block: Extract<TextViewBlock, { type: "blockquote" }>): boolean {
  if (block.alert) return false;
  return block.children.every(
    (child) =>
      (child.type === "paragraph" && isSimpleInline(child.content)) ||
      (child.type === "list" && isSimpleList(child.items)),
  );
}

function isSimpleTable(block: Extract<TextViewBlock, { type: "table" }>): boolean {
  const headOk = block.head.every((cell) => !cell.colspan && isSimpleInline(cell.content));
  if (!headOk) return false;
  return (block.rows ?? []).every((row) => row.every((cell) => !cell.colspan && isSimpleInline(cell.content)));
}

function flatInlineText(content: readonly TextViewInline[]): string {
  let s = "";
  for (const n of content) {
    if (n.type === "text") s += n.text;
    else if (n.type === "code") s += n.code;
    else if (n.type === "keyboard") s += n.text;
    else if (n.type === "break") s += "\n";
    else if (n.type === "math") s += n.tex;
    else if ("content" in n && n.content) s += flatInlineText(n.content);
    else if (n.type === "custom" && n.text) s += n.text;
  }
  return s;
}

type ToneRole = "fg" | "muted" | "brand";
type BgRole = "muted" | "brand-soft" | "sms-code";

interface InlineMarks {
  cls: string;
  em?: number;
  tone: ToneRole;
  bg?: BgRole;
  underline?: boolean;
  strikethrough?: boolean;
  url?: string;
}

interface InlineRun extends InlineMarks {
  text: string;
}

function collectRuns(content: readonly TextViewInline[], marks: InlineMarks, out: InlineRun[], inBubble = false) {
  for (const n of content) {
    switch (n.type) {
      case "text":
        if (n.text) out.push({ ...marks, text: n.text });
        break;
      case "strong":
        collectRuns(
          n.content,
          { ...marks, cls: `${marks.cls} font-semibold`, tone: marks.tone === "muted" ? "fg" : marks.tone },
          out,
          inBubble,
        );
        break;
      case "emphasis":
        collectRuns(n.content, { ...marks, cls: `${marks.cls} italic` }, out, inBubble);
        break;
      case "strikethrough":
        collectRuns(n.content, { ...marks, strikethrough: true }, out, inBubble);
        break;
      case "underline":
        collectRuns(n.content, { ...marks, underline: true }, out, inBubble);
        break;
      case "highlight":
        collectRuns(n.content, { ...marks, cls: `${marks.cls} rounded-xs corner-squircle`, bg: "brand-soft" }, out, inBubble);
        break;
      case "small":
      case "subscript":
      case "superscript":
        collectRuns(n.content, { ...marks, cls: `${marks.cls} ${readingType("xs")}` }, out, inBubble);
        break;
      case "code":
        if (n.code) {
          out.push({
            ...marks,
            text: n.code,
            cls: `${marks.cls} font-mono rounded-sm corner-squircle px-1`,
            em: 0.9,
            tone: marks.tone === "brand" ? "brand" : "fg",
            bg: inBubble ? "sms-code" : "muted",
          });
        }
        break;
      case "keyboard":
        if (n.text) {
          out.push({
            ...marks,
            text: n.text,
            cls: `${marks.cls} font-mono ${readingType("xs")} rounded-sm corner-squircle px-1`,
            bg: inBubble ? "sms-code" : "muted",
          });
        }
        break;
      case "link":
        collectRuns(n.content, { ...marks, tone: "brand", underline: true, url: n.url }, out, inBubble);
        break;
      case "break":
        out.push({ ...marks, text: "\n", bg: undefined });
        break;
      default:
        break;
    }
  }
}

/* ── Compositor Color Interpolation for Veiled Spans ─────────────────────── */

function resolvedToneHex(role: ToneRole): string {
  if (role === "brand") return token("brand-text");
  if (role === "muted") return token("muted-foreground");
  return token("foreground");
}

function resolvedBgHex(role: BgRole): string {
  if (role === "brand-soft") return token("brand-soft");
  if (role === "sms-code") return token("sms-incoming-code");
  return token("muted");
}

/** A resolved theme color (`#rgb`, `#rrggbb`, `#rrggbbaa`) at `alpha` (0..1) of its own. */
function withAlpha(color: string, alpha: number): string {
  let c = color.trim();
  if (c.length === 4) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  if (!c.startsWith("#") || c.length < 7) return color;
  const own = c.length >= 9 ? parseInt(c.slice(7, 9), 16) : 255;
  return `${c.slice(0, 7)}${Math.round(own * alpha).toString(16).padStart(2, "0")}`;
}

/** The frame clock of the veil: bumped once per frame while any chunk is fading, still otherwise. */
const veilClock = signal(0);
let veilUntil = 0;
let veilTicking = false;

function tickVeil() {
  const now = Date.now();
  veilClock.set(now);
  // One frame past the end, so the last one drawn is the settled color.
  if (now < veilUntil + 32) requestAnimationFrame(tickVeil);
  else veilTicking = false;
}

/** Keeps the veil's clock running until `until` (ms). */
function runVeilClock(until: number) {
  if (until <= veilUntil) return;
  veilUntil = until;
  if (!veilTicking && until > Date.now()) {
    veilTicking = true;
    requestAnimationFrame(tickVeil);
  }
}

/** When the last word under the veil is lit (ms epoch; in the past once nothing fades). */
export function proseVeilUntil(): number {
  return veilUntil;
}

/** Current opacity (0..1) of `chunk` inside `chunks` at `offset` characters past the chunk's start,
 * subscribing to `veilClock` only while active. */
function activeChunkAlpha(chunks: VeilChunk[], chunk: VeilChunk, offset?: number): number {
  const alpha = chunkAlpha(chunks, chunk, Date.now(), offset);
  if (alpha < 1) veilClock();
  return alpha;
}

function decorationLine(run: InlineRun): TextStyle["textDecorationLine"] {
  if (run.underline && run.strikethrough) return "underline line-through";
  if (run.underline) return "underline";
  if (run.strikethrough) return "line-through";
  return undefined;
}

/** Builds a paint-only `TextStyle` for `run` with foreground, inline background wash, and
 * underline/strikethrough colors all multiplied by the chunk's veil `alpha` (matching `apply_veil`). */
function runVeiledStyle(run: InlineRun, chunks: VeilChunk[] | undefined, hit: VeilChunk | undefined, offset?: number, paintBackground = true): TextStyle {
  const fgHex = resolvedToneHex(run.tone);
  const bgHex = run.bg ? resolvedBgHex(run.bg) : undefined;
  const decLine = decorationLine(run);
  const alpha = chunks && hit ? activeChunkAlpha(chunks, hit, offset) : 1;

  if (alpha >= 1) {
    return {
      color: fgHex,
      backgroundColor: paintBackground ? bgHex : undefined,
      textDecorationLine: decLine,
      textDecorationColor: decLine ? fgHex : undefined,
    };
  }
  const veiledFg = withAlpha(fgHex, alpha);
  return {
    color: veiledFg,
    backgroundColor: paintBackground && bgHex ? withAlpha(bgHex, alpha) : undefined,
    textDecorationLine: decLine,
    textDecorationColor: decLine ? veiledFg : undefined,
  };
}

/**
 * Where a run of `length` characters starting at `runStart` in its element is cut into spans: at the
 * edges of what is fading (`local`, in the run's own offsets), and at each word inside it — a span is
 * one color, and the fade travels word by word (`waveOf`). Text at rest is one span, as before.
 */
function veilCuts(local: readonly { start: number; end: number; chunk: VeilChunk }[], runStart: number, length: number): number[] {
  const cuts = new Set<number>([0, length]);
  for (const c of local) {
    if (c.start > 0 && c.start < length) cuts.add(c.start);
    if (c.end > 0 && c.end < length) cuts.add(c.end);
    const wave = c.chunk.wave;
    if (!wave) continue;
    for (const word of wave.at.keys()) {
      const at = c.chunk.start + word - runStart;
      if (at > c.start && at < c.end) cuts.add(at);
    }
  }
  return [...cuts].sort((a, b) => a - b);
}

/** Renders an array of `TextViewInline` nodes with per-chunk opacity veil spans (zero width shift). */
export function renderVeiledInlines(content: readonly TextViewInline[], chunks: VeilChunk[], baseTone: ToneRole, inBubble = false): JSX.Element[] {
  pruneSettledChunks(chunks, Date.now());
  const runs: InlineRun[] = [];
  collectRuns(content, { cls: "", tone: baseTone }, runs, inBubble);
  const out: JSX.Element[] = [];
  let offset = 0;

  for (const run of runs) {
    const start = offset;
    const end = start + run.text.length;
    offset = end;
    const local = sliceChunks(chunks, start, end);
    const clickableUrl = run.url && run.url !== PENDING_LINK_URL ? run.url : undefined;
    const cls = run.cls.trim() || undefined;
    const size = run.em ? ({ fontSize: `${run.em}em` } as const) : undefined;

    if (local.length === 0) {
      out.push(
        <Text
          class={cls}
          style={[runVeiledStyle(run, undefined, undefined), size]}
          onPress={clickableUrl ? () => openProseLink(clickableUrl) : undefined}
        >
          {run.text}
        </Text>,
      );
      continue;
    }

    const cuts = veilCuts(local, start, run.text.length);
    const pieces: { a: number; b: number; hit: (typeof local)[number] | undefined }[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (a >= b) continue;
      pieces.push({ a, b, hit: local.find((c) => a >= c.start && a < c.end) });
    }

    const shell = pieces[0];
    const shellHit = shell?.hit;
    out.push(
      <Text
        class={cls}
        style={[runVeiledStyle(run, chunks, shellHit?.chunk, shell && shellHit ? start + shell.a - shellHit.chunk.start : undefined), size]}
        onPress={clickableUrl ? () => openProseLink(clickableUrl) : undefined}
      >
        {pieces.map(({ a, b, hit }) => (
          <Text style={runVeiledStyle(run, chunks, hit?.chunk, hit ? start + a - hit.chunk.start : undefined, false)}>
            {run.text.slice(a, b)}
          </Text>
        ))}
      </Text>,
    );
  }

  return out;
}

/* ── Single-Pass Document Veil Collector ─────────────────────────────────── */

function advanceListVeils(
  veil: RowVeil,
  items: readonly TextViewListItem[],
  prefix: string,
  now: number,
  chunks: Map<string, VeilChunk[]>,
): void {
  items.forEach((item, j) => {
    item.children.forEach((child, k) => {
      if (child.type === "paragraph" && isSimpleInline(child.content)) {
        const key = `${prefix}:${j}:${k}`;
        chunks.set(key, advanceElemVeil(veil, key, flatInlineText(child.content), now));
      } else if (child.type === "list" && isSimpleList(child.items)) {
        advanceListVeils(veil, child.items, `${prefix}:${j}:L${k}`, now, chunks);
      }
    });
  });
}

function advanceTableVeils(
  veil: RowVeil,
  block: Extract<TextViewBlock, { type: "table" }>,
  blockIdx: number,
  now: number,
  chunks: Map<string, VeilChunk[]>,
): void {
  block.head.forEach((cell, c) => {
    const key = `th:${blockIdx}:${c}`;
    chunks.set(key, advanceElemVeil(veil, key, flatInlineText(cell.content), now));
  });
  (block.rows ?? []).forEach((row, r) => {
    row.forEach((cell, c) => {
      const key = `td:${blockIdx}:${r}:${c}`;
      chunks.set(key, advanceElemVeil(veil, key, flatInlineText(cell.content), now));
    });
  });
}

function measureDocChars(blocks: readonly TextViewBlock[]): number {
  let total = 0;
  for (const b of blocks) {
    if (b.type === "paragraph" || b.type === "heading") total += flatInlineText(b.content).length;
    else if (b.type === "codeBlock") total += b.code.length;
    else if (b.type === "blockquote") total += measureDocChars(b.children);
    else if (b.type === "list") {
      for (const it of b.items) total += measureDocChars(it.children);
    } else if (b.type === "table") {
      for (const cell of b.head) total += flatInlineText(cell.content).length;
      for (const row of b.rows ?? []) {
        for (const cell of row) total += flatInlineText(cell.content).length;
      }
    }
  }
  return total;
}

function blockFadeNode(v: RowVeil, index: number): { opacity: AnimatedValue } | undefined {
  let node = v.blockNodes.get(index) as AnimatedValue | undefined;
  if (!node) {
    node = createAnimatedValue(0);
    v.blockNodes.set(index, node);
    void node.timing(1, { duration: BLOCK_FADE_MS, easing: EASING.entrance });
  }
  return { opacity: node };
}

/* ── Block Components ────────────────────────────────────────────────────── */

const headingClasses = computed(() => ({
  1: `mt-2 ${readingType("xl")} font-semibold tracking-tight leading-snug`,
  2: `mt-2 ${readingType("lg")} font-semibold tracking-tight leading-snug`,
  3: `mt-1.5 ${readingType()} font-semibold leading-snug`,
  4: `mt-1 ${readingType("base")} font-semibold leading-snug`,
  5: `mt-1 ${readingType("sm")} font-semibold leading-snug`,
  6: `mt-1 ${readingType("sm")} font-medium leading-snug`,
}));

function StreamingCodeCard(props: { code: string; chunks: VeilChunk[] }) {
  const codeSpans = () => {
    const text = props.code;
    if (!text) return [];
    const local = sliceChunks(props.chunks, 0, text.length);
    const hex = token("foreground");
    if (local.length === 0) {
      return [<Text class={`font-mono ${codeType()} leading-relaxed`} style={{ color: hex }}>{text}</Text>];
    }
    const cuts = veilCuts(local, 0, text.length);
    const out: JSX.Element[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (a >= b) continue;
      const hit = local.find((c) => a >= c.start && a < c.end);
      const alpha = hit ? activeChunkAlpha(props.chunks, hit.chunk, a - hit.chunk.start) : 1;
      out.push(
        <Text
          class={`font-mono ${codeType()} leading-relaxed`}
          style={{ color: alpha >= 1 ? hex : withAlpha(hex, alpha) }}
        >
          {text.slice(a, b)}
        </Text>,
      );
    }
    return out;
  };

  // Identical box and metrics to the settled code block (`proseClasses`), so the
  // card does not change size when highlighting takes over once its veil finishes.
  return (
    <View selectable class="overflow-hidden rounded-xl corner-squircle border border-border bg-sunken">
      <Scroll horizontal class="w-full" contentClass="p-3.5">
        <View>
          <Text class={`font-mono ${codeType()} leading-relaxed`}>{codeSpans()}</Text>
        </View>
      </Scroll>
    </View>
  );
}

/** A list marker column: `w-4` at least, wider for numbers past one digit (text-md, tabular). */
const MARKER_MIN_WIDTH = 16;
const MARKER_DIGIT_WIDTH = 9.5;
const MARKER_DOT_WIDTH = 5;

function VeiledListView(props: {
  block: Extract<TextViewBlock, { type: "list" }>;
  prefix: string;
  depth: number;
  baseTone: ToneRole;
  chunks: () => ReadonlyMap<string, VeilChunk[]>;
  inBubble?: boolean;
}) {
  const bullets = ["•", "◦", "▪"];
  // The marker column is one width for the whole list, sized for its widest
  // number: a fixed column breaks "10." over two lines ("1" / "0."). It is a
  // minimum, so a marker wider than the estimate widens its row, never wraps.
  const markerWidth = () => {
    if (!props.block.ordered) return MARKER_MIN_WIDTH;
    const last = (props.block.start ?? 1) + Math.max(0, props.block.items.length - 1);
    const digits = String(last).length;
    return Math.max(MARKER_MIN_WIDTH, Math.ceil((digits * MARKER_DIGIT_WIDTH + MARKER_DOT_WIDTH) * readingSize() / FONT_SIZES.reading.default));
  };

  // Loose items sit a little farther apart — still thin: a selection dropped
  // between items targets only line boxes, and a wide gap dead-ends the drag.
  return (
    <View class={props.block.loose ? "gap-1.5" : "gap-1"} selectable={props.depth === 0 ? true : undefined}>
      <Each of={props.block.items} key="index">
        {(item, j) => {
          const markerText = () =>
            props.block.ordered ? `${(props.block.start ?? 1) + j()}.` : bullets[Math.min(props.depth, bullets.length - 1)];
          const isTask = () => typeof item().checked === "boolean";

          return (
            <View class="flex-row items-start gap-2.5">
              <If
                when={isTask()}
                else={
                  <View class="shrink-0 items-end pt-[1px]" style={{ minWidth: markerWidth() }}>
                    <Text class={`${readingType()} leading-relaxed tabular-nums text-subtle`}>{markerText()}</Text>
                  </View>
                }
              >
                <View
                  class={`mt-[4px] size-3.5 shrink-0 items-center justify-center rounded-xs corner-squircle border ${
                    item().checked ? "border-brand bg-brand" : "border-hairline-focus bg-card"
                  }`}
                >
                  <If when={item().checked}>
                    <Icon name="check" size={10} tone="brand-foreground" />
                  </If>
                </View>
              </If>
              <View class="min-w-0 flex-1 gap-1">
                <Each of={item().children} key="index">
                  {(child, k) => {
                    const key = () => `${props.prefix}:${j()}:${k()}`;
                    return (
                      <View>
                        <If when={child().type === "paragraph" ? (child() as Extract<TextViewBlock, { type: "paragraph" }>) : undefined}>
                          {(para) => (
                            <Text class={`${readingType()} leading-relaxed`}>
                              {renderVeiledInlines(para().content, props.chunks().get(key()) ?? [], props.baseTone, props.inBubble)}
                            </Text>
                          )}
                        </If>
                        <If when={child().type === "list" ? (child() as Extract<TextViewBlock, { type: "list" }>) : undefined}>
                          {(sub) => (
                            <VeiledListView
                              block={sub()}
                              prefix={`${props.prefix}:${j()}:L${k()}`}
                              depth={props.depth + 1}
                              baseTone={props.baseTone}
                              chunks={props.chunks}
                              inBubble={props.inBubble}
                            />
                          )}
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

function VeiledTableView(props: {
  block: Extract<TextViewBlock, { type: "table" }>;
  blockIdx: () => number;
  settled: boolean;
  chunks: () => ReadonlyMap<string, VeilChunk[]>;
  inBubble?: boolean;
}) {
  const alignClass = (col: number) => {
    const a = props.block.align?.[col];
    if (a === "right") return "text-right";
    if (a === "center") return "text-center";
    return "text-left";
  };

  return (
    <View class="group relative">
      <View
        selectable
        class={`overflow-hidden rounded-lg corner-squircle border ${
          props.inBubble ? "border-hairline bg-background/70" : "border-border"
        }`}
      >
        <Scroll horizontal class="w-full">
          <View class="min-w-full">
            <View class={`flex-row border-b ${props.inBubble ? "border-hairline bg-background/90" : "border-border bg-muted"}`}>
              <Each of={props.block.head} key="index">
                {(cell, c) => (
                  <View class="min-w-24 flex-1 px-3 py-1.5">
                    <Text class={`${readingType("xs")} font-semibold ${alignClass(c())}`}>
                      {renderVeiledInlines(cell().content, props.chunks().get(`th:${props.blockIdx()}:${c()}`) ?? [], "muted", props.inBubble)}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
            <Each of={props.block.rows ?? []} key="index">
              {(row, r) => (
                <View class={`flex-row ${r() > 0 ? "border-t border-hairline" : ""}`}>
                  <Each of={row()} key="index">
                    {(cell, c) => (
                      <View class="min-w-24 flex-1 px-3 py-1.5">
                        <Text class={`${readingType("sm")} leading-relaxed ${alignClass(c())}`}>
                          {renderVeiledInlines(cell().content, props.chunks().get(`td:${props.blockIdx()}:${r()}:${c()}`) ?? [], "fg", props.inBubble)}
                        </Text>
                      </View>
                    )}
                  </Each>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </View>
      <If when={props.settled}>
        <ExpandButton onPress={() => zoomTable(props.block)} />
      </If>
    </View>
  );
}

function FallbackTextViewBlock(props: { block: TextViewBlock; settled: boolean; inBubble?: boolean }) {
  const getStream = MediaStreamContext();
  return (
    <TextView
      document={{ blocks: [props.block] }}
      classes={props.inBubble ? bubbleProseClasses() : proseClasses()}
      selectable
      links="report"
      onLinkPress={({ url }) => openProseLink(url)}
      codeBlockScrollbar={false}
      tableScrollbar={false}
      codeBlockActions={props.settled ? [{ id: "copy", label: tr("Copy code", "复制代码") }] : undefined}
      onImagePress={({ image }) => zoomImage(image, getStream?.())}
    />
  );
}

/**
 * One block of a reply, a row of the chat's list of its own. A reply is not
 * one row: a row that outgrows the viewport makes the list lay everything out
 * again with every delta (and show a blank frame doing it), and a finished
 * long reply could not be recycled. As rows, only the block being written
 * changes while a reply streams.
 */
export interface ProseRow {
  kind: "prose";
  id: string;
  /** The transcript row (the reply) this is a block of. */
  rowId: string;
  index: number;
  /** The block; absent on the row of the reply's footnotes. */
  block?: TextViewBlock;
  footnotes?: TextViewDocument["footnotes"];
  /** The last block of a reply that is still streaming: the one that grows. */
  tail: boolean;
  /** What is fading in this reply, by element key, as of when this block last changed. */
  chunks: ReadonlyMap<string, VeilChunk[]>;
  /** Present in Pip persona IM mode: carries the lead avatar slot and turn metadata. */
  pip?: PipRowSlot;
}

interface ProseEntry {
  text: string;
  streaming: boolean;
  reduced: boolean;
  pipKey: string;
  rows: ProseRow[];
  /** Each block as JSON: what tells a block that changed from one that did not. */
  shapes: string[];
  /** Parsed blocks cached so incremental tail updates reuse settled prefix blocks in O(tail). */
  blocks: TextViewBlock[];
  /** Character offset in `text` where the incremental reparse window starts (`stableCount` blocks before it). */
  stableOffset: number;
  /** Number of leading blocks before `stableOffset` guaranteed untouched by appends. */
  stableCount: number;
  /** Whether `text` contains reference-style link definitions (`[id]: url`), requiring full parse. */
  hasRefDefs: boolean;
}

/** One iMessage-style incoming SMS bubble projected from a settled Pip reply. */
export interface PipBubbleRow {
  kind: "pip-bubble";
  id: string;
  /** The underlying transcript text row id (used to skip pop-in animation on loaded history). */
  rowId: string;
  /** Position inside this message's bubble cluster (0-based, drives staggered pop-in). */
  bubbleIndex: number;
  /** First bubble of the message cluster (tight top corners on subsequent bubbles). */
  first: boolean;
  /** Last bubble of the message cluster (carries curved tail + bottom-left Pip avatar when `pip.tail`). */
  last: boolean;
  /** Parsed Markdown blocks rendered inside this bubble. */
  blocks: TextViewBlock[];
  /** Footnotes attached to the last bubble when present. */
  footnotes?: TextViewDocument["footnotes"];
  /** Plain text for copying this single bubble. */
  copyText: string;
  /** Full reply text across all bubbles in this turn (for "Copy full reply"). */
  fullText: string;
  /** True when the bubble contains wide structured content (code block / table). */
  wide: boolean;
  /** True when the bubble is purely media (renders borderless rounded media like an iMessage photo). */
  mediaOnly?: boolean;
  /** Pip turn slot metadata (`lead` on first bubble, `tail` on final bubble). */
  pip: PipRowSlot;
}

interface PipBubbleEntry {
  text: string;
  pipKey: string;
  rows: PipBubbleRow[];
}

const pipBubbleEntries = new Map<string, PipBubbleEntry>();

const proseEntries = new Map<string, ProseEntry>();

/** Clears cached blocks, pacers and veils when switching sessions. */
export function clearProseState() {
  proseEntries.clear();
  pipBubbleEntries.clear();
  clearPacers();
  clearVeils();
  veilUntil = 0;
}

/** Reference link or footnote definitions (`[label]: url` / `[^1]: note`) act at a distance across blocks. */
const REF_DEF_RE = /(?:^|\n)[ ]{0,3}\[[^\]]+\]:[ \t]/;

/**
 * Finds a safe byte/char boundary in `source` at least 2 blank-line-separated
 * top-level blocks back from the end (outside any fenced code blocks),
 * so appends only parse O(tail).
 */
function findIncrementalBoundary(source: string): number {
  let inFence: { ch: "`" | "~"; len: number } | null = null;
  const blankBoundaries: number[] = [];
  let pos = 0;
  const len = source.length;
  let prevBlankEnd = -1;

  while (pos <= len) {
    const nl = source.indexOf("\n", pos);
    const lineEnd = nl === -1 ? len : nl;
    const rawEnd = lineEnd > pos && source[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;

    let indent = pos;
    while (indent < rawEnd && indent - pos < 3 && source[indent] === " ") indent++;
    const first = source[indent];

    if (!inFence) {
      if (first === "`" || first === "~") {
        let fEnd = indent + 1;
        while (fEnd < rawEnd && source[fEnd] === first) fEnd++;
        const fLen = fEnd - indent;
        if (fLen >= 3 && (first !== "`" || !source.slice(fEnd, rawEnd).includes("`"))) {
          inFence = { ch: first, len: fLen };
        }
      } else {
        // Check if this line is completely blank
        let onlySpace = true;
        for (let k = pos; k < rawEnd; k++) {
          if (source[k] !== " " && source[k] !== "\t") {
            onlySpace = false;
            break;
          }
        }
        if (onlySpace && nl !== -1) {
          prevBlankEnd = nl + 1;
        } else if (!onlySpace && prevBlankEnd > 0) {
          // A top-level non-indented paragraph/heading/fence starting after a blank line!
          if (indent - pos === 0) {
            blankBoundaries.push(prevBlankEnd);
          }
          prevBlankEnd = -1;
        }
      }
    } else if (first === inFence.ch) {
      let fEnd = indent + 1;
      while (fEnd < rawEnd && source[fEnd] === first) fEnd++;
      if (fEnd - indent >= inFence.len && /^[ \t]*$/.test(source.slice(fEnd, rawEnd))) {
        inFence = null;
        prevBlankEnd = -1;
      }
    }

    if (nl === -1) break;
    pos = nl + 1;
  }

  // Keep at least the last 3 blank-line-separated regions in the live tail window so lazy
  // list/quote continuations never cross the boundary.
  return blankBoundaries.length >= 3 ? blankBoundaries[blankBoundaries.length - 3] : 0;
}

/** Advances the reply's veil from `startIndex` in one pass, reusing settled prefix chunks in O(tail). */
function advanceDocVeil(
  id: string,
  blocks: readonly TextViewBlock[],
  streaming: boolean,
  startIndex: number,
  prevChunks?: ReadonlyMap<string, VeilChunk[]>,
): Map<string, VeilChunk[]> {
  const veil = rowVeil(id);
  if (reduceMotion()) {
    settleVeil(veil);
    veil.seenBlocks = Math.max(veil.seenBlocks, blocks.length);
    return new Map();
  }
  const now = Date.now();
  if (!veil.initialized) {
    beginVeilPass(veil, measureDocChars(blocks), streaming);
    startIndex = 0;
  }

  const chunks = new Map<string, VeilChunk[]>();
  if (startIndex > 0 && prevChunks) {
    for (const [k, list] of prevChunks) {
      if (list.length > 0) chunks.set(k, list);
    }
  }

  for (let i = startIndex; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "paragraph" && isSimpleInline(b.content)) {
      const key = `p:${i}`;
      chunks.set(key, advanceElemVeil(veil, key, flatInlineText(b.content), now));
    } else if (b.type === "heading" && isSimpleInline(b.content)) {
      const key = `h:${i}`;
      chunks.set(key, advanceElemVeil(veil, key, flatInlineText(b.content), now));
    } else if (b.type === "list" && isSimpleList(b.items)) {
      advanceListVeils(veil, b.items, `li:${i}`, now, chunks);
    } else if (b.type === "blockquote" && isSimpleBlockquote(b)) {
      b.children.forEach((qChild, k) => {
        if (qChild.type === "paragraph") {
          const key = `bq:${i}:${k}`;
          chunks.set(key, advanceElemVeil(veil, key, flatInlineText(qChild.content), now));
        } else if (qChild.type === "list" && isSimpleList(qChild.items)) {
          advanceListVeils(veil, qChild.items, `bq:${i}:L${k}`, now, chunks);
        }
      });
    } else if (b.type === "table" && isSimpleTable(b)) {
      advanceTableVeils(veil, b, i, now, chunks);
    } else if (b.type === "codeBlock") {
      const key = `code:${i}`;
      if ((streaming && i === blocks.length - 1) || veil.elems.has(key)) {
        chunks.set(key, advanceElemVeil(veil, key, b.code, now));
      } else if (!veil.seeding && i >= veil.seenBlocks) {
        blockFadeNode(veil, i);
      }
    } else if (!veil.seeding && i >= veil.seenBlocks) {
      blockFadeNode(veil, i);
    }
    veil.seenBlocks = Math.max(veil.seenBlocks, i + 1);
  }

  finishVeilPass(veil);
  let until = 0;
  for (const list of chunks.values()) until = Math.max(until, veilEnd(list));
  runVeilClock(until);
  return chunks;
}

/**
 * The rows of a reply: one per block of its Markdown. While it streams the
 * display parse is mended, and appends past settled blocks
 * parse only the trailing window (`O(tail)`). A block that did not change keeps
 * its exact `ProseRow` object so the virtualized list leaves it untouched.
 */
function pipSlotKey(pip?: PipRowSlot): string {
  if (!pip) return "";
  return `${pip.lead ? 1 : 0}:${pip.tail ? 1 : 0}:${pip.indent ? 1 : 0}:${pip.meta?.turnId ?? ""}:${pip.meta?.durationMs ?? ""}:${pip.meta?.hasDetails ? 1 : 0}:${pip.meta?.summary ?? ""}`;
}

const EMPTY_CHUNKS: ReadonlyMap<string, VeilChunk[]> = new Map();

/**
 * Projects a settled Pip reply into 1..N iMessage-style SMS bubble rows,
 * cached per transcript row id so unchanged bubbles keep exact object identity.
 */
export function pipBubbleRows(row: { id: string; text: string; pip?: PipRowSlot }): PipBubbleRow[] {
  const pipKey = pipSlotKey(row.pip);
  const before = pipBubbleEntries.get(row.id);
  if (before && before.text === row.text && before.pipKey === pipKey) {
    return before.rows;
  }

  const doc = TextView.parse(row.text, { streaming: false });
  const groups = groupPipMessageBlocks(doc.blocks, row.text.trim());
  const basePip: PipRowSlot = row.pip ?? { lead: true, tail: true, indent: true };
  const fullText = basePip.fullText || row.text;
  const cwd = workspacePath();
  const home = backend().home();

  const rows: PipBubbleRow[] = groups.map((group, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === groups.length - 1;
    let mediaOnly = false;
    if (group.blocks.length === 1 && group.blocks[0].type === "paragraph") {
      const res = extractBlockMedia(group.blocks[0], cwd, home, `pip-m:${row.id}:${idx}`);
      if (res.mode === "pure") mediaOnly = true;
    }
    const slot: PipRowSlot = {
      ...basePip,
      lead: Boolean(basePip.lead && isFirst),
      tail: Boolean(basePip.tail && isLast),
      indent: true,
      fullText,
    };
    return {
      kind: "pip-bubble",
      id: `${row.id}#b${idx}`,
      rowId: row.id,
      bubbleIndex: idx,
      first: isFirst,
      last: isLast,
      blocks: group.blocks,
      ...(isLast && doc.footnotes?.length ? { footnotes: doc.footnotes } : {}),
      copyText: group.copyText,
      fullText,
      wide: group.wide,
      ...(mediaOnly ? { mediaOnly: true } : {}),
      pip: slot,
    };
  });

  pipBubbleEntries.set(row.id, { text: row.text, pipKey, rows });
  return rows;
}

export function proseRows(row: { id: string; text: string; streaming: boolean; pip?: PipRowSlot }): ProseRow[] {
  const reduced = reduceMotion();
  const text = pacedStreamText(row.id, row.text, row.streaming, reduced);
  const pipKey = pipSlotKey(row.pip);
  const before = proseEntries.get(row.id);
  if (before && before.text === text && before.streaming === row.streaming && before.reduced === reduced && before.pipKey === pipKey) {
    return before.rows;
  }

  const canIncremental =
    row.streaming &&
    before !== undefined &&
    before.streaming &&
    before.reduced === reduced &&
    !before.hasRefDefs &&
    text.length >= before.text.length &&
    text.startsWith(before.text) &&
    !REF_DEF_RE.test(text.slice(Math.max(0, before.text.lastIndexOf("\n"))));

  let blocks: TextViewBlock[];
  let footnotes: TextViewDocument["footnotes"];
  let startIndex = 0;
  let stableOffset = 0;
  let stableCount = 0;
  const hasRefDefs = canIncremental ? false : REF_DEF_RE.test(text);

  if (canIncremental && before.stableOffset > 0 && before.stableCount > 0) {
    stableOffset = before.stableOffset;
    stableCount = before.stableCount;
    startIndex = stableCount;
    const tailMended = mendStreamingMarkdown(text.slice(stableOffset)).source;
    const tailDoc = TextView.parse(tailMended, { streaming: true });
    blocks = [...before.blocks.slice(0, stableCount), ...tailDoc.blocks];
    footnotes = tailDoc.footnotes;

    // Advance the incremental anchor forward as the reply grows past ~1200 chars beyond it
    if (text.length - stableOffset > 1200) {
      const nextBoundary = findIncrementalBoundary(text);
      if (nextBoundary > stableOffset) {
        const prefixDoc = TextView.parse(text.slice(0, nextBoundary), { streaming: false });
        stableOffset = nextBoundary;
        stableCount = prefixDoc.blocks.length;
      }
    }
  } else {
    const doc = row.streaming
      ? TextView.parse(mendStreamingMarkdown(text).source, { streaming: true })
      : TextView.parse(text, { streaming: false });
    blocks = doc.blocks;
    footnotes = doc.footnotes;

    if (row.streaming && !hasRefDefs && text.length > 1200) {
      const nextBoundary = findIncrementalBoundary(text);
      if (nextBoundary > 0) {
        const prefixDoc = TextView.parse(text.slice(0, nextBoundary), { streaming: false });
        stableOffset = nextBoundary;
        stableCount = prefixDoc.blocks.length;
      }
    }
  }

  const prevChunks = before?.rows[before.rows.length - 1]?.chunks;
  const chunks = advanceDocVeil(row.id, blocks, row.streaming, startIndex, prevChunks);

  const shapes: string[] = new Array(blocks.length);
  const rows: ProseRow[] = new Array(blocks.length);

  // Settled prefix blocks skip JSON.stringify and reuse their exact ProseRow objects!
  for (let i = 0; i < startIndex; i++) {
    shapes[i] = before!.shapes[i];
    rows[i] = before!.rows[i];
  }

  for (let index = startIndex; index < blocks.length; index++) {
    const block = blocks[index];
    const tail = row.streaming && index === blocks.length - 1;
    const shape = JSON.stringify(block);
    shapes[index] = shape;
    const old = before?.rows[index];
    const pip: PipRowSlot | undefined = row.pip
      ? index === 0
        ? row.pip
        : { lead: false, indent: true, meta: row.pip.meta }
      : undefined;
    if (old?.block && before?.shapes[index] === shape && old.tail === tail && before?.pipKey === pipKey) {
      rows[index] = old;
      continue;
    }
    // Block identity is structural, not a stream-phase identity. Replacing a
    // tail key at the exact moment a reply settles makes a virtualized list
    // delete and insert the same paragraph, which is the source of the final
    // one-frame jump. The row keeps its key; its measured height is allowed to
    // settle in place.
    rows[index] = {
      kind: "prose",
      id: `${row.id}#${index}`,
      rowId: row.id,
      index,
      block,
      tail,
      chunks,
      ...(pip ? { pip } : {}),
    };
  }

  if (footnotes?.length) {
    const shape = JSON.stringify(footnotes);
    const old = before?.rows[rows.length];
    const footPip: PipRowSlot | undefined = row.pip ? { lead: false, indent: true, meta: row.pip.meta } : undefined;
    shapes.push(shape);
    rows.push(
      old?.footnotes && before?.shapes[rows.length] === shape && before?.pipKey === pipKey
        ? old
        : { kind: "prose", id: `${row.id}#notes`, rowId: row.id, index: rows.length, footnotes, tail: false, chunks, ...(footPip ? { pip: footPip } : {}) },
    );
  }

  proseEntries.set(row.id, {
    text,
    streaming: row.streaming,
    reduced,
    pipKey,
    rows,
    shapes,
    blocks,
    stableOffset,
    stableCount,
    hasRefDefs,
  });
  return rows;
}

/** A block of a reply: veiled text for what streams, `TextView` for the rest. */
export function ProseBlock(props: { row: ProseRow; inBubble?: boolean }) {
  const item = (): TextViewBlock => props.row.block ?? { type: "paragraph", content: [] };
  const index = () => props.row.index;
  const chunksOf = (key: string): VeilChunk[] => (props.row.chunks.get(key) as VeilChunk[] | undefined) ?? [];
  const chunksMap = () => props.row.chunks;

  const fadeStyle = () => {
    const node = rowVeil(props.row.rowId).blockNodes.get(index()) as AnimatedValue | undefined;
    return node ? { opacity: node } : undefined;
  };

  const paraMedia = () => {
    const b = item();
    if (!props.row.block || b.type !== "paragraph") return undefined;
    const res = extractBlockMedia(b, workspacePath(), backend().home(), `md:${props.row.rowId}:${index()}`);
    return res.mode === "none" ? undefined : res;
  };
  const asMediaOnly = () => {
    const res = paraMedia();
    return res?.mode === "pure" ? res.items : undefined;
  };
  const asPara = () => {
    const b = item();
    if (!props.row.block || b.type !== "paragraph") return undefined;
    const res = paraMedia();
    if (res?.mode === "pure") return undefined;
    const target = res?.strippedBlock ?? b;
    return isSimpleInline(target.content) ? { block: target, media: res?.items ?? [] } : undefined;
  };
  const asHeading = () => {
    const b = item();
    return b.type === "heading" && isSimpleInline(b.content) ? b : undefined;
  };
  const asList = () => {
    const b = item();
    return b.type === "list" && isSimpleList(b.items) ? b : undefined;
  };
  const asQuote = () => {
    const b = item();
    return b.type === "blockquote" && isSimpleBlockquote(b) ? b : undefined;
  };
  const asTable = () => {
    const b = item();
    return b.type === "table" && isSimpleTable(b) ? b : undefined;
  };
  /** A table the veiled path cannot render (a colspan or a nested block) still gets its expand affordance. */
  const asFallbackTable = () => {
    const b = item();
    return b.type === "table" && !isSimpleTable(b) ? b : undefined;
  };
  // Keep `StreamingCodeCard` mounted not only while it is the tail block, but also while
  // its trailing chunks finish dissolving — once the last chunk reaches alpha 1, hand off
  // seamlessly to `TextView` syntax highlighting + Copy button without snapping mid-fade!
  // (That last frame ends this condition and runs the card once more, in either order: the
  // card reads its block null-safe, as by then there may be none to read.)
  const asStreamingCode = () => {
    const b = item();
    if (b.type !== "codeBlock") return undefined;
    if (props.row.tail) return b;
    const codeChunks = chunksOf(`code:${index()}`);
    if (codeChunks.length === 0) return undefined;
    veilClock();
    const now = Date.now();
    const stillFading = codeChunks.some((c) => chunkAlpha(codeChunks, c, now) < 1);
    return stillFading ? b : undefined;
  };

  return (
    <If
      when={props.row.block}
      else={
        <TextView
          document={{ blocks: [], footnotes: props.row.footnotes ?? [] }}
          classes={props.inBubble ? bubbleProseClasses() : proseClasses()}
          selectable
          links="report"
          onLinkPress={({ url }) => openProseLink(url)}
          codeBlockScrollbar={false}
          tableScrollbar={false}
        />
      }
    >
      <View style={fadeStyle()}>
        <If
          when={asMediaOnly()}
          else={
            <If
              when={asPara()}
              else={
                <If
                  when={asHeading()}
                  else={
                    <If
                      when={asList()}
                      else={
                        <If
                          when={asQuote()}
                          else={
                            <If
                              when={asTable()}
                              else={
                                <If
                                  when={asFallbackTable()}
                                  else={
                                    <If
                                      when={asStreamingCode()}
                                      else={
                                        <View class="gap-2">
                                          <FallbackTextViewBlock block={paraMedia()?.strippedBlock ?? item()} settled={!props.row.tail} inBubble={props.inBubble} />
                                          <If when={paraMedia()?.mode === "mixed"}>
                                            <MediaGallery items={paraMedia()!.items} />
                                          </If>
                                        </View>
                                      }
                                    >
                                      {(codeBlock) => <StreamingCodeCard code={codeBlock()?.code ?? ""} chunks={chunksOf(`code:${index()}`)} />}
                                    </If>
                                  }
                                >
                                  {(tableBlock) => (
                                    <View class="group relative">
                                      <FallbackTextViewBlock block={tableBlock()} settled={!props.row.tail} inBubble={props.inBubble} />
                                      <If when={!props.row.tail}>
                                        <ExpandButton onPress={() => zoomTable(tableBlock())} />
                                      </If>
                                    </View>
                                  )}
                                </If>
                              }
                            >
                              {(tableBlock) => <VeiledTableView block={tableBlock()} blockIdx={index} settled={!props.row.tail} chunks={chunksMap} inBubble={props.inBubble} />}
                            </If>
                          }
                        >
                          {(quote) => (
                            <View class="gap-1.5 border-l-2 border-brand/35 pl-3.5" selectable>
                              <Each of={quote().children} key="index">
                                {(qChild, k) => (
                                  <View>
                                    <If when={qChild().type === "paragraph" ? (qChild() as Extract<TextViewBlock, { type: "paragraph" }>) : undefined}>
                                      {(qp) => (
                                        <Text class={`${readingType()} leading-relaxed italic`}>
                                          {renderVeiledInlines(qp().content, chunksOf(`bq:${index()}:${k()}`), "muted", props.inBubble)}
                                        </Text>
                                      )}
                                    </If>
                                    <If when={qChild().type === "list" ? (qChild() as Extract<TextViewBlock, { type: "list" }>) : undefined}>
                                      {(qList) => (
                                        <VeiledListView
                                          block={qList()}
                                          prefix={`bq:${index()}:L${k()}`}
                                          depth={0}
                                          baseTone="muted"
                                          chunks={chunksMap}
                                          inBubble={props.inBubble}
                                        />
                                      )}
                                    </If>
                                  </View>
                                )}
                              </Each>
                            </View>
                          )}
                        </If>
                      }
                    >
                      {(listBlock) => (
                        <VeiledListView
                          block={listBlock()}
                          prefix={`li:${index()}`}
                          depth={0}
                          baseTone="fg"
                          chunks={chunksMap}
                          inBubble={props.inBubble}
                        />
                      )}
                    </If>
                  }
                >
                  {(heading) => {
                    const key = () => `h:${index()}`;
                    return (
                      <View selectable>
                        <Text role="header" accessibilityLevel={heading().level} class={headingClasses()[heading().level]}>
                          {renderVeiledInlines(heading().content, chunksOf(key()), "fg", props.inBubble)}
                        </Text>
                      </View>
                    );
                  }}
                </If>
              }
            >
              {(para) => {
                const key = () => `p:${index()}`;
                return (
                  <View class="gap-2">
                    <View selectable>
                      <Text class={`${readingType()} leading-relaxed`}>{renderVeiledInlines(para().block.content, chunksOf(key()), "fg", props.inBubble)}</Text>
                    </View>
                    <If when={para().media.length > 0}>
                      <MediaGallery items={para().media} />
                    </If>
                  </View>
                );
              }}
            </If>
          }
        >
          {(items) => <MediaGallery items={items()} class={props.inBubble ? "" : "py-1.5"} />}
        </If>
      </View>
    </If>
  );
}

/** Renders the Markdown blocks of a single settled Pip SMS bubble using bubble-tuned styling. */
export function PipBubbleBlocks(props: { row: PipBubbleRow }) {
  return (
    <View class="gap-2">
      <Each of={props.row.blocks} key="index">
        {(block, i) => (
          <ProseBlock
            inBubble
            row={{
              kind: "prose",
              id: `${props.row.id}:${i()}`,
              rowId: props.row.rowId,
              index: i(),
              block: block(),
              tail: false,
              chunks: EMPTY_CHUNKS,
            }}
          />
        )}
      </Each>
      <If when={props.row.footnotes?.length}>
        <ProseBlock
          inBubble
          row={{
            kind: "prose",
            id: `${props.row.id}:notes`,
            rowId: props.row.rowId,
            index: props.row.blocks.length,
            footnotes: props.row.footnotes,
            tail: false,
            chunks: EMPTY_CHUNKS,
          }}
        />
      </If>
    </View>
  );
}
