import type { TextViewBlock, TextViewInline } from "nsh/base";
import type { AudioContent, ImageContent, MediaResourceContent, ProtocolMediaBlock } from "../pi/protocol";
import type { Row, ToolRow } from "../pi/transcript";
import { basename } from "./format";
import { PENDING_LINK_URL } from "./mend";

export type MediaKind = "image" | "video" | "audio" | "document" | "archive" | "file";

export interface MediaItem {
  id: string;
  kind: MediaKind;
  title: string;
  caption?: string;
  /** Resolved local filesystem path (absolute, POSIX/Windows normalized). */
  path?: string;
  /** Local path or `data:...` URI displayable directly by native `<Image>`/`<Video>`/`AudioPlayer`. */
  src?: string;
  /** Remote `http://` / `https://` URL (rendered as safe clickable card, never auto-fetched). */
  remoteUrl?: string;
  mimeType?: string;
  data?: string;
  size?: number;
  width?: number;
  height?: number;
  missing?: boolean;
  isMarkdown?: boolean;
}

export interface FileAttachment {
  path: string;
  name: string;
  kind: MediaKind;
  mimeType?: string;
  size?: number;
}

export interface ResolvedMediaTarget {
  kind: MediaKind;
  title: string;
  path?: string;
  src?: string;
  remoteUrl?: string;
  mimeType?: string;
  data?: string;
  isMarkdown?: boolean;
}

export const RASTER_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tiff",
  "tif",
  "heic",
  "heif",
  "avif",
]);

export const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "ogv"]);

export const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "caf", "aiff"]);

export const DOCUMENT_EXTS = new Set([
  "pdf",
  "md",
  "markdown",
  "mdown",
  "txt",
  "rtf",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "svg",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pages",
  "numbers",
  "key",
]);

/** Deliverables that merit an inline card when linked alone on a paragraph (excludes generic plain text/config). */
const PROMOTED_DOC_EXTS = new Set([
  "pdf",
  "md",
  "markdown",
  "mdown",
  "csv",
  "html",
  "htm",
  "svg",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pages",
  "numbers",
  "key",
  "rtf",
]);

export const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "pkg"]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
  caf: "audio/x-caf",
  aiff: "audio/aiff",
  pdf: "application/pdf",
  md: "text/markdown",
  markdown: "text/markdown",
  mdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
  dmg: "application/x-apple-diskimage",
  gz: "application/gzip",
  tar: "application/x-tar",
};

const EXT_FROM_MIME: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "image/jpg": "JPG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
  "image/svg+xml": "SVG",
  "image/heic": "HEIC",
  "image/tiff": "TIFF",
  "video/mp4": "MP4",
  "video/quicktime": "MOV",
  "video/webm": "WEBM",
  "video/x-m4v": "M4V",
  "audio/mpeg": "MP3",
  "audio/mp3": "MP3",
  "audio/wav": "WAV",
  "audio/x-wav": "WAV",
  "audio/mp4": "M4A",
  "audio/aac": "AAC",
  "audio/ogg": "OGG",
  "audio/flac": "FLAC",
  "audio/opus": "OPUS",
  "application/pdf": "PDF",
  "text/markdown": "MD",
  "text/csv": "CSV",
  "application/zip": "ZIP",
};

export function fileExtension(pathOrName?: string): string {
  if (!pathOrName) return "";
  const clean = pathOrName.split(/[?#]/)[0].replace(/\\/g, "/");
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function isMarkdownPath(filePath?: string): boolean {
  const ext = fileExtension(filePath);
  return ext === "md" || ext === "markdown" || ext === "mdown";
}

export function mimeTypeForPath(filePath: string): string | undefined {
  const ext = fileExtension(filePath);
  return ext ? MIME_BY_EXT[ext] : undefined;
}

export function classifyMediaKind(pathOrName?: string, mimeType?: string): MediaKind {
  const ext = fileExtension(pathOrName);
  if (ext) {
    if (RASTER_IMAGE_EXTS.has(ext)) return "image";
    if (VIDEO_EXTS.has(ext)) return "video";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (DOCUMENT_EXTS.has(ext)) return "document";
    if (ARCHIVE_EXTS.has(ext)) return "archive";
  }
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "image/svg+xml") return "document";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime === "text/markdown" || mime === "text/csv") return "document";
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("gzip") || mime.includes("compressed")) return "archive";
  return "file";
}

