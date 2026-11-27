/**
 * A document on its way to an agent, and read back out of what was sent.
 *
 * A document rides on a message the way an image does: it is attached, not
 * pasted. What the agent gets is the person's words first — they title the
 * session, and they are what a folded bubble shows — then each document in a
 * block that names its file, so an agent with file tools can change the
 * document where it lives:
 *
 *     Tighten the second paragraph
 *
 *     <document path="/…/docs/note-2026-11-18.md">
 *     # Why I do not like …
 *     </document>
 *
 * A message with no words of its own *is* the document: one written to be
 * sent (a brief, a prompt) goes as its text and nothing else.
 *
 * No part of the app strips these blocks from a message: the transcript, the
 * queue and the session's title all keep the wire text, and only the bubble
 * (`views/Rows.tsx`) reads the blocks back as cards.
 */

import { stripTrailingAttachments } from "./media";

export interface DocPart {
  /** The document's file. */
  path: string;
  /** Its Markdown — or the selected passage's text. */
  text: string;
  /** A passage selected in the document rather than all of it. */
  excerpt?: boolean;
}

/** Inline document-editor intent appended after `<document>`/`<selection>` so agents edit the live open file directly. */
export interface DocEditorContext {
  path: string;
  editable: boolean;
  scope?: "document" | "selection";
}

const tagOf = (part: DocPart) => (part.excerpt ? "selection" : "document");
const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const unattr = (value: string) => value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function block(part: DocPart) {
  const tag = tagOf(part);
  return `<${tag} path="${attr(part.path)}">\n${part.text.trim()}\n</${tag}>`;
}

/** Trailing context block that tells any agent the user is looking at this live document and expects direct edits to its file. */
export function formatDocEditorContext(ctx: DocEditorContext): string {
  const pathAttr = attr(ctx.path);
  const scopeAttr = ctx.scope === "selection" ? ' scope="selection"' : "";
  if (!ctx.editable) {
    return [
      `<doc_editor_context path="${pathAttr}" editable="false"${scopeAttr}>`,
      `The user is viewing this Markdown document in read-only mode in pipi. Do not modify the file on disk unless the user asks to edit the raw file; answer in chat instead.`,
      `</doc_editor_context>`,
    ].join("\n");
  }
  if (ctx.scope === "selection") {
    return [
      `<doc_editor_context path="${pathAttr}" editable="true" scope="selection">`,
      `The user is viewing this live Markdown document in pipi with the above passage selected, and sent this message from the document's floating assistant.`,
      `Default expectation: update only that selected passage in-place inside "${ctx.path}" with your file tools (read the file first if needed to locate its exact context, and keep the rest of the document untouched) — changes on disk appear immediately in the open editor with one-click Undo.`,
      `Do not create another file, and do not merely paste a replacement draft in chat when the user wants that passage updated; after editing the file, reply briefly summarizing what changed.`,
      `Only leave the file untouched if the user is purely asking a question or clarification about the selection.`,
      `</doc_editor_context>`,
    ].join("\n");
  }
  return [
    `<doc_editor_context path="${pathAttr}" editable="true">`,
    `The user is viewing this live Markdown document in pipi and sent this message from the document's floating assistant.`,
    `Default expectation: edit or write directly into "${ctx.path}" with your file tools — changes on disk appear immediately in the open editor with one-click Undo.`,
    `Do not create another file, and do not merely paste a replacement draft in chat when the user wants the document written or updated; after editing the file, reply briefly summarizing what changed.`,
    `Only leave the file untouched if the user is purely asking a question, review, or clarification with no changes requested.`,
    `</doc_editor_context>`,
  ].join("\n");
}

/** Strips a trailing `<doc_editor_context>` block appended for the model, keeping everything else intact. */
export function stripDocEditorContext(text: string): string {
  return text.replace(/\s*<doc_editor_context\b[^>]*>[\s\S]*?<\/doc_editor_context>\s*$/, "");
}

/** A message a quote-reply points back to. `target` is pipi's stable in-transcript anchor, not engine state. */
export interface ReplyPart {
  target: string;
  author: string;
  excerpt: string;
  images?: number;
  side?: "left" | "right";
}

