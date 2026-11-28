import { mkdir, readFile, writeFile } from "fs/promises";
import { signal, Storage } from "nsh";
import type { TextViewBlock, TextViewDocument } from "nsh/base";
import type { ReplyPart } from "../lib/doc-wire";
import { tr } from "../lib/i18n";
import type { Mood } from "../mascot/geometry";
import type { ImageContent } from "../pi/protocol";
import { backend } from "./backend";

/** The six macOS Messages tapbacks, in their native order. */
export const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;
export type Tapback = (typeof TAPBACKS)[number];

export type MessageSticker =
  | { id: string; kind: "emoji"; emoji: string; rotation: number }
  | { id: string; kind: "pip"; mood: Mood; rotation: number }
  | { id: string; kind: "image"; path: string; mimeType?: string; rotation: number };

export type MessageStickerDraft =
  | { kind: "emoji"; emoji: string }
  | { kind: "pip"; mood: Mood }
  | { kind: "image"; path: string; mimeType?: string };

export interface MessageInteraction {
  tapback?: Tapback;
  stickers: MessageSticker[];
}

export interface CustomSticker {
  id: string;
  path: string;
  name: string;
  mimeType?: string;
}

interface InteractionsFile {
  version: 1;
  /** persona scope -> stable message anchor -> purely local adornments */
  messages: Record<string, Record<string, MessageInteraction>>;
  customStickers: CustomSticker[];
}

const KEY = "pipi.message-interactions.v1";
const EMPTY: InteractionsFile = { version: 1, messages: {}, customStickers: [] };
const state = signal<InteractionsFile>(EMPTY);
let loading: Promise<void> | undefined;

const validTapback = (value: unknown): Tapback | undefined => (TAPBACKS as readonly string[]).includes(value as string) ? (value as Tapback) : undefined;

function normalizeSticker(value: unknown): MessageSticker | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  const rotation = typeof raw.rotation === "number" && Number.isFinite(raw.rotation) ? raw.rotation : 0;
  if (raw.kind === "emoji" && typeof raw.emoji === "string" && raw.emoji) return { id: raw.id, kind: "emoji", emoji: raw.emoji, rotation };
  if (raw.kind === "pip" && typeof raw.mood === "string") return { id: raw.id, kind: "pip", mood: raw.mood as Mood, rotation };
  if (raw.kind === "image" && typeof raw.path === "string" && raw.path) {
    return { id: raw.id, kind: "image", path: raw.path, ...(typeof raw.mimeType === "string" ? { mimeType: raw.mimeType } : {}), rotation };
  }
  return undefined;
}

function normalizeInteraction(value: unknown): MessageInteraction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const stickers = Array.isArray(raw.stickers) ? raw.stickers.map(normalizeSticker).filter((s): s is MessageSticker => Boolean(s)) : [];
  const tapback = validTapback(raw.tapback);
  if (!tapback && !stickers.length) return undefined;
  return { ...(tapback ? { tapback } : {}), stickers };
}

function normalizeFile(value: unknown): InteractionsFile {
  if (!value || typeof value !== "object") return EMPTY;
  const raw = value as Record<string, unknown>;
  const messages: InteractionsFile["messages"] = {};
  if (raw.messages && typeof raw.messages === "object" && !Array.isArray(raw.messages)) {
    for (const [scope, byMessage] of Object.entries(raw.messages as Record<string, unknown>)) {
      if (!byMessage || typeof byMessage !== "object" || Array.isArray(byMessage)) continue;
      const kept: Record<string, MessageInteraction> = {};
      for (const [target, interaction] of Object.entries(byMessage as Record<string, unknown>)) {
        const clean = normalizeInteraction(interaction);
        if (clean) kept[target] = clean;
      }
      if (Object.keys(kept).length) messages[scope] = kept;
    }
  }
  const customStickers = Array.isArray(raw.customStickers)
    ? raw.customStickers.flatMap((item): CustomSticker[] => {
        if (!item || typeof item !== "object") return [];
        const rawItem = item as Record<string, unknown>;
        if (typeof rawItem.id !== "string" || typeof rawItem.path !== "string" || !rawItem.id || !rawItem.path) return [];
        return [{
          id: rawItem.id,
          path: rawItem.path,
          name: typeof rawItem.name === "string" && rawItem.name ? rawItem.name : rawItem.path.split("/").pop() ?? rawItem.id,
          ...(typeof rawItem.mimeType === "string" ? { mimeType: rawItem.mimeType } : {}),
        }];
      })
    : [];
  return { version: 1, messages, customStickers };
}

/** Reads the local sticker/tapback store once at boot; failures simply start empty. */
export async function loadPipInteractions() {
  loading ??= (async () => {
    try {
      const stored = await Storage.getItem(KEY);
      if (stored) state.set(normalizeFile(JSON.parse(stored)));
    } catch {}
  })();
  await loading;
}

function persist(next: InteractionsFile) {
  state.set(next);
  void Storage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
}

export const pipInteractionsLoaded = () => state() !== EMPTY || Boolean(loading);
export const customStickers = () => state().customStickers;

/** The adornments attached to one stable message anchor in one persona conversation. */
export function messageInteraction(scope: string, target: string): MessageInteraction | undefined {
  return state().messages[scope]?.[target];
}

function updateMessage(scope: string, target: string, update: (current: MessageInteraction | undefined) => MessageInteraction | undefined) {
  const before = state();
  const scoped = { ...(before.messages[scope] ?? {}) };
  const next = update(scoped[target]);
  if (next) scoped[target] = next;
  else delete scoped[target];
  const messages = { ...before.messages };
  if (Object.keys(scoped).length) messages[scope] = scoped;
  else delete messages[scope];
  persist({ ...before, messages });
}