export function extensionLabel(pathOrName?: string, mimeType?: string): string {
  const ext = fileExtension(pathOrName);
  if (ext && ext.length <= 6) return ext.toUpperCase();
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (EXT_FROM_MIME[mime]) return EXT_FROM_MIME[mime];
  if (mime.startsWith("image/")) return mime.slice(6).toUpperCase().slice(0, 5);
  if (mime.startsWith("video/")) return mime.slice(6).toUpperCase().slice(0, 5);
  if (mime.startsWith("audio/")) return mime.slice(6).toUpperCase().slice(0, 5);
  return "FILE";
}

/** True for files copied in a file manager that should attach as rich cards rather than plain text paths. */
export function isRichPasteFile(filePath: string): boolean {
  const kind = classifyMediaKind(filePath);
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "archive") return true;
  if (kind === "document") {
    const ext = fileExtension(filePath);
    return ext === "pdf" || ext === "doc" || ext === "docx" || ext === "xls" || ext === "xlsx" || ext === "ppt" || ext === "pptx" || ext === "pages" || ext === "numbers" || ext === "key";
  }
  return false;
}

export function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function formatMediaDuration(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function normalizePosixOrWin(rawPath: string): string {
  const winDrive = /^([A-Za-z]:)[/\\](.*)$/.exec(rawPath);
  const prefix = winDrive ? `${winDrive[1].toUpperCase()}/` : rawPath.startsWith("/") ? "/" : "";
  const rest = (winDrive ? winDrive[2] : rawPath.startsWith("/") ? rawPath.slice(1) : rawPath).replace(/\\/g, "/");
  const out: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!prefix) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = `${prefix}${out.join("/")}`;
  return joined || prefix || ".";
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
}

function stripFragment(raw: string): string {
  const hash = raw.indexOf("#");
  return hash >= 0 ? raw.slice(0, hash) : raw;
}

export function isLocalTarget(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === PENDING_LINK_URL) return false;
  if (/^(?:javascript|vbscript|mailto|tel|about|blob|data|attachment):/i.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("#")) return false;
  return true;
}

export function resolveMediaTarget(raw: string, cwd?: string, home?: string): ResolvedMediaTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === PENDING_LINK_URL || trimmed.startsWith("#")) return undefined;
  if (/^(?:javascript|vbscript|about|blob|attachment|mailto|tel):/i.test(trimmed)) return undefined;

  if (/^data:/i.test(trimmed)) {
    const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
    if (!match) return undefined;
    const mimeType = (match[1] ?? "application/octet-stream").trim().toLowerCase();
    const data = match[2].replace(/\s+/g, "");
    const kind = classifyMediaKind(undefined, mimeType);
    return {
      kind,
      title: kind === "image" ? "image" : kind === "audio" ? "audio" : "file",
      src: `data:${mimeType};base64,${data}`,
      mimeType,
      data,
    };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const cleanUrl = trimmed.split(/[?#]/)[0];
    const kind = classifyMediaKind(cleanUrl);
    const tail = basename(cleanUrl);
    let fallbackHost = trimmed;
    const hostMatch = /^https?:\/\/([^/]+)/i.exec(trimmed);
    if (hostMatch) fallbackHost = hostMatch[1];
    return {
      kind,
      title: tail && tail !== "/" ? tail : fallbackHost,
      remoteUrl: trimmed,
      mimeType: mimeTypeForPath(cleanUrl),
    };
  }

  let local = stripFragment(trimmed);
  if (/^file:\/\//i.test(local)) {
    try {
      let parsed = decodeURIComponent(local.slice("file://".length).replace(/^localhost(?=\/)/i, ""));
      if (/^\/[A-Za-z]:[/\\]/.test(parsed)) parsed = parsed.slice(1);
      local = parsed;
    } catch {
      return undefined;
    }
  } else if (home && (local === "~" || local.startsWith("~/") || local.startsWith("~\\"))) {
    const baseHome = home.replace(/[/\\]+$/, "");
    local = local === "~" ? baseHome : `${baseHome}/${local.slice(2)}`;
  }

  if (!local) return undefined;

  const resolvedPath = isAbsoluteFilePath(local)
    ? normalizePosixOrWin(local)
    : cwd
      ? normalizePosixOrWin(`${cwd.replace(/[/\\]+$/, "")}/${local}`)
      : normalizePosixOrWin(local);

  const kind = classifyMediaKind(resolvedPath);
  const title = basename(resolvedPath);
  return {
    kind,
    title: title && title !== "/" ? title : resolvedPath,
    path: resolvedPath,
    src: resolvedPath,
    mimeType: mimeTypeForPath(resolvedPath),
    isMarkdown: isMarkdownPath(resolvedPath),
  };
}

// ── User attachment wire blocks (<attachment ... />) ──────────────────────────

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unattr = (value: string) => value.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function attachmentTag(file: FileAttachment): string {
  const parts = [`path="${attr(file.path)}"`, `kind="${attr(file.kind)}"`];
  if (file.mimeType) parts.push(`mime="${attr(file.mimeType)}"`);
  if (typeof file.size === "number" && Number.isFinite(file.size)) parts.push(`size="${Math.max(0, Math.round(file.size))}"`);
  return `<attachment ${parts.join(" ")} />`;
}

export function composeFileMessage(said: string, files: readonly FileAttachment[]): string {
  const words = said.trim();
  if (!files.length) return words;
  const block = files.map(attachmentTag).join("\n");
  return words ? `${words}\n\n${block}` : block;
}

const ATTACHMENT_LINE = /^<attachment\s+([^>\n]*?)\s*\/>$/;
const ATTR_PAIR = /([a-zA-Z]+)="([^"\n]*)"/g;
const MEDIA_KINDS = new Set<string>(["image", "video", "audio", "document", "archive", "file"]);

