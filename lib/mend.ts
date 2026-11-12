// Streaming Markdown mender.
//
// While a reply is streaming, unclosed inline markers (`**bold`, `*em`, `` `code ``,
// `~~strike`, `[link](partial-url`) or an open code fence (` ```ts `) would parse
// as literal syntax until their closing delimiter arrives, causing sudden style
// flips and line-wrap jitter. Mending only the *display* source keeps typography
// stable from the first character after an opener; once the stream settles, the
// canonical source parses untouched.

/** Sentinel URL for links whose destination is still streaming; styled as a link, never opened on click. */
export const PENDING_LINK_URL = "pipi:pending-link";

export interface MendedMarkdown {
  /** Display markdown passed to `TextView.parse`. */
  source: string;
  /** True when the trailing block is an unclosed fenced code block that was synthetically closed. */
  hasOpenFence: boolean;
}

interface OpenDelim {
  ch: "*" | "_" | "~";
  len: number;
  /** Index right after the opening run: enforces nesting order & non-empty content guard. */
  pos: number;
}

const isSpace = (c: string | undefined): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

const isPunct = (c: string | undefined): boolean =>
  c !== undefined && /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/.test(c);

const isAlphaNum = (c: string | undefined): boolean => {
  if (!c) return false;
  const code = c.charCodeAt(0);
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  if (code > 127) return !isSpace(c) && !isPunct(c);
  return false;
};

const isAsciiDigit = (c: string | undefined): boolean => {
  if (!c) return false;
  const code = c.charCodeAt(0);
  return code >= 48 && code <= 57;
};

function runLength(text: string, at: number): number {
  const ch = text[at];
  let i = at + 1;
  while (i < text.length && text[i] === ch) i++;
  return i - at;
}

/** Whether text starting right after `$` spells an all-caps shell variable (`$HOME`, `$PATH_2`) rather than a formula. */
function isShellVariable(text: string, afterDollar: number): boolean {
  if (afterDollar >= text.length || isAsciiDigit(text[afterDollar])) return false;
  let k = afterDollar;
  while (k < text.length) {
    const c = text[k];
    const code = c.charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57) || c === "_") k++;
    else break;
  }
  if (k === afterDollar) return false;
  const next = text[k];
  return (
    next === undefined ||
    isSpace(next) ||
    next === "/" ||
    next === ":" ||
    next === "@" ||
    next === "." ||
    next === "," ||
    next === ";" ||
    next === "'" ||
    next === '"' ||
    next === ")"
  );
}

/** Whether `\` after `prev` is glued to a word or path, making `\(` / `\[` markdown escaping rather than TeX math. */
function gluedToWord(prev: string | undefined, inPath: boolean): boolean {
  if (!prev) return false;
  const code = prev.charCodeAt(0);
  const asciiWord =
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || prev === "_";
  return asciiWord || (inPath && !isSpace(prev));
}

interface FenceScan {
  openFence: { fenceChar: "`" | "~"; fenceLen: number } | null;
  /** Offset right after the last closed fenced code block (0 if none), so inline tail splitting never slices inside a fence. */
  afterLastClosedFence: number;
}

/** Scans top-level fenced code blocks (` ``` ` or ` ~~~ `) in one linear pass. */
function scanFences(text: string): FenceScan {
  let open: { fenceChar: "`" | "~"; fenceLen: number } | null = null;
  let afterLastClosedFence = 0;
  let pos = 0;
  const len = text.length;

  while (pos <= len) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? len : nl;
    const rawEnd = lineEnd > pos && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;

    let indent = pos;
    while (indent < rawEnd && indent - pos < 3 && text[indent] === " ") indent++;
    const first = text[indent];

    if (!open) {
      if (first === "`" || first === "~") {
        let fEnd = indent + 1;
        while (fEnd < rawEnd && text[fEnd] === first) fEnd++;
        const fenceLen = fEnd - indent;
        if (fenceLen >= 3) {
          // CommonMark: backtick fences cannot contain backticks in their info string
          let valid = true;
          if (first === "`") {
            for (let q = fEnd; q < rawEnd; q++) {
              if (text[q] === "`") {
                valid = false;
                break;
              }
            }
          }
          if (valid) {
            open = { fenceChar: first, fenceLen };
          }
        }
      }
    } else if (first === open.fenceChar) {
      let fEnd = indent + 1;
      while (fEnd < rawEnd && text[fEnd] === first) fEnd++;
      const fenceLen = fEnd - indent;
      if (fenceLen >= open.fenceLen) {
        let trailingOnlySpace = true;
        for (let q = fEnd; q < rawEnd; q++) {
          if (text[q] !== " " && text[q] !== "\t") {
            trailingOnlySpace = false;
            break;
          }
        }
        if (trailingOnlySpace) {
          open = null;
          afterLastClosedFence = nl === -1 ? len : nl + 1;
        }
      }
    }

    if (nl === -1) break;
    pos = nl + 1;
  }

  return { openFence: open, afterLastClosedFence };
}

