import type { TextViewBlock, TextViewInline, TextViewListItem } from "nsh/base";

export interface PipBubbleGroup {
  blocks: TextViewBlock[];
  /** Plain text / compact markdown representation for single-bubble copy. */
  copyText: string;
  /** True when the bubble holds wide structured content (code block or table). */
  wide: boolean;
}

const MAX_CONVERSATIONAL_BUBBLES = 5;

function inlineToText(nodes: readonly TextViewInline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "code":
        out += `\`${node.code}\``;
        break;
      case "keyboard":
        out += node.text;
        break;
      case "break":
        out += "\n";
        break;
      case "math":
        out += node.tex;
        break;
      case "image":
        out += node.alt || node.title || node.src;
        break;
      case "link":
        out += inlineToText(node.content);
        break;
      default:
        if ("content" in node && Array.isArray(node.content)) {
          out += inlineToText(node.content);
        } else if ("text" in node && typeof node.text === "string") {
          out += node.text;
        }
        break;
    }
  }
  return out;
}

function listItemsToText(items: readonly TextViewListItem[], ordered: boolean, start = 1, depth = 0): string {
  const pad = "  ".repeat(depth);
  return items
    .map((item, idx) => {
      const marker = ordered ? `${start + idx}.` : "-";
      const lines: string[] = [];
      item.children.forEach((child, ci) => {
        const text = blockToText(child, depth + 1);
        if (!text) return;
        if (ci === 0 && child.type === "paragraph") {
          lines.push(`${pad}${marker} ${text}`);
        } else {
          lines.push(text);
        }
      });
      return lines.join("\n");
    })
    .join("\n");
}

function blockToText(block: TextViewBlock, depth = 0): string {
  switch (block.type) {
    case "paragraph":
      return inlineToText(block.content).trim();
    case "heading":
      return inlineToText(block.content).trim();
    case "list":
      return listItemsToText(block.items, Boolean(block.ordered), block.start ?? 1, depth);
    case "codeBlock":
      return block.code;
    case "blockquote":
      return block.children.map((c) => blockToText(c, depth)).filter(Boolean).join("\n\n");
    case "table": {
      const head = block.head.map((c) => inlineToText(c.content).trim()).join(" | ");
      const rows = (block.rows ?? []).map((r) => r.map((c) => inlineToText(c.content).trim()).join(" | "));
      return [head, ...rows].filter(Boolean).join("\n");
    }
    case "rule":
      return "---";
    default:
      return "";
  }
}

const isStructuredBlock = (block: TextViewBlock): boolean =>
  block.type === "list" || block.type === "codeBlock" || block.type === "blockquote" || block.type === "table";

const isWideBlock = (block: TextViewBlock): boolean => block.type === "codeBlock" || block.type === "table";

const isDocumentBlock = (block: TextViewBlock): boolean => block.type === "heading" || block.type === "rule";

function endsWithIntroColon(block: TextViewBlock): boolean {
  if (block.type !== "paragraph") return false;
  const text = inlineToText(block.content).trim();
  return text.endsWith(":") || text.endsWith("：");
}

function makeGroup(blocks: TextViewBlock[], fallbackText?: string): PipBubbleGroup {
  const joined = blocks.map((b) => blockToText(b)).filter(Boolean).join("\n\n");
  return {
    blocks,
    copyText: joined || fallbackText || "",
    wide: blocks.some(isWideBlock),
  };
}

/**
 * Groups parsed Markdown blocks from a Pip reply into natural iMessage-style SMS bubbles:
 * - Conversational paragraphs split into crisp consecutive bubbles (like texting),
 *   so short thoughts stack cleanly with a tight intra-cluster gap and staggered pop-in.
 * - A lead-in paragraph ending in `:` / `：` stays attached to the immediately following
 *   list, code block, quote, or table so structured steps never detach from their intro.
 * - Long structured documents (headings, dividers, or >5 natural bubbles such as an email
 *   draft or report) stay cohesive inside a single rich bubble rather than exploding into
 *   too many fragments.
 */
export function groupPipMessageBlocks(blocks: readonly TextViewBlock[], fallbackText?: string): PipBubbleGroup[] {
  if (blocks.length === 0) return [];
  if (blocks.length === 1) return [makeGroup([blocks[0]], fallbackText)];

  // Document-like replies (headings or horizontal rules) read best as one cohesive bubble.
  if (blocks.some(isDocumentBlock)) {
    return [makeGroup([...blocks], fallbackText)];
  }

  const groups: TextViewBlock[][] = [];
  let i = 0;
  while (i < blocks.length) {
    const cur = blocks[i];
    const next = blocks[i + 1];

    // Attach a colon lead-in paragraph to its immediately following structured block(s).
    if (endsWithIntroColon(cur) && next && isStructuredBlock(next)) {
      const bundle: TextViewBlock[] = [cur];
      i++;
      while (i < blocks.length && isStructuredBlock(blocks[i])) {
        bundle.push(blocks[i]);
        i++;
      }
      groups.push(bundle);
      continue;
    }

    // Group consecutive structured blocks (e.g. a list followed by a code snippet) together.
    if (isStructuredBlock(cur)) {
      const bundle: TextViewBlock[] = [cur];
      i++;
      while (i < blocks.length && isStructuredBlock(blocks[i])) {
        bundle.push(blocks[i]);
        i++;
      }
      groups.push(bundle);
      continue;
    }

    // Standalone conversational paragraph -> its own crisp SMS bubble.
    groups.push([cur]);
    i++;
  }

  // Long multi-paragraph templates (e.g. drafted emails/letters with >5 paragraphs) stay in one bubble.
  if (groups.length > MAX_CONVERSATIONAL_BUBBLES) {
    return [makeGroup([...blocks], fallbackText)];
  }

  return groups.map((group) => makeGroup(group, fallbackText));
}