function parseAttachmentLine(line: string): FileAttachment | undefined {
  const hit = ATTACHMENT_LINE.exec(line);
  if (!hit) return undefined;
  const attrs: Record<string, string> = {};
  for (const pair of hit[1].matchAll(ATTR_PAIR)) {
    attrs[pair[1]] = unattr(pair[2]);
  }
  const path = attrs.path;
  if (!path) return undefined;
  const kind = MEDIA_KINDS.has(attrs.kind ?? "") ? (attrs.kind as MediaKind) : classifyMediaKind(path, attrs.mime);
  const size = attrs.size !== undefined ? Number(attrs.size) : undefined;
  return {
    path,
    name: basename(path),
    kind,
    ...(attrs.mime ? { mimeType: attrs.mime } : {}),
    ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
  };
}

function parseAttachmentBlock(tail: string): FileAttachment[] | undefined {
  const lines = tail.split("\n");
  if (!lines.length) return undefined;
  const out: FileAttachment[] = [];
  for (const line of lines) {
    const parsed = parseAttachmentLine(line);
    if (!parsed) return undefined;
    out.push(parsed);
  }
  return out.length ? out : undefined;
}

/** Extracts a trailing `<attachment ... />` block from a user message, leaving inline mentions untouched. */
export function splitFileMessage(text: string): { said: string; files: FileAttachment[] } {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.includes("<attachment ")) return { said: text, files: [] };
  if (trimmed.startsWith("<attachment ")) {
    const files = parseAttachmentBlock(trimmed);
    if (files) return { said: "", files };
  }
  const marker = "\n\n<attachment ";
  let at = trimmed.lastIndexOf(marker);
  while (at >= 0) {
    const files = parseAttachmentBlock(trimmed.slice(at + 2));
    if (files) return { said: trimmed.slice(0, at), files };
    at = trimmed.lastIndexOf(marker, at - 1);
  }
  return { said: text, files: [] };
}

/** Strips a trailing `<attachment ... />` block for session titles; falls back to the first file's name. */
export function stripTrailingAttachments(text: string): { said: string; firstAttachmentName?: string } {
  const { said, files } = splitFileMessage(text);
  if (!files.length) return { said: text };
  return { said, firstAttachmentName: files[0]?.name };
}

// ── Markdown block media extraction ───────────────────────────────────────────

export interface BlockMediaExtraction {
  mode: "none" | "pure" | "mixed";
  items: MediaItem[];
  strippedBlock?: Extract<TextViewBlock, { type: "paragraph" }>;
}

function inlineText(content: readonly TextViewInline[]): string {
  let out = "";
  for (const node of content) {
    if (node.type === "text") out += node.text;
    else if (node.type === "code") out += node.code;
    else if (node.type === "keyboard") out += node.text;
    else if (node.type === "break") out += "\n";
    else if ("content" in node && node.content) out += inlineText(node.content);
  }
  return out;
}

function isMediaEligibleLink(resolved: ResolvedMediaTarget, standalone: boolean): boolean {
  if (!resolved.path) return false;
  if (resolved.kind === "image" || resolved.kind === "video" || resolved.kind === "audio") return true;
  if (!standalone) return false;
  if (resolved.kind === "archive") return true;
  if (resolved.kind === "document") {
    const ext = fileExtension(resolved.path);
    return PROMOTED_DOC_EXTS.has(ext);
  }
  return false;
}