const REPLY_EXCERPT_MAX = 240;
const xmlText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlAttr = (value: string) => xmlText(value).replace(/"/g, "&quot;");
const unxml = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** One compact line of quoted context; the wire carries an excerpt, never the whole message again. */
export function replyExcerpt(text: string, max = REPLY_EXCERPT_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The structured quote prefix every engine receives ahead of the person's own words. */
export function composeReplyMessage(reply: ReplyPart, said: string): string {
  const excerpt = replyExcerpt(reply.excerpt);
  const attrs = [
    `target="${xmlAttr(reply.target)}"`,
    `author="${xmlAttr(reply.author)}"`,
    ...(reply.images ? [`images="${reply.images}"`] : []),
    ...(reply.side ? [`side="${reply.side}"`] : []),
  ].join(" ");
  const prefix = `<pipi-reply ${attrs}>${xmlText(excerpt)}</pipi-reply>`;
  const words = said.trim();
  return words ? `${prefix}\n\n${words}` : prefix;
}

const REPLY_OPEN = /^\s*<pipi-reply\b([^>]*)>([\s\S]*?)<\/pipi-reply>/;
const REPLY_ATTR = /([\w-]+)="([^"]*)"/g;

/** Reads a leading `<pipi-reply>` block; anything after it is the message the person wrote. */
export function splitReplyMessage(text: string): { said: string; reply?: ReplyPart } {
  const hit = REPLY_OPEN.exec(text);
  if (!hit) return { said: text };
  const attrs: Record<string, string> = {};
  for (const match of hit[1].matchAll(REPLY_ATTR)) attrs[match[1]] = unxml(match[2]);
  const said = text.slice(hit[0].length).replace(/^\n\n/, "");
  if (!attrs.target && !attrs.author) return { said: text };
  const images = Number(attrs.images ?? 0);
  return {
    said,
    reply: {
      target: attrs.target ?? "",
      author: attrs.author ?? "",
      excerpt: unxml(hit[2]),
      ...(images > 0 ? { images } : {}),
      ...(attrs.side === "left" || attrs.side === "right" ? { side: attrs.side } : {}),
    },
  };
}

/** The visible message without its quote-control prefix. */
export function stripReplyMessage(text: string): string {
  return splitReplyMessage(text).said;
}

/**
 * The message a send makes of what was typed and the documents attached.
 * Alone and unremarked, a document goes as its own text — unless that text
 * would read as a command (`/name`, `!cmd`), which a document never is.
 */
export function composeDocMessage(said: string, parts: readonly DocPart[], editorContext?: DocEditorContext): string {
  const words = said.trim();
  if (!parts.length) return words;
  if (!words && parts.length === 1 && !editorContext) {
    const text = parts[0].text.trim();
    if (text && !/^[/!]/.test(text) && !OPENING.test(text)) return text;
  }
  const base = [words, ...parts.map(block)].filter(Boolean).join("\n\n");
  return editorContext ? `${base}\n\n${formatDocEditorContext(editorContext)}` : base;
}

const OPENING = /^<(document|selection) path="([^"\n]*)">\n/;
const FOLLOWING = /^\n\n<(?:document|selection) path="[^"\n]*">\n/;

/** The blocks `tail` is made of and nothing else, or `undefined` when it is not only blocks. */
function blocksOf(tail: string): DocPart[] | undefined {
  const parts: DocPart[] = [];
  let rest = tail;
  while (rest) {
    const open = OPENING.exec(rest);
    if (!open) return undefined;
    const close = `\n</${open[1]}>`;
    // An empty document's opening line ends where its closing one begins.
    let at = rest.indexOf(close, open[0].length - 1);
    // A document may quote a closing tag: its block ends where the message does, or where the next block starts.
    for (; at >= 0; at = rest.indexOf(close, at + 1)) {
      const after = rest.slice(at + close.length);
      if (!after || FOLLOWING.test(after)) break;
    }
    if (at < 0) return undefined;
    parts.push({
      path: unattr(open[2]),
      text: rest.slice(open[0].length, Math.max(open[0].length, at)),
      ...(open[1] === "selection" ? { excerpt: true } : {}),
    });
    rest = rest.slice(at + close.length).replace(/^\n\n/, "");
  }
  return parts.length ? parts : undefined;
}

/** A sent message read back: the words typed, and the documents that rode on them. */
export function splitDocMessage(text: string): { said: string; docs: DocPart[] } {
  const cleaned = stripDocEditorContext(text);
  const opening = /(^|\n\n)<(?:document|selection) path="[^"\n]*">\n/g;
  for (let found = opening.exec(cleaned); found; found = opening.exec(cleaned)) {
    const docs = blocksOf(cleaned.slice(found.index + found[1].length));
    if (docs) return { said: cleaned.slice(0, found.index), docs };
  }
  return { said: cleaned, docs: [] };
}

