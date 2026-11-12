/**
 * The composer's slash commands, read the same way by the menu
 * (`views/Composer.tsx`) and by `send` (`store/app.ts`): what is being typed,
 * which commands it finds, and what a finished line asks for. No UI, no state.
 */
import type { SlashCommand } from "../pi/protocol";

/** A command the composer offers: the app's own, or one the agent reports. */
export interface ComposerCommand {
  name: string;
  description?: string;
  /** Whose command it is: pipi's (`app`), or what the agent says it is. */
  source: SlashCommand["source"] | "app";
  /** What follows the name, as the menu shows it: `<agent> <task>`, `[instructions]`. */
  argumentHint?: string;
  /** The name alone does nothing: choosing it fills it in instead of running it. */
  needsArguments?: boolean;
  /**
   * Other names it answers to: what an engine's own tool calls the same action
   * (`/clear` for `/new`). Typed in full they run it, and they are its names as
   * much as `name` is: an engine's command of that name is not offered beside it.
   */
  aliases?: string[];
  /** Words that only find it in the menu: the action in Chinese, near-synonyms. */
  keywords?: string[];
  /** What its first argument may be (the agents `/delegate` can name). */
  options?: CommandOption[];
}

export interface CommandOption {
  value: string;
  description?: string;
}

/**
 * What opens the menu: `/`, and what that key types under a Chinese input
 * method (`、` in half-width punctuation, `／` in full-width), so the menu
 * does not depend on switching the keyboard to English first.
 */
const TRIGGERS = "/、／";

/** What the draft asks the menu for: a command by name, or a command's first argument. */
export type SlashInput = { kind: "command"; query: string } | { kind: "argument"; name: string; query: string };

/**
 * Reads the draft as a command being typed. A second slash is a path
 * (`/Users/pip/notes.txt`), not a command; past the first argument the line is
 * the user's own words and the menu stays out of the way.
 */
export function readSlashInput(draft: string): SlashInput | undefined {
  if (!draft || !TRIGGERS.includes(draft[0])) return undefined;
  const rest = draft.slice(1);
  if (!/[\s/]/.test(rest)) return { kind: "command", query: rest.toLowerCase() };
  const argument = /^([^\s/]+)[ \t]+(\S*)$/.exec(rest);
  return argument ? { kind: "argument", name: argument[1], query: argument[2].toLowerCase() } : undefined;
}

/** Whether `name` is one of the command's names: its own, or an alias. */
export function answersTo(command: ComposerCommand, name: string): boolean {
  return command.name === name || !!command.aliases?.includes(name);
}

/** How well a command answers what was typed; lower is nearer, `undefined` is no match. */
function rank(command: ComposerCommand, query: string): number | undefined {
  const name = command.name.toLowerCase();
  if (name === query || command.aliases?.some((alias) => alias.toLowerCase() === query)) return 0;
  if (name.startsWith(query)) return 1;
  // `skill:review` is found by `review`, `fix-tests` by `tests`.
  if (name.split(/[:._-]/).some((part) => part.startsWith(query))) return 2;
  const keywords = [...(command.aliases ?? []), ...(command.keywords ?? [])].map((keyword) => keyword.toLowerCase());
  if (keywords.some((keyword) => keyword.startsWith(query))) return 3;
  if (name.includes(query)) return 4;
  // One letter is in every description: only a real word searches them.
  if (query.length < 2) return undefined;
  if (keywords.some((keyword) => keyword.includes(query))) return 5;
  if (command.description?.toLowerCase().includes(query)) return 6;
  return undefined;
}

/** The commands `query` finds, nearest first; commands equally near keep their order. All of them for an empty query. */
export function matchCommands(all: ComposerCommand[], query: string): ComposerCommand[] {
  if (!query) return all;
  const found: { command: ComposerCommand; rank: number; at: number }[] = [];
  all.forEach((command, at) => {
    const near = rank(command, query);
    if (near !== undefined) found.push({ command, rank: near, at });
  });
  return found.sort((a, b) => a.rank - b.rank || a.at - b.at).map((entry) => entry.command);
}

/** The argument values `query` finds: by value first, then by what they are called. */
export function matchOptions(options: CommandOption[], query: string): CommandOption[] {
  if (!query) return options;
  const starts = options.filter((option) => option.value.toLowerCase().startsWith(query));
  const holds = options.filter(
    (option) => !starts.includes(option) && (option.value.toLowerCase().includes(query) || !!option.description?.toLowerCase().includes(query)),
  );
  return [...starts, ...holds];
}

/** A finished line as a command: `/name` and what follows it. Not a path, not a line that only mentions one. */
export function parseSlashLine(text: string): { name: string; args: string } | undefined {
  const line = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return line ? { name: line[1], args: (line[2] ?? "").trim() } : undefined;
}