function mediaItemFromResolved(id: string, resolved: ResolvedMediaTarget, titleOverride?: string, caption?: string): MediaItem {
  return {
    id,
    kind: resolved.kind,
    title: titleOverride?.trim() || resolved.title,
    ...(caption?.trim() ? { caption: caption.trim() } : {}),
    ...(resolved.path ? { path: resolved.path } : {}),
    ...(resolved.src ? { src: resolved.src } : {}),
    ...(resolved.remoteUrl ? { remoteUrl: resolved.remoteUrl } : {}),
    ...(resolved.mimeType ? { mimeType: resolved.mimeType } : {}),
    ...(resolved.data ? { data: resolved.data } : {}),
    ...(resolved.isMarkdown ? { isMarkdown: true } : {}),
  };
}

/**
 * Inspects a Markdown paragraph block for inline images (`![alt](target)`), video/audio/document links.
 * - Pure media paragraphs render solely as native media cards/players (`mode: "pure"`).
 * - Mixed text + media paragraphs keep the prose (stripping standalone `image` nodes) and attach the media below (`mode: "mixed"`).
 */
export function extractBlockMedia(block: TextViewBlock, cwd?: string, home?: string, idPrefix = "md"): BlockMediaExtraction {
  if (block.type !== "paragraph" || !block.content.length) return { mode: "none", items: [] };

  const meaningful = block.content.filter((node) => {
    if (node.type === "break") return false;
    if (node.type === "text" && !node.text.trim()) return false;
    return true;
  });

  if (!meaningful.length) return { mode: "none", items: [] };

  const items: MediaItem[] = [];
  const kept: TextViewInline[] = [];
  let standaloneLinkOnly = meaningful.length === 1 && meaningful[0].type === "link";
  let removedAnyInline = false;

  for (let i = 0; i < block.content.length; i++) {
    const node = block.content[i];
    if (node.type === "image") {
      const resolved = resolveMediaTarget(node.src, cwd, home);
      if (resolved) {
        items.push(mediaItemFromResolved(`${idPrefix}:${i}`, resolved, node.title || node.alt, node.title && node.alt ? node.alt : undefined));
        removedAnyInline = true;
        continue;
      }
      kept.push(node);
      continue;
    }

    if (node.type === "link") {
      // Handle `[![alt](img)](href)` cleanly as a media item when it's an image inside a link.
      const imgInside = node.content.length === 1 && node.content[0].type === "image" ? node.content[0] : undefined;
      if (imgInside) {
        const resolved = resolveMediaTarget(imgInside.src, cwd, home);
        if (resolved) {
          items.push(mediaItemFromResolved(`${idPrefix}:${i}`, resolved, imgInside.title || imgInside.alt));
          removedAnyInline = true;
          continue;
        }
      }
      if (isLocalTarget(node.url)) {
        const resolved = resolveMediaTarget(node.url, cwd, home);
        if (resolved && isMediaEligibleLink(resolved, standaloneLinkOnly)) {
          const label = inlineText(node.content).trim();
          items.push(mediaItemFromResolved(`${idPrefix}:${i}`, resolved, label || resolved.title));
          if (!standaloneLinkOnly) kept.push(node);
          else removedAnyInline = true;
          continue;
        }
      }
      kept.push(node);
      continue;
    }

    kept.push(node);
  }

  if (!items.length) return { mode: "none", items: [] };

  const hasRemainingContent = kept.some((node) => {
    if (node.type === "break") return false;
    if (node.type === "text" && !node.text.trim()) return false;
    return true;
  });

  if (!hasRemainingContent) return { mode: "pure", items };

  return {
    mode: "mixed",
    items,
    ...(removedAnyInline ? { strippedBlock: { type: "paragraph", content: trimEdgeBreaks(kept) } } : {}),
  };
}

function trimEdgeBreaks(content: TextViewInline[]): TextViewInline[] {
  let start = 0;
  let end = content.length;
  while (start < end) {
    const node = content[start];
    if (node.type === "break" || (node.type === "text" && !node.text.trim())) start++;
    else break;
  }
  while (end > start) {
    const node = content[end - 1];
    if (node.type === "break" || (node.type === "text" && !node.text.trim())) end--;
    else break;
  }
  return content.slice(start, end);
}

/** Collects resolved local paths referenced by media nodes in Markdown prose (for deduplicating auto-surfaced tool media). */
export function extractMarkdownMediaPaths(markdown: string, cwd?: string, home?: string): Set<string> {
  const paths = new Set<string>();
  const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const hit of markdown.matchAll(re)) {
    const resolved = resolveMediaTarget(hit[1], cwd, home);
    if (!resolved?.path) continue;
    const isEmbed = hit[0].startsWith("!");
    if (isEmbed || resolved.kind === "image" || resolved.kind === "video" || resolved.kind === "audio") {
      paths.add(resolved.path);
    }
  }
  return paths;
}