// Fixed protocol wrappers pipi prepends or wraps around a prompt. They are
// addressing/context for the agent, never the words a session is titled by.
// The Node side keeps the same reading in `sidecar/session-index.mjs`.
const PERSONA_PREFIX = /^<pipi-persona\b[^>]*>[\s\S]*?<\/pipi-persona>\s*/;
const HANDOFF_PREFIX = /^<conversation_handoff\b[^>]*>[\s\S]*?<\/conversation_handoff>\s*(?:User message:\n)?/;
const PIPI_MESSAGE = /<pipi-message\b[^>]*>([\s\S]*?)<\/pipi-message>/g;
const PIPI_MESSAGE_OPEN = /^\s*<pipi-message\b[^>]*>\s*/;
const PIPI_MESSAGE_CLOSE = /\s*<\/pipi-message>\s*$/;
const PIPI_MESSAGE_TRUNCATED = /^\s*<pipi-message\b[^>]*$/;
const DOC_EDITOR_CONTEXT_PREFIX = /^<doc_editor_context\b[^>]*>[\s\S]*?<\/doc_editor_context>\s*/;
const REPLY_PREFIX = /^\s*<pipi-reply\b[^>]*>[\s\S]*?<\/pipi-reply>\s*/;

/** Removes pipi's fixed protocol shells, keeping the task or words inside them. */
function withoutProtocolShells(text: string): string {
  let out = text;
  for (let round = 0; round < 4; round++) {
    const before = out;
    out = out.replace(PERSONA_PREFIX, "");
    out = out.replace(HANDOFF_PREFIX, "");
    out = out.replace(REPLY_PREFIX, "");
    out = out.replace(PIPI_MESSAGE, (_tag, body: string) => body.trim());
    // An old index or external header may already have clipped the envelope
    // before its closing tag: still drop the protocol head and keep what body
    // survived rather than titling the session `<pipi-message from="…"`.
    out = out.replace(PIPI_MESSAGE_OPEN, "").replace(PIPI_MESSAGE_CLOSE, "");
    if (PIPI_MESSAGE_TRUNCATED.test(out)) out = "";
    out = out.replace(DOC_EDITOR_CONTEXT_PREFIX, "");
    if (out === before) break;
  }
  return out;
}

/**
 * The words a message is titled by: what was typed, or — when the message
 * was only documents — what the first one says. Read loosely, so a text
 * already clipped or run onto one line is too (`titleWords` in
 * `sidecar/session-index.mjs` is the same reading on the Node side).
 */
export function titleWords(text: string): string {
  const clean = stripDocEditorContext(withoutProtocolShells(text));
  const { said: withoutAttach, firstAttachmentName } = stripTrailingAttachments(clean);
  const target = withoutAttach.trim() ? withoutAttach : firstAttachmentName ?? clean;
  if (!target.includes(' path="')) return target;
  const said = target.replace(/(?:^|\s)<(?:document|selection) path="[^"]*">[\s\S]*$/, "").trim();
  if (said) return said;
  return target.replace(/^\s*<(?:document|selection) path="[^"]*">\s*/, "").replace(/\s*<\/(?:document|selection)>[\s\S]*$/, "");
}

/** A line that opens or closes a fenced code block: its marker, or `undefined`. */
const fenceOf = (line: string) => /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];

/**
 * Markdown as an agent should read it: the escapes a serializer adds so that
 * the text parses back to the same document — `foo\_bar`, `\<task>`, `\~/dev`
 * — are noise to a model and wrong inside a path or a name, so they come off.
 * Structure stays (headings, lists, emphasis), and so does everything in code,
 * where a backslash is the writer's own. A hard break's trailing backslash
 * goes too: the line break it stood for is still there.
 */
export function plainMarkdown(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  /** The backtick run an inline code span opened with; it may close on a later line of its paragraph. */
  let span = 0;
  for (const line of markdown.split("\n")) {
    const marker = fenceOf(line);
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = undefined;
      out.push(line);
      continue;
    }
    if (marker && !span) {
      fence = marker;
      out.push(line);
      continue;
    }
    if (!line.trim()) span = 0;
    let text = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "`") {
        let run = 1;
        while (line[i + run] === "`") run++;
        if (!span) span = run;
        else if (span === run) span = 0;
        text += line.slice(i, i + run);
        i += run - 1;
        continue;
      }
      if (ch === "\\" && !span) {
        const next = line[i + 1];
        // The line's last character: a hard break, which the newline after it already says.
        if (next === undefined) continue;
        if (/[!-/:-@[-`{-~]/.test(next)) {
          text += next;
          i++;
          continue;
        }
      }
      text += ch;
    }
    out.push(text);
  }
  return out.join("\n");
}