/** Last line is only 1–2 `-` or `=` (no trailing whitespace) under a non-empty line — the incomplete-setext ambiguity. */
function isSetextPartial(text: string): boolean {
  const nl = text.lastIndexOf("\n");
  if (nl <= 0) return false;
  const last = text.slice(nl + 1).replace(/^[ \t]+/, "");
  if (last.length === 0 || last.length > 2) return false;
  const isUnderline = (ch: string) => {
    for (let i = 0; i < last.length; i++) if (last[i] !== ch) return false;
    return true;
  };
  if (!isUnderline("-") && !isUnderline("=")) return false;
  const above = text.slice(0, nl);
  const prevNl = above.lastIndexOf("\n");
  const prevLine = prevNl === -1 ? above : above.slice(prevNl + 1);
  return prevLine.trim().length > 0;
}

/** Mends hanging inline delimiters in the trailing non-code block of a stream. */
export function closeHangingInline(tail: string): string {
  if (!tail) return tail;
  const len = tail.length;

  const delims: OpenDelim[] = [];
  const brackets: number[] = [];
  let code: { ticks: number; pos: number } | null = null;
  let math: { open: 1 | 2; pos: number } | null = null;
  let halfMathCloser = -1;
  let latex: ")" | "]" | null = null;
  let lastContent = -1;
  let pendingUrlCloseBracket = -1;

  // Last positions where inline math could close (unclosed inline math with no closer ahead shields only its own line).
  let lastRightDollar = -1;
  let lastLatexParen = -1;
  let lastLatexBracket = -1;
  for (let k = len - 1; k >= 0; k--) {
    if (lastRightDollar === -1 && tail[k] === "$" && k > 0 && !isSpace(tail[k - 1])) {
      lastRightDollar = k;
    }
    if (k + 1 < len && tail[k] === "\\") {
      if (lastLatexParen === -1 && tail[k + 1] === ")") lastLatexParen = k;
      if (lastLatexBracket === -1 && tail[k + 1] === "]") lastLatexBracket = k;
    }
  }

  // Whether TeX syntax follows each index (so `Escape \[ in regex` isn't misread as streaming display math).
  const texAfter = new Array<boolean>(len + 1).fill(false);
  for (let k = len - 1; k >= 0; k--) {
    const c = tail[k];
    texAfter[k] = texAfter[k + 1] || c === "\\" || c === "^" || c === "_" || c === "{" || c === "}" || c === "=";
  }

  // Track whether the current whitespace-delimited token contains `/` (paths/URLs).
  const wordHasSlash = new Array<boolean>(len).fill(false);
  let seenSlash = false;
  for (let k = 0; k < len; k++) {
    const ch = tail[k];
    if (isSpace(ch)) seenSlash = false;
    else if (ch === "/") seenSlash = true;
    wordHasSlash[k] = seenSlash;
  }

  let i = 0;
  while (i < len) {
    const c = tail[i];

    // Escaped character or LaTeX `\(…\)` / `\[…\]` math outside inline code
    if (!code && c === "\\") {
      const next = tail[i + 1];
      if (latex !== null) {
        if (next === latex) latex = null;
      } else if (
        !math &&
        (next === "(" || next === "[") &&
        !(i > 0 && gluedToWord(tail[i - 1], wordHasSlash[i - 1])) &&
        (next === "(" || lastLatexBracket > i || texAfter[Math.min(i + 2, len)])
      ) {
        if (next === "[") {
          delims.length = 0;
          brackets.length = 0;
        }
        latex = next === "(" ? ")" : "]";
      }
      if (i + 1 < len) lastContent = i + 1;
      halfMathCloser = -1;
      i += 2;
      continue;
    }

    // Inside `\(…\)` or `\[…\]` formula: shield emphasis/links
    if (latex !== null) {
      if (c === "\n" && latex === ")" && lastLatexParen < i) {
        latex = null;
      } else if (!isSpace(c)) {
        lastContent = i;
      }
      i++;
      continue;
    }

    // Inside `$…$` or `$$…$$` formula: shield emphasis/links, never close synthetically except half `$$` closer
    if (math !== null) {
      if (c === "\n" && math.open === 1 && lastRightDollar < i) {
        math = null;
        i++;
        continue;
      }
      if (c === "$") {
        const run = runLength(tail, i);
        const glued = i > 0 && !isSpace(tail[i - 1]);
        if (run >= math.open && (math.open === 2 || glued)) {
          math = null;
        } else if (math.open === 2 && run === 1) {
          halfMathCloser = i;
        }
        lastContent = i + run - 1;
        i += run;
        continue;
      }
      if (!isSpace(c)) {
        halfMathCloser = -1;
        lastContent = i;
      }
      i++;
      continue;
    }

    // Backtick code spans
    if (c === "`") {
      const run = runLength(tail, i);
      if (code && run === code.ticks) {
        code = null;
      } else if (code) {
        lastContent = i + run - 1;
      } else {
        code = { ticks: run, pos: i + run };
      }
      i += run;
      continue;
    }

    if (code) {
      lastContent = i;
      i++;
      continue;
    }

    // Dollar math openers (`$…$` / `$$…$$`), ignoring prices (`$5`) and shell variables (`$HOME`)
    if (c === "$") {
      const run = runLength(tail, i);
      const next = tail[i + run];
      if (run >= 2) {
        delims.length = 0;
        brackets.length = 0;
        math = { open: 2, pos: i + run };
      } else if (next !== undefined && !isSpace(next) && !isAsciiDigit(next) && !isShellVariable(tail, i + 1)) {
        math = { open: 1, pos: i + run };
      }
      lastContent = i + run - 1;
      i += run;
      continue;
    }

    // Emphasis / strikethrough delimiters (`*`, `_`, `~~`)
    if (c === "*" || c === "_" || c === "~") {
      const run = runLength(tail, i);
      const end = i + run;
      // GFM strikethrough is `~~` only; longer tilde runs are literal. A single `~` may still be
      // the half-streamed first tilde of a closing `~~`, so let it reach the closer matcher!
      if (c === "~" && run > 2) {
        lastContent = end - 1;
        i = end;
        continue;
      }

      const prev = i > 0 ? tail[i - 1] : undefined;
      const next = end < len ? tail[end] : undefined;

      // Intraword `_` never delimits (CommonMark); intraword single `*` (`2*3`) is treated conservatively as literal too.
      const intraword =
        (isAlphaNum(prev) && isAlphaNum(next) && (c === "_" || (c === "*" && run === 1))) ||
        (c === "_" && wordHasSlash[i]);

      if (intraword) {
        lastContent = end - 1;
        i = end;
        continue;
      }

      const canClose = prev !== undefined && !isSpace(prev);
      const canOpen = next !== undefined && !isSpace(next);
      let rest = run;

      if (canClose) {
        // Find innermost open delimiter of the same character
        let matchIdx = -1;
        for (let dIdx = delims.length - 1; dIdx >= 0; dIdx--) {
          if (delims[dIdx].ch === c) {
            matchIdx = dIdx;
            break;
          }
        }
        if (matchIdx >= 0) {
          const take = Math.min(rest, delims[matchIdx].len);
          delims[matchIdx].len -= take;
          rest -= take;
          // Delimiters opened inside the closed span stay literal; if partially closed (`**bold*`), keep remainder open!
          delims.length = delims[matchIdx].len === 0 ? matchIdx : matchIdx + 1;
        }
      }

      if (rest > 0) {
        if (canOpen && (c !== "~" || rest === 2)) {
          delims.push({ ch: c, len: rest, pos: end });
        } else {
          lastContent = end - 1;
        }
      }

      i = end;
      continue;
    }

    // Links: `[label](url)`
    if (c === "[") {
      brackets.push(i);
      i++;
      continue;
    }

    if (c === "]") {
      const openBracket = brackets.pop();
      if (openBracket !== undefined) {
        // Drop unclosed emphasis opened inside completed `[...]`
        while (delims.length > 0 && delims[delims.length - 1].pos >= openBracket) {
          delims.pop();
        }
        if (tail[i + 1] === "(") {
          let j = i + 2;
          let depth = 0;
          let closed = false;
          while (j < len) {
            if (tail[j] === "(") depth++;
            else if (tail[j] === ")") {
              if (depth === 0) {
                closed = true;
                break;
              }
              depth--;
            }
            j++;
          }
          if (!closed) {
            pendingUrlCloseBracket = i;
            break;
          }
          lastContent = j;
          i = j + 1;
          continue;
        }
      }
      lastContent = i;
      i++;
      continue;
    }

    if (!isSpace(c)) {
      lastContent = i;
    }
    i++;
  }

  // Stream ended mid-link destination `[label](https://part...` -> replace partial URL cleanly
  if (pendingUrlCloseBracket >= 0) {
    return `${tail.slice(0, pendingUrlCloseBracket)}](${PENDING_LINK_URL})`;
  }

  // Emit synthetic closers innermost-first (descending open position)
  const closers: { pos: number; text: string }[] = [];
  if (math?.open === 2 && halfMathCloser >= 0) {
    closers.push({ pos: math.pos, text: "$" });
  }
  if (code && lastContent >= code.pos) {
    closers.push({ pos: code.pos, text: "`".repeat(code.ticks) });
  }
  for (const d of delims) {
    if (lastContent >= d.pos) {
      closers.push({ pos: d.pos, text: d.ch.repeat(d.len) });
    }
  }
  if (brackets.length > 0) {
    const lastBracket = brackets[brackets.length - 1];
    // Don't mend task list markers `- [ ` or `[x`
    const afterBracket = tail.slice(lastBracket + 1);
    const looksLikeTask =
      lastBracket >= 2 && /[-*+]\s+$/.test(tail.slice(0, lastBracket)) && /^[ xX]?$/.test(afterBracket);
    if (!looksLikeTask && lastContent > lastBracket) {
      closers.push({ pos: lastBracket, text: `](${PENDING_LINK_URL})` });
    }
  }
  closers.sort((a, b) => b.pos - a.pos);
  const closerStr = closers.map((c) => c.text).join("");

  // Guard against setext heading flash: closers belong to the paragraph above the underline,
  // and a zero-width space breaks the partial `-`/`--`/`=`/`==` underline invisibly!
  const setext = isSetextPartial(tail);
  if (!closerStr && !setext) return tail;

  if (setext) {
    const nl = tail.lastIndexOf("\n");
    if (nl >= 0 && closerStr) {
      const above = tail.slice(0, nl);
      const aboveTrimEnd = above.replace(/[ \t\r]+$/, "");
      return `${aboveTrimEnd}${closerStr}${above.slice(aboveTrimEnd.length)}${tail.slice(nl)}\u200B`;
    }
    return `${tail}\u200B`;
  }

  // Insert closers BEFORE trailing whitespace (`**bold ` -> `**bold** `): a closer after a
  // trailing space is not right-flanking in CommonMark and would flash back to raw `**`!
  let trimEnd = tail.length;
  while (trimEnd > 0 && isSpace(tail[trimEnd - 1])) trimEnd--;
  return `${tail.slice(0, trimEnd)}${closerStr}${tail.slice(trimEnd)}`;
}