// ── Protocol & tool-result media extraction ───────────────────────────────────

const ACP_TOOL_VERB_PREFIX = /^(?:running|run|calling|call|using|use|invoking|invoke|executing|execute|tool)\s*:?\s+/i;

/**
 * Strips MCP server namespaces (`mcp__server__tool`, `mcp:server:tool`,
 * `mcp/server/tool`, `mcp.server.tool`, Antigravity's `mcp_pipi_tool`, and
 * direct `pipi:tool` / `pipi__tool` forms), including ACP display prefixes
 * such as `"Run mcp_pipi_present_files"`.
 */
export function normalizeMcpToolName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) return "";
  const withoutVerb = trimmed.replace(ACP_TOOL_VERB_PREFIX, "").trim();
  const stripNamespace = (value: string): string | undefined => {
    const lower = value.toLowerCase();
    let match = /^mcp__[^_]+__(.+)$/.exec(lower);
    if (match) return match[1];
    match = /^mcp[:/.][^:/.]+[:/.](.+)$/.exec(lower);
    if (match) return match[1];
    match = /^mcp_(?:pipi|t3[-_]code)_(.+)$/.exec(lower);
    if (match) return match[1];
    match = /^(?:pipi|t3[-_]code)(?:__|[:/.]|_)(.+)$/.exec(lower);
    if (match) return match[1];
    return undefined;
  };
  const stripped = stripNamespace(trimmed) ?? stripNamespace(withoutVerb);
  if (stripped) return stripped.replace(/[\s-]+/g, "_");
  return trimmed.toLowerCase().replace(/[\s-]+/g, "_");
}

export function isPresentFilesTool(rawName: string): boolean {
  if (normalizeMcpToolName(rawName) === "present_files") return true;
  const bare = rawName
    .trim()
    .replace(ACP_TOOL_VERB_PREFIX, "")
    .trim()
    .replace(/\?+$/, "")
    .trim()
    .toLowerCase();
  if (!bare) return false;
  if (bare.replace(/[\s-]+/g, "_") === "present_files") return true;
  return /^(?:mcp_[a-z0-9-]+_|[a-z0-9._-]+(?:__|:))present[-_\s]files$/.test(bare);
}

interface RawPresentedEntry {
  path?: unknown;
  url?: unknown;
  uri?: unknown;
  title?: unknown;
  caption?: unknown;
  kind?: unknown;
  mimeType?: unknown;
  size?: unknown;
  width?: unknown;
  height?: unknown;
  exists?: unknown;
  remoteUrl?: unknown;
}

