import type { Lang } from "./i18n";

/** Small formatters shared by the screens. Pure functions: no signals, no I/O. */

/** The last part of a path: a folder's own name. */
export function basename(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

/** A path with the home directory written `~`. */
export function tildePath(path: string, home: string) {
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * Middle-shortens a long file path (`~/.nvm/versions/node/v24.13.0/bin/claude` →
 * `~/.nvm/…/v24.13.0/bin/claude`) so both its origin and its basename stay readable
 * on a single line without awkward mid-segment wrapping.
 */
export function compactPath(path: string, maxChars = 36) {
  if (path.length <= maxChars) return path;
  const parts = path.split("/").filter(Boolean);
  const leadingSlash = path.startsWith("/");
  if (parts.length <= 2) {
    const keepHead = Math.max(8, Math.floor((maxChars - 1) * 0.45));
    const keepTail = Math.max(8, maxChars - 1 - keepHead);
    return `${path.slice(0, keepHead)}…${path.slice(-keepTail)}`;
  }
  const prefix = leadingSlash ? `/${parts[0]}` : parts[0] === "~" && parts.length > 3 ? `~/${parts[1]}` : parts[0];
  let tail = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 1; i--) {
    const candidate = `${parts[i]}/${tail}`;
    if (prefix.length + 2 + candidate.length > maxChars) break;
    tail = candidate;
  }
  const joined = `${prefix}/…/${tail}`;
  if (joined.length <= maxChars) return joined;
  const budget = Math.max(10, maxChars - prefix.length - 2);
  return `${prefix}/…/${tail.slice(-budget)}`;
}

/** How long ago, briefly: "now", "5m", "3h", "2d", then a date. */
export function relativeTime(then: number, now = Date.now(), lang: Lang = "en") {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return lang === "zh" ? "刚刚" : "now";
  if (minutes < 60) return lang === "zh" ? `${minutes}分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return lang === "zh" ? `${hours}小时` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return lang === "zh" ? `${days}天` : `${days}d`;
  return new Date(then).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
}

/** The day a time falls in, relative to today, for grouping a list. */
export function dayGroup(then: number, now = Date.now(), lang: Lang = "en"): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (then >= startOfToday) return lang === "zh" ? "今天" : "Today";
  if (then >= startOfToday - 86_400_000) return lang === "zh" ? "昨天" : "Yesterday";
  if (then >= startOfToday - 7 * 86_400_000) return lang === "zh" ? "过去 7 天" : "Previous 7 days";
  return lang === "zh" ? "更早" : "Older";
}

/** A duration for people: "320ms", "4.2s", "1m 12s". */
export function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** US dollars: "$0.004", "$1.27". */
export function money(dollars: number) {
  if (dollars === 0) return "$0";
  return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

/** Bounds text for the screen: the first `maxLines` lines and `maxChars` characters, and how many lines were left out. */
export function clip(text: string, maxLines: number, maxChars = 24_000) {
  let shown = text.length > maxChars ? text.slice(0, maxChars) : text;
  const lines = shown.split("\n");
  const total = text.split("\n").length;
  if (lines.length > maxLines) shown = lines.slice(0, maxLines).join("\n");
  const kept = Math.min(lines.length, maxLines);
  return { text: shown.replace(/\s+$/, ""), hidden: Math.max(0, total - kept) };
}