/**
 * Mends a live-streaming markdown buffer for zero-jitter display parsing.
 * Scans fences cleanly and mends only the trailing non-fence block (`O(tail)` inline scan).
 */
export function mendStreamingMarkdown(source: string): MendedMarkdown {
  if (!source) return { source, hasOpenFence: false };

  const { openFence, afterLastClosedFence } = scanFences(source);
  if (openFence) {
    const closer = openFence.fenceChar.repeat(openFence.fenceLen);
    const needsNewline = !source.endsWith("\n");
    return {
      source: `${source}${needsNewline ? "\n" : ""}${closer}`,
      hasOpenFence: true,
    };
  }

  // Only inspect text after the last closed fenced code block AND after the last blank-line block boundary!
  const postFence = afterLastClosedFence > 0 ? source.slice(afterLastClosedFence) : source;
  let relSplit = 0;
  const re = /\n[ \t]*\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(postFence)) !== null) {
    relSplit = m.index + m[0].length;
  }
  const splitAt = afterLastClosedFence + relSplit;
  const tail = splitAt > 0 ? source.slice(splitAt) : source;
  if (!tail || /^[ \t]*\|/.test(tail)) {
    return { source, hasOpenFence: false };
  }
  const mendedTail = closeHangingInline(tail);
  if (mendedTail === tail) return { source, hasOpenFence: false };
  return {
    source: splitAt > 0 ? source.slice(0, splitAt) + mendedTail : mendedTail,
    hasOpenFence: false,
  };
}