function presentedItem(raw: unknown, id: string, cwd?: string, home?: string): MediaItem | undefined {
  if (typeof raw === "string") {
    const resolved = resolveMediaTarget(raw, cwd, home);
    return resolved ? mediaItemFromResolved(id, resolved) : undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as RawPresentedEntry;
  const targetStr =
    typeof rec.remoteUrl === "string" && rec.remoteUrl
      ? rec.remoteUrl
      : typeof rec.path === "string" && rec.path
        ? rec.path
        : typeof rec.url === "string" && rec.url
          ? rec.url
          : typeof rec.uri === "string" && rec.uri
            ? rec.uri
            : "";
  if (!targetStr) return undefined;
  const resolved = resolveMediaTarget(targetStr, cwd, home);
  if (!resolved) return undefined;
  const kind = MEDIA_KINDS.has(String(rec.kind ?? "")) ? (rec.kind as MediaKind) : resolved.kind;
  const title = typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : resolved.title;
  const caption = typeof rec.caption === "string" && rec.caption.trim() ? rec.caption.trim() : undefined;
  return {
    id,
    kind,
    title,
    ...(caption ? { caption } : {}),
    ...(resolved.path ? { path: resolved.path } : {}),
    ...(resolved.src ? { src: resolved.src } : {}),
    ...(resolved.remoteUrl ? { remoteUrl: resolved.remoteUrl } : {}),
    mimeType: typeof rec.mimeType === "string" && rec.mimeType ? rec.mimeType : resolved.mimeType,
    ...(typeof rec.size === "number" && Number.isFinite(rec.size) ? { size: rec.size } : {}),
    ...(typeof rec.width === "number" && Number.isFinite(rec.width) ? { width: rec.width } : {}),
    ...(typeof rec.height === "number" && Number.isFinite(rec.height) ? { height: rec.height } : {}),
    ...(rec.exists === false ? { missing: true } : {}),
    ...(resolved.isMarkdown ? { isMarkdown: true } : {}),
  };
}

export function extractPresentedMedia(
  row: Pick<ToolRow, "id" | "name" | "args" | "output" | "details">,
  cwd?: string,
  home?: string,
): { title?: string; items: MediaItem[] } | undefined {
  const byName = isPresentFilesTool(row.name);

  const fromStructured = (obj: unknown, requireMarker: boolean): { title?: string; items: MediaItem[] } | undefined => {
    if (!obj || typeof obj !== "object") return undefined;
    const rec = obj as { pipiMedia?: unknown; title?: unknown; items?: unknown; files?: unknown };
    if (requireMarker && rec.pipiMedia !== true) return undefined;
    const list = Array.isArray(rec.items) ? rec.items : Array.isArray(rec.files) ? rec.files : undefined;
    if (!list) return undefined;
    const items = list
      .map((entry, idx) => presentedItem(entry, `${row.id}:p:${idx}`, cwd, home))
      .filter((item): item is MediaItem => Boolean(item));
    if (!items.length) return undefined;
    const title = typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : undefined;
    return { ...(title ? { title } : {}), items };
  };

  // Recognize pipi's own `{ pipiMedia: true }` payload even if an ACP harness replaced the tool title.
  const fromDetails = fromStructured(row.details, !byName);
  if (fromDetails) return fromDetails;

  const trimmedOutput = row.output?.trim();
  if (trimmedOutput && (byName || trimmedOutput.includes('"pipiMedia"'))) {
    try {
      const parsed = fromStructured(JSON.parse(trimmedOutput), !byName);
      if (parsed) return parsed;
    } catch {}
  }

  if (!byName) return undefined;

  const args = row.args ?? {};
  const argFiles = Array.isArray(args.files) ? args.files : typeof args.path === "string" ? [args.path] : undefined;
  if (argFiles) {
    const items = argFiles
      .map((entry, idx) => presentedItem(entry, `${row.id}:arg:${idx}`, cwd, home))
      .filter((item): item is MediaItem => Boolean(item));
    if (items.length) {
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
      return { ...(title ? { title } : {}), items };
    }
  }

  return undefined;
}

export function mediaItemFromProtocolBlock(
  block: ImageContent | AudioContent | MediaResourceContent,
  id: string,
  cwd?: string,
  home?: string,
): MediaItem | undefined {
  if (block.type === "image") {
    if (!block.data) return undefined;
    const mimeType = block.mimeType || "image/png";
    return {
      id,
      kind: "image",
      title: `image.${extensionLabel(undefined, mimeType).toLowerCase()}`,
      src: `data:${mimeType};base64,${block.data}`,
      mimeType,
      data: block.data,
    };
  }
  if (block.type === "audio") {
    if (!block.data) return undefined;
    const mimeType = block.mimeType || "audio/mpeg";
    return {
      id,
      kind: "audio",
      title: `audio.${extensionLabel(undefined, mimeType).toLowerCase()}`,
      src: `data:${mimeType};base64,${block.data}`,
      mimeType,
      data: block.data,
    };
  }
  if (block.type === "resource") {
    const resolved = block.uri ? resolveMediaTarget(block.uri, cwd, home) : undefined;
    const mimeType = block.mimeType || resolved?.mimeType;
    const kind = classifyMediaKind(resolved?.path ?? block.name ?? block.uri, mimeType);
    const title = block.title || block.name || resolved?.title || "file";
    if (block.data && mimeType && !resolved?.path) {
      return {
        id,
        kind,
        title,
        src: `data:${mimeType};base64,${block.data}`,
        mimeType,
        data: block.data,
        ...(typeof block.size === "number" ? { size: block.size } : {}),
      };
    }
    if (resolved) {
      return {
        id,
        kind,
        title,
        ...(resolved.path ? { path: resolved.path } : {}),
        ...(resolved.src ? { src: resolved.src } : {}),
        ...(resolved.remoteUrl ? { remoteUrl: resolved.remoteUrl } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof block.size === "number" ? { size: block.size } : {}),
        ...(resolved.isMarkdown ? { isMarkdown: true } : {}),
      };
    }
  }
  return undefined;
}

export function mediaRowFromProtocolBlock(
  block: ProtocolMediaBlock,
  id: string,
  cwd?: string,
  home?: string,
): { title?: string; items: MediaItem[] } | undefined {
  if (block.type === "presented_media") {
    if (!Array.isArray(block.items) || !block.items.length) return undefined;
    const items = block.items
      .map((entry, idx) => presentedItem(entry, `${id}:pm:${idx}`, cwd, home))
      .filter((item): item is MediaItem => Boolean(item));
    if (!items.length) return undefined;
    const title = typeof block.title === "string" && block.title.trim() ? block.title.trim() : undefined;
    return { ...(title ? { title } : {}), items };
  }
  const item = mediaItemFromProtocolBlock(block, id, cwd, home);
  return item ? { items: [item] } : undefined;
}

export function extractToolResultMedia(
  row: Pick<ToolRow, "id" | "name" | "args" | "output" | "details" | "imageBlocks" | "resources">,
  cwd?: string,
  home?: string,
): MediaItem[] {
  const presented = extractPresentedMedia(row, cwd, home);
  if (presented) return presented.items;

  const items: MediaItem[] = [];
  (row.imageBlocks ?? []).forEach((img, idx) => {
    const item = mediaItemFromProtocolBlock(img, `${row.id}:img:${idx}`, cwd, home);
    if (item) items.push(item);
  });
  (row.resources ?? []).forEach((res, idx) => {
    const item = mediaItemFromProtocolBlock(res, `${row.id}:res:${idx}`, cwd, home);
    if (item) items.push(item);
  });
  return items;
}

// ── Stream-wide image collection (for lightbox prev/next navigation) ──────────

/** True for local/base64 image items that can render inside the native image viewer. */
export function isPreviewableImage(item: MediaItem, isMissingPath?: (path: string) => boolean): boolean {
  if (item.kind !== "image") return false;
  if (item.remoteUrl || item.missing) return false;
  if (!item.src && !item.data) return false;
  if (item.path && isMissingPath?.(item.path)) return false;
  return true;
}

/** Strips fenced code blocks and inline code spans so example Markdown inside code never enters the photo stream. */
function stripMarkdownCode(markdown: string): string {
  return markdown
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, "\n")
    .replace(/`[^`\n]+`/g, "");
}

/**
 * Extracts previewable local/data images referenced in Markdown prose (both
 * `![alt](target "title")` embeds and `[label](local-image.png)` links) in
 * document order.
 */
export function extractMarkdownImages(markdown: string, cwd?: string, home?: string, idPrefix = "md"): MediaItem[] {
  if (!markdown) return [];
  const cleaned = stripMarkdownCode(markdown);
  const out: MediaItem[] = [];
  const re = /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"([^"\n]*)")?\s*\)/g;
  let idx = 0;
  for (const hit of cleaned.matchAll(re)) {
    const isEmbed = hit[1] === "!";
    const label = (hit[2] ?? "").trim();
    const rawTarget = (hit[3] ?? hit[4] ?? "").trim();
    const titleAttr = (hit[5] ?? "").trim();
    if (!rawTarget) continue;
    if (!isEmbed && !isLocalTarget(rawTarget)) continue;
    const resolved = resolveMediaTarget(rawTarget, cwd, home);
    if (!resolved || resolved.kind !== "image" || resolved.remoteUrl) continue;
    if (!resolved.src && !resolved.data) continue;
    out.push(
      mediaItemFromResolved(
        `${idPrefix}:img:${idx++}`,
        resolved,
        titleAttr || label || resolved.title,
        titleAttr && label ? label : undefined,
      ),
    );
  }
  return out;
}

function streamImageDedupKey(item: MediaItem): string {
  if (item.path) return `path:${item.path}`;
  if (item.src) return `src:${item.src}`;
  if (item.data) return `data:${item.mimeType ?? ""}:${item.data.slice(0, 64)}:${item.data.length}`;
  return `id:${item.id}`;
}

/** Stable identity key for matching a clicked `MediaItem` against its entry in the stream gallery. */
export function findMediaImageIndex(list: readonly MediaItem[], target: MediaItem): number {
  const byId = list.findIndex((item) => item.id === target.id);
  if (byId >= 0) return byId;
  if (target.path) {
    const byPath = list.findIndex((item) => item.path === target.path);
    if (byPath >= 0) return byPath;
  }
  if (target.src) {
    const bySrc = list.findIndex((item) => item.src === target.src);
    if (bySrc >= 0) return bySrc;
  }
  if (target.data) {
    const byData = list.findIndex((item) => item.data === target.data && item.mimeType === target.mimeType);
    if (byData >= 0) return byData;
  }
  return -1;
}

const READ_TOOL_NAMES = new Set(["read", "read_file", "read_files", "view_file", "cat", "open_file"]);
const isTurnRowKind = (row: Row): row is Extract<Row, { kind: "text" | "thinking" | "tool" | "media" }> =>
  row.kind === "text" || row.kind === "thinking" || row.kind === "tool" || row.kind === "media";

/**
 * Collects every previewable image across a conversation's transcript in
 * on-screen chronological order (user pasted images & image attachments,
 * assistant Markdown images, surfaced `present_files` / tool images, and
 * delivered replies), deduplicating tool echoes against the turn's answer and
 * `present_files` rows the same way `buildDisplayRows` does.
 */
export function collectTranscriptImages(
  rows: readonly Row[],
  context?: { cwd?: string; home?: string; isMissingPath?: (path: string) => boolean },
): MediaItem[] {
  const cwd = context?.cwd;
  const home = context?.home;
  const isMissingPath = context?.isMissingPath;
  const out: MediaItem[] = [];

  for (let i = 0; i < rows.length; ) {
    const row = rows[i];

    if (row.kind === "user") {
      (row.imageBlocks ?? []).forEach((img, idx) => {
        if (!img.data) return;
        const mimeType = img.mimeType || "image/png";
        const count = row.imageBlocks?.length ?? 1;
        out.push({
          id: `${row.id}:img:${idx}`,
          kind: "image",
          title: count > 1 ? `Image ${idx + 1}` : "Image",
          src: `data:${mimeType};base64,${img.data}`,
          mimeType,
          data: img.data,
        });
      });
      const { files } = splitFileMessage(row.text);
      files.forEach((file, idx) => {
        if (file.kind !== "image") return;
        const resolved = resolveMediaTarget(file.path, cwd, home);
        const item: MediaItem = {
          id: `${row.id}:att:${idx}`,
          kind: "image",
          title: file.name,
          path: resolved?.path ?? file.path,
          ...(resolved?.src ? { src: resolved.src } : {}),
          ...(file.mimeType ? { mimeType: file.mimeType } : resolved?.mimeType ? { mimeType: resolved.mimeType } : {}),
          ...(typeof file.size === "number" ? { size: file.size } : {}),
        };
        if (isPreviewableImage(item, isMissingPath)) out.push(item);
      });
      i++;
      continue;
    }

    if (row.kind === "delivery") {
      for (const img of extractMarkdownImages(row.text, cwd, home, row.id)) {
        if (isPreviewableImage(img, isMissingPath)) out.push(img);
      }
      i++;
      continue;
    }

    if (!isTurnRowKind(row)) {
      i++;
      continue;
    }

    // Group one assistant turn the same way `buildDisplayRows` lays it out:
    // commentary/answer Markdown images first, then deduplicated surfaced media.
    const directMedia: MediaItem[] = [];
    const toolPresented: MediaItem[] = [];
    const autoMedia: MediaItem[] = [];
    const commentaryImages: MediaItem[] = [];
    const answerImages: MediaItem[] = [];
    const answerPaths = new Set<string>();
    const first = row;

    for (; i < rows.length; i++) {
      const cur = rows[i];
      if (!isTurnRowKind(cur)) break;
      if (cur !== first && cur.turnStart && answerImages.length > 0) break;

      if (cur.kind === "media") {
        for (const item of cur.items) {
          if (isPreviewableImage(item, isMissingPath)) directMedia.push(item);
        }
        continue;
      }
      if (cur.kind === "tool") {
        if (cur.status !== "done") continue;
        const presented = extractPresentedMedia(cur, cwd, home);
        if (presented && presented.items.length > 0) {
          for (const item of presented.items) {
            if (isPreviewableImage(item, isMissingPath)) toolPresented.push(item);
          }
        } else if (!READ_TOOL_NAMES.has(normalizeMcpToolName(cur.name)) && (cur.imageBlocks?.length || cur.resources?.length)) {
          for (const item of extractToolResultMedia(cur, cwd, home)) {
            if (isPreviewableImage(item, isMissingPath)) autoMedia.push(item);
          }
        }
        continue;
      }
      if (cur.kind === "text" && cur.text.trim()) {
        const imgs = extractMarkdownImages(cur.text, cwd, home, cur.id).filter((img) => isPreviewableImage(img, isMissingPath));
        if (cur.final) {
          answerImages.push(...imgs);
          for (const p of extractMarkdownMediaPaths(cur.text, cwd, home)) answerPaths.add(p);
        } else {
          commentaryImages.push(...imgs);
        }
      }
    }

    const turnSeen = new Set<string>();
    const pushUnique = (item: MediaItem) => {
      const key = streamImageDedupKey(item);
      if (turnSeen.has(key)) return;
      turnSeen.add(key);
      out.push(item);
    };
    for (const img of commentaryImages) pushUnique(img);
    for (const img of answerImages) pushUnique(img);
    for (const img of directMedia) pushUnique(img);
    for (const img of toolPresented) pushUnique(img);
    for (const img of autoMedia) {
      if (img.path && answerPaths.has(img.path)) continue;
      pushUnique(img);
    }
  }

  return out;
}