/** Tapbacks are a one-tap local reaction: the same tapback again removes it, another replaces it. */
export function toggleTapback(scope: string, target: string, tapback: Tapback) {
  updateMessage(scope, target, (current) => {
    const stickers = current?.stickers ?? [];
    if (current?.tapback === tapback) return stickers.length ? { stickers } : undefined;
    return { ...(current ?? { stickers }), tapback, stickers };
  });
}

const rotationFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 13) - 6) * 0.9;
};

export function addSticker(scope: string, target: string, sticker: MessageStickerDraft) {
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  updateMessage(scope, target, (current) => ({
    ...(current ?? { stickers: [] }),
    stickers: [...(current?.stickers ?? []), { ...sticker, id, rotation: rotationFor(id) } as MessageSticker],
  }));
  return id;
}

export function removeSticker(scope: string, target: string, id: string) {
  updateMessage(scope, target, (current) => {
    const stickers = (current?.stickers ?? []).filter((sticker) => sticker.id !== id);
    if (!stickers.length && !current?.tapback) return undefined;
    return { ...(current?.tapback ? { tapback: current.tapback } : {}), stickers };
  });
}

const stickerMime = (path: string) => {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return undefined;
};

/** Adds one local image to the reusable sticker drawer, copied under the app's data dir. */
export async function addCustomStickerImage(): Promise<CustomSticker | undefined> {
  const picker = backend().pickImage ?? backend().pickFile;
  if (!picker) return undefined;
  const picked = backend().pickImage
    ? await backend().pickImage?.(tr("Choose a sticker image", "选择贴纸图片"))
    : await backend().pickFile?.(tr("Choose a sticker image", "选择贴纸图片"), ["png", "jpg", "jpeg", "gif", "webp"]);
  if (!picked) return undefined;
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const ext = picked.split(".").pop()?.toLowerCase() ?? "png";
  const dir = `${backend().dataDir().replace(/\/$/, "")}/stickers`;
  const path = `${dir}/${id}.${ext}`;
  await mkdir(dir, { recursive: true });
  await writeFile(path, await readFile(picked));
  const sticker: CustomSticker = { id, path, name: picked.split("/").pop() ?? id, ...(stickerMime(path) ? { mimeType: stickerMime(path) } : {}) };
  persist({ ...state(), customStickers: [...state().customStickers.filter((item) => item.path !== path), sticker] });
  return sticker;
}

/** The message snapshot a menu or reply focus needs; immutable because rows are immutable. */
export interface PipMessageSnapshot {
  scope: string;
  target: string;
  rowId: string;
  displayId: string;
  side: "left" | "right";
  author: string;
  excerpt: string;
  images: number;
  text: string;
  copyText?: string;
  fullText?: string;
  blocks?: TextViewBlock[];
  wide?: boolean;
  mediaOnly?: boolean;
  imageBlocks?: ImageContent[];
  /** Where this bubble sits in its cluster: corner shape and tail are part of its silhouette. */
  first?: boolean;
  last?: boolean;
  /** The curved tail flag exactly as the row renders it (`pip.tail` left, cluster `last` right). */
  tail?: boolean;
  /** Footnotes rendered inside the bubble, so a focus replica keeps its exact height. */
  footnotes?: TextViewDocument["footnotes"];
}

export interface PipMessageMenuState extends PipMessageSnapshot {
  x: number;
  y: number;
}

const menu = signal<PipMessageMenuState | undefined>(undefined);
export const pipMessageMenu = () => menu();
export function openPipMessageMenu(message: PipMessageSnapshot, x: number, y: number) {
  menu.set({ ...message, x, y });
}
export function closePipMessageMenu() {
  menu.set(undefined);
}

export interface PipReplyFocusFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PipReplyTarget extends PipMessageSnapshot {
  /** Where the original was measured before the focus layer's first frame, in that layer's coordinates. */
  initialFrame?: PipReplyFocusFrame;
}

const reply = signal<PipReplyTarget | undefined>(undefined);
export const pipReplyTarget = () => reply();

/** The transcript original temporarily veiled by its exact focus replica. */
const covered = signal<string | undefined>(undefined);
export const pipReplyCoveredId = () => covered();
export function coverPipReplyOriginal(displayId: string) {
  covered.set(displayId);
}
export function uncoverPipReplyOriginal(displayId?: string) {
  if (!displayId || covered() === displayId) covered.set(undefined);
}

/** Enters the reply-focus state for one message. No wire is written until the person actually sends. */
export function beginPipReply(message: PipMessageSnapshot, options?: { initialFrame?: PipReplyFocusFrame }) {
  menu.set(undefined);
  reply.set({ ...message, ...(options?.initialFrame ? { initialFrame: options.initialFrame } : {}) });
}

export function clearPipReply() {
  reply.set(undefined);
}

/** A quote preview asks the chat to bring its target back into view. */
const locate = signal<{ target: string; at: number } | undefined>(undefined);
export const pipReplyLocate = () => locate();
export function locatePipReply(target: string) {
  locate.set({ target, at: Date.now() });
}

/** Session changes drop transient interaction chrome; stored tapbacks and stickers stay put. */
export function resetPipInteractionChrome() {
  menu.set(undefined);
  reply.set(undefined);
  covered.set(undefined);
  locate.set(undefined);
}

/** The wire-ready fragment of the current reply target. */
export function replyWirePart(target: PipReplyTarget): ReplyPart {
  return {
    target: target.target,
    author: target.author,
    excerpt: target.excerpt,
    ...(target.images ? { images: target.images } : {}),
    side: target.side,
  };
}
