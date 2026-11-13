import { basename } from "../lib/format";
import type { Lang } from "../lib/i18n";
import type { IconName } from "../ui/Icon";
import type { Row, ToolRow } from "./transcript";

/**
 * How a turn is laid out.
 *
 * A turn is a header, its process, and its answer. The process is everything
 * the agent did on the way, in the order it happened: the commentary prose it
 * wrote between steps, and runs of non-prose steps (reasoning and tool calls)
 * folded into a single collapsed activity row ("Explored 4 files, ran 2
 * commands") between commentary boundaries. The answer is the prose of the
 * message that called no tools.
 *
 * While the turn works its process is open, so commentary streams where it
 * will stay, while intermediate reasoning/tool groups stay compact by default
 * until clicked. The turn's process folds under the header once, when the
 * answer is known; nothing else folds or unfolds on its own, and a reader's
 * own toggle holds from then on.
 */

export type ToolCategory = "read" | "edit" | "create" | "search" | "list" | "command" | "agent" | "web" | "todo" | "other";

export interface DiffStats {
  added: number;
  removed: number;
}

export interface ToolPresentation {
  category: ToolCategory;
  icon: IconName;
  /** Localized action verb ("Read" / "读取", "Updated" / "更新", "Ran" / "运行", ...). */
  verb: string;
  /** Primary target (filename, command, pattern, URL, subtask title). */
  target: string;
  /** Secondary context ("in views/", line range ":1–80", etc.). */
  meta: string;
  /** Whether `target` should render in monospace (commands, paths, patterns). */
  monoTarget: boolean;
  /** Unified diff line counts when editing/creating files. */
  diffStats?: DiffStats;
}

export type ProcessStep = Extract<Row, { kind: "thinking" }> | ToolRow;

/** A contiguous run of non-commentary process steps (reasoning and tool calls):
 * shown as the step itself when alone, else one collapsed summary row unfolding to each step. */
export interface ActivityRow {
  kind: "activity";
  id: string;
  steps: ProcessStep[];
  tools: ToolRow[];
  running: boolean;
  hasError: boolean;
  /** Sum of the steps' recorded durations when any has one. */
  durationMs?: number;
  diffStats?: DiffStats;
}

/** The line above a turn's work: what it is doing or how long it took, and the fold of its process. */
export interface TurnHeaderRow {
  kind: "turn";
  id: string;
  /** The turn is still working towards its answer. */
  running: boolean;
  /** When the turn started, for the live timer. */
  startedAt?: number;
  /** How long the turn took, once it is over and that is known. */
  durationMs?: number;
  /** The process rows are shown under the header. */
  open: boolean;
  /** There are process rows to show or hide. */
  hasDetails: boolean;
  /** The step the turn is on, for the header of a folded running turn. */
  activeStep?: Extract<Row, { kind: "thinking" }> | ToolRow;
}

export type DisplayRow = Exclude<Row, ToolRow> | ActivityRow | TurnHeaderRow;

// ── Tool Classification & Copywriting ────────────────────────────────────────

const isToolActive = (status: ToolRow["status"]) => status === "call" || status === "queued" || status === "running";

/** Normalizes tool names across Pi, Claude Code, Codex, Devin, OpenCode, Cursor, Gemini & ACP servers. */
export function classifyTool(rawName: string): { category: ToolCategory; subkind?: "find" | "fetch"; icon: IconName } {
  const lower = rawName
    .trim()
    .toLowerCase()
    .replace(/^mcp__[^_]+__/, "")
    .replace(/[\s-]+/g, "_");
  if (lower === "read" || lower === "read_file" || lower === "read_files" || lower === "view_file" || lower === "cat" || lower === "open_file") {
    return { category: "read", icon: "file" };
  }
  if (
    lower === "edit" ||
    lower === "edit_file" ||
    lower === "multi_edit" ||
    lower === "multiedit" ||
    lower === "replace" ||
    lower === "str_replace" ||
    lower === "str_replace_editor" ||
    lower === "apply_patch" ||
    lower === "patch"
  ) {
    return { category: "edit", icon: "fileEdit" };
  }
  if (lower === "write" || lower === "write_file" || lower === "create_file" || lower === "save_file") {
    return { category: "create", icon: "filePlus" };
  }
  if (lower === "grep" || lower === "ripgrep" || lower === "search" || lower === "search_content" || lower === "codebase_search" || lower === "grep_search") {
    return { category: "search", icon: "search" };
  }
  if (lower === "find" || lower === "glob" || lower === "find_by_name" || lower === "file_search" || lower === "find_files") {
    return { category: "search", subkind: "find", icon: "search" };
  }
  if (lower === "ls" || lower === "list_dir" || lower === "list_directory" || lower === "list_files" || lower === "dir") {
    return { category: "list", icon: "folder" };
  }
  if (
    lower === "bash" ||
    lower === "run_command" ||
    lower === "shell" ||
    lower === "shell_command" ||
    lower === "run_shell_command" ||
    lower === "run_terminal_command" ||
    lower === "exec" ||
    lower === "terminal" ||
    lower === "terminal_command" ||
    lower === "command" ||
    lower === "execute_command"
  ) {
    return { category: "command", icon: "terminal" };
  }
  if (
    lower === "delegate_task" ||
    lower === "task" ||
    lower === "agent" ||
    lower === "subagent" ||
    lower === "invoke_subagent" ||
    lower === "session_start" ||
    lower === "session_stop" ||
    lower === "session_send" ||
    lower === "session_read" ||
    lower === "sessions_list" ||
    lower === "agents_list"
  ) {
    return {
      category: "agent",
      icon: lower === "session_stop" ? "stop" : lower === "session_read" || lower === "sessions_list" || lower === "agents_list" ? "clock" : "agents",
    };
  }
  if (lower === "web_search" || lower === "websearch" || lower === "search_web" || lower === "google_search") {
    return { category: "web", icon: "globe" };
  }
  if (lower === "webfetch" || lower === "web_fetch" || lower === "fetch" || lower === "read_url" || lower === "read_url_content" || lower === "curl") {
    return { category: "web", subkind: "fetch", icon: "globe" };
  }
  if (lower === "todo_write" || lower === "todowrite" || lower === "update_plan" || lower === "plan" || lower === "todo") {
    return { category: "todo", icon: "check" };
  }
  return { category: "other", icon: "wrench" };
}

function pickStr(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function pickNum(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return undefined;
}

/** Shortens a file path to `parent/file` or `file` for scannable tool rows, preserving trailing directories. */
function shortFileTarget(rawPath: string): string {
  const clean = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean) return "";
  const parts = clean.split("/").filter(Boolean);
  if (parts.length <= 2) return clean;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Extracts `+added / -removed` line counts from a tool's unified diff or old/new text arguments. */
export function extractDiffStats(row: ToolRow): DiffStats | undefined {
  const details = row.details as { diff?: unknown; added?: unknown; removed?: unknown } | undefined;
  if (typeof details?.added === "number" && typeof details?.removed === "number") {
    if (details.added > 0 || details.removed > 0) return { added: details.added, removed: details.removed };
  }
  const diff = typeof details?.diff === "string" ? details.diff : "";
  if (diff) {
    let added = 0;
    let removed = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    if (added > 0 || removed > 0) return { added, removed };
  }
  const oldStr = pickStr(row.args, "oldText", "old_string", "old_str");
  const newStr = pickStr(row.args, "newText", "new_string", "new_str", "content");
  if (oldStr || newStr) {
    const oldLines = oldStr ? oldStr.split("\n").length : 0;
    const newLines = newStr ? newStr.split("\n").length : 0;
    if (oldLines > 0 || newLines > 0) return { added: newLines, removed: oldLines };
  }
  return undefined;
}

function sumDiffStats(tools: readonly ToolRow[]): DiffStats | undefined {
  let added = 0;
  let removed = 0;
  for (const tool of tools) {
    const stats = extractDiffStats(tool);
    if (stats) {
      added += stats.added;
      removed += stats.removed;
    }
  }
  return added > 0 || removed > 0 ? { added, removed } : undefined;
}

function humanizeToolName(name: string): string {
  const trimmed = name.replace(/^mcp__[^_]+__/, "").trim();
  if (/\s/.test(trimmed)) return trimmed.replace(/\s*\n\s*/g, " ; ").replace(/\s+/g, " ");
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

function compactCommand(cmd: string): string {
  const oneLine = cmd.replace(/\s*\n\s*/g, " ; ").replace(/\s+/g, " ").trim();
  return oneLine.length > 88 ? `${oneLine.slice(0, 85)}…` : oneLine;
}

/** Rich localized description of a single tool call: always includes an explicit action verb + target. */
export function describeToolCall(row: ToolRow, lang: Lang): ToolPresentation {
  const zh = lang === "zh";
  const active = isToolActive(row.status);
  const failed = row.status === "error";
  const { category, subkind, icon } = classifyTool(row.name);
  const args = row.args ?? {};

  switch (category) {
    case "read": {
      const rawPath = pickStr(args, "path", "file_path", "filePath", "file", "target_file");
      const offset = pickNum(args, "offset", "start_line", "startLine", "StartLine");
      const limit = pickNum(args, "limit", "end_line", "endLine", "EndLine");
      let range = "";
      if (offset !== undefined && limit !== undefined) {
        const end = rawPath && ("end_line" in args || "endLine" in args || "EndLine" in args) ? limit : offset + limit - 1;
        range = `L${offset}–${Math.max(offset, end)}`;
      } else if (offset !== undefined) {
        range = `L${offset}+`;
      }
      const verb = active ? (zh ? "正在读取" : "Reading") : failed ? (zh ? "读取失败" : "Failed to read") : zh ? "读取" : "Read";
      return {
        category,
        icon,
        verb,
        target: shortFileTarget(rawPath) || (zh ? "文件" : "file"),
        meta: range,
        monoTarget: Boolean(rawPath),
      };
    }

    case "edit": {
      const rawPath = pickStr(args, "path", "file_path", "filePath", "file", "target_file");
      const verb = active ? (zh ? "正在更新" : "Updating") : failed ? (zh ? "更新失败" : "Failed to update") : zh ? "更新" : "Updated";
      return {
        category,
        icon,
        verb,
        target: shortFileTarget(rawPath) || (zh ? "文件" : "file"),
        meta: "",
        monoTarget: Boolean(rawPath),
        diffStats: extractDiffStats(row),
      };
    }

    case "create": {
      const rawPath = pickStr(args, "path", "file_path", "filePath", "file", "target_file");
      const verb = active ? (zh ? "正在写入" : "Writing") : failed ? (zh ? "写入失败" : "Failed to write") : zh ? "写入" : "Wrote";
      return {
        category,
        icon,
        verb,
        target: shortFileTarget(rawPath) || (zh ? "新文件" : "file"),
        meta: "",
        monoTarget: Boolean(rawPath),
        diffStats: extractDiffStats(row),
      };
    }

    case "search": {
      const pattern = pickStr(args, "pattern", "query", "search", "regex", "glob");
      const scope = shortFileTarget(pickStr(args, "path", "dir", "directory", "include", "glob"));
      const isFind = subkind === "find";
      const verb = isFind
        ? active
          ? zh ? "正在查找文件" : "Finding files"
          : zh ? "查找文件" : "Found files"
        : active
          ? zh ? "正在搜索" : "Searching"
          : zh ? "搜索" : "Searched";
      return {
        category,
        icon,
        verb,
        target: pattern || (isFind ? (zh ? "文件" : "files") : zh ? "内容" : "code"),
        meta: scope && scope !== pattern ? (zh ? `于 ${scope}` : `in ${scope}`) : "",
        monoTarget: Boolean(pattern),
      };
    }

    case "list": {
      const dir = shortFileTarget(pickStr(args, "path", "dir", "directory"));
      const verb = active ? (zh ? "正在查看目录" : "Listing") : zh ? "查看目录" : "Listed";
      return {
        category,
        icon,
        verb,
        target: dir || (zh ? "当前目录" : "workspace"),
        meta: "",
        monoTarget: Boolean(dir),
      };
    }

    case "command": {
      const cmd = compactCommand(pickStr(args, "command", "cmd", "CommandLine", "script"));
      const desc = pickStr(args, "description", "toolSummary");
      const verb = active ? (zh ? "正在运行" : "Running") : failed ? (zh ? "命令失败" : "Command failed") : zh ? "运行" : "Ran";
      return {
        category,
        icon,
        verb,
        target: cmd || desc || (zh ? "终端命令" : "command"),
        meta: cmd && desc ? desc : "",
        monoTarget: Boolean(cmd),
      };
    }

    case "agent": {
      const lower = row.name.replace(/^mcp__[^_]+__/i, "").toLowerCase();
      if (lower === "agents_list" || lower === "sessions_list" || lower === "session_read") {
        return {
          category,
          icon,
          verb: active ? (zh ? "正在查看会话" : "Reading sessions") : zh ? "已查看会话" : "Read sessions",
          target: lower === "agents_list" ? (zh ? "可用智能体与模型" : "available agents") : pickStr(args, "session", "sessionId", "id") || (zh ? "会话树" : "the session tree"),
          meta: "",
          monoTarget: false,
        };
      }
      if (lower === "session_send") {
        return {
          category,
          icon,
          verb: active ? (zh ? "正在发送消息" : "Messaging session") : failed ? (zh ? "发送失败" : "Message failed") : zh ? "已发送至会话" : "Messaged session",
          target: pickStr(args, "session", "sessionId", "id") || (zh ? "会话" : "session"),
          meta: "",
          monoTarget: true,
        };
      }
      if (lower === "session_stop") {
        return {
          category,
          icon,
          verb: active ? (zh ? "正在停止会话" : "Stopping session") : failed ? (zh ? "停止失败" : "Stop failed") : zh ? "已停止会话" : "Stopped session",
          target: pickStr(args, "session", "sessionId", "id") || (zh ? "会话" : "session"),
          meta: "",
          monoTarget: true,
        };
      }
      const agent = pickStr(args, "agent", "agentId", "subagent_type", "TypeName");
      const title = pickStr(args, "title", "description", "Role", "task", "prompt", "message");
      const isStart = lower === "session_start";
      const verb = isStart
        ? active
          ? zh ? "正在启动子会话" : "Starting session"
          : failed
            ? zh ? "子会话启动失败" : "Session failed"
            : zh ? "已启动子会话" : "Started session"
        : active
          ? zh ? "正在委派子任务" : "Running subtask"
          : failed
            ? zh ? "子任务失败" : "Subtask failed"
            : zh ? "完成子任务" : "Subtask";
      return {
        category,
        icon,
        verb,
        target: title || agent || (zh ? "协同智能体" : "sub-agent"),
        meta: title && agent ? agent : "",
        monoTarget: false,
      };
    }

    case "web": {
      const query = pickStr(args, "query", "url", "q", "prompt");
      const isFetch = subkind === "fetch";
      const verb = isFetch
        ? active
          ? zh ? "正在读取网页" : "Reading page"
          : zh ? "读取网页" : "Read page"
        : active
          ? zh ? "正在搜索网页" : "Searching web"
          : zh ? "搜索网页" : "Searched web";
      return {
        category,
        icon,
        verb,
        target: query || (zh ? "网页内容" : "web"),
        meta: "",
        monoTarget: isFetch && query.startsWith("http"),
      };
    }

    case "todo": {
      const verb = active ? (zh ? "正在更新计划" : "Updating plan") : zh ? "更新计划" : "Updated plan";
      return {
        category,
        icon,
        verb,
        target: pickStr(args, "title", "summary") || "TODO",
        meta: "",
        monoTarget: false,
      };
    }

    default: {
      const label = humanizeToolName(row.name) || (zh ? "工具" : "tool");
      const target = pickStr(args, "path", "file_path", "command", "query", "pattern", "url", "title", "name", "description");
      const shown = target ? (target.includes("/") ? shortFileTarget(target) : compactCommand(target)) : "";
      // An ACP harness names a call by its title ("Search for 'veil|fold'"): the
      // title is what the row reads, and truncates as a target does.
      if (/\s/.test(row.name.trim())) {
        return {
          category,
          icon,
          verb: active ? (zh ? "正在调用" : "Calling") : failed ? (zh ? "调用失败" : "Failed") : zh ? "调用" : "Used",
          target: row.name.trim(),
          meta: shown && shown !== "." && !row.name.includes(target) ? shown : "",
          monoTarget: false,
        };
      }
      const verb = active ? (zh ? `正在调用 ${label}` : `Calling ${label}`) : failed ? (zh ? `${label} 失败` : `${label} failed`) : zh ? `调用 ${label}` : `Used ${label}`;
      return {
        category,
        icon,
        verb,
        target: shown,
        meta: "",
        monoTarget: Boolean(target && (target.includes("/") || target.includes("--"))),
      };
    }
  }
}

// ── Activity & Turn Header Copywriting ───────────────────────────────────────
//
// Process rows: a run of
// steps reads as one quiet line of plain words. While it works the line names
// the one step under way ("Running git status"); once it settled, what was done
// by kind in the order it first happened ("Ran git, Read 3 files"). No icons,
// target lists, timings or counters that tick along with every call.

type SegmentKey = "read" | "list" | "search" | "edit" | "command" | "agent" | "todo" | "other";

const segmentKey = (category: ToolCategory): SegmentKey => (category === "create" ? "edit" : category === "web" ? "search" : category);

const VERBS: Partial<Record<SegmentKey, { running: [string, string]; done: [string, string] }>> = {
  read: { running: ["Reading", "正在读取"], done: ["Read", "已读取"] },
  list: { running: ["Listing", "正在查看"], done: ["Listed", "已查看"] },
  search: { running: ["Searching", "正在搜索"], done: ["Searched", "已搜索"] },
  edit: { running: ["Updating", "正在更新"], done: ["Updated", "已更新"] },
  command: { running: ["Running", "正在运行"], done: ["Ran", "已运行"] },
};

const verbOf = (key: SegmentKey, running: boolean, zh: boolean) => {
  const verbs = VERBS[key];
  if (!verbs) return "";
  return (running ? verbs.running : verbs.done)[zh ? 1 : 0];
};

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const toolPath = (tool: ToolRow) => pickStr(tool.args ?? {}, "path", "file_path", "filePath", "file", "target_file", "notebook_path");

/** The program a command line runs, for a settled row: `cd x && git status | head` reads as `git`. */
function commandProgram(command: string): string {
  const parts = command
    .split(/&&|\|\||;|\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const part = parts.find((p) => !/^cd(\s|$)/.test(p)) ?? parts[0] ?? "";
  const tokens = part.split(/\s+/).filter((token) => token && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  let program = tokens[0] ?? "";
  if (["sudo", "env", "npx", "bunx", "time", "exec"].includes(program) && tokens[1]) program = tokens[1];
  return program ? basename(program.replace(/^["']|["']$/g, "")) : "";
}

function searchTarget(tool: ToolRow): string {
  const pattern = pickStr(tool.args ?? {}, "pattern", "query", "search", "regex", "glob", "q", "url").replace(/^\*\*\//, "");
  return pattern ? truncate(pattern, 48) : "";
}

/** One tool call in a line: the verb and what it touched. */
function toolLine(tool: ToolRow, running: boolean, zh: boolean): string {
  const { category } = classifyTool(tool.name);
  const key = segmentKey(category);
  const verb = verbOf(key, running, zh);
  const args = tool.args ?? {};
  switch (key) {
    case "read":
    case "edit": {
      const path = toolPath(tool);
      return `${verb} ${path ? basename(path) : zh ? "文件" : "file"}`;
    }
    case "list": {
      const dir = pickStr(args, "path", "dir", "directory");
      return `${verb} ${dir && dir !== "." ? basename(dir) : zh ? "当前目录" : "current directory"}`;
    }
    case "search": {
      const target = searchTarget(tool);
      return target ? `${verb} ${target}` : verb;
    }
    case "command": {
      const command = pickStr(args, "command", "cmd", "CommandLine", "script");
      if (!command) return zh ? (running ? "正在运行命令" : "已运行命令") : running ? "Running a command" : "Ran a command";
      return `${verb} ${running ? compactCommand(command) : commandProgram(command) || compactCommand(command)}`;
    }
    case "agent": {
      const lower = tool.name.replace(/^mcp__[^_]+__/i, "").toLowerCase();
      if (lower === "agents_list" || lower === "sessions_list" || lower === "session_read") {
        return running ? (zh ? "正在查看会话" : "Reading sessions") : zh ? "已查看会话" : "Read sessions";
      }
      if (lower === "session_send") {
        const target = pickStr(args, "session", "sessionId", "id");
        return running
          ? zh ? `正在向 ${target || "会话"} 发送消息` : `Messaging ${target || "session"}`
          : zh ? `已向 ${target || "会话"} 发送消息` : `Messaged ${target || "session"}`;
      }
      if (lower === "session_stop") {
        const target = pickStr(args, "session", "sessionId", "id");
        return running
          ? zh ? `正在停止 ${target || "会话"}` : `Stopping ${target || "session"}`
          : zh ? `已停止 ${target || "会话"}` : `Stopped ${target || "session"}`;
      }
      const title = pickStr(args, "title", "description", "Role", "name", "task", "message", "agent", "agentId", "subagent_type");
      if (lower === "session_start") {
        const suffix = title ? ` ${truncate(title, 48)}` : "";
        return running ? (zh ? `正在启动子会话${suffix}` : `Starting session${suffix}`) : zh ? `已启动子会话${suffix}` : `Started session${suffix}`;
      }
      return title ? (zh ? `子任务 ${truncate(title, 48)}` : `Subtask ${truncate(title, 48)}`) : zh ? "子任务" : "Subtask";
    }
    case "todo":
      return zh ? (running ? "正在更新计划" : "已更新计划") : running ? "Updating plan" : "Updated plan";
    default: {
      const name = humanizeToolName(tool.name) || (zh ? "工具" : "tool");
      const label = /\s/.test(tool.name.trim()) ? name : name[0].toUpperCase() + name.slice(1);
      return running ? (zh ? `正在运行 ${label}` : `Running ${label}`) : label;
    }
  }
}

/** A kind of step the run took, settled: the call itself when there was one, else how many. */
function segmentLine(key: SegmentKey, tools: ToolRow[], zh: boolean): string {
  const verb = verbOf(key, false, zh);
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
  switch (key) {
    case "read":
    case "edit": {
      const paths = unique(tools.map(toolPath));
      const count = paths.length || tools.length;
      if (count === 1) return toolLine(tools[0], false, zh);
      return zh ? `${verb} ${count} 个文件` : `${verb} ${count} files`;
    }
    case "list": {
      if (tools.length === 1) return toolLine(tools[0], false, zh);
      return zh ? `${verb} ${tools.length} 个目录` : `${verb} ${tools.length} directories`;
    }
    case "search":
      if (tools.length === 1) return toolLine(tools[0], false, zh);
      return zh ? `${verb} ${tools.length} 次` : `${verb} ${tools.length} times`;
    case "command": {
      if (tools.length === 1) return toolLine(tools[0], false, zh);
      return zh ? `${verb} ${tools.length} 条命令` : `${verb} ${tools.length} commands`;
    }
    case "agent":
      if (tools.length === 1) return toolLine(tools[0], false, zh);
      return zh ? `已完成 ${tools.length} 个子任务` : `Ran ${tools.length} subtasks`;
    case "todo":
      return toolLine(tools[0], false, zh);
    default: {
      const names = unique(tools.map((tool) => humanizeToolName(tool.name)));
      if (names.length <= 1) return toolLine(tools[0], false, zh);
      return zh ? `已调用 ${names.length} 项工具` : `Used ${names.length} tools`;
    }
  }
}

/** The step a running group is on: the newest call still running, reasoning under way, or the last call. */
function currentLine(steps: readonly ProcessStep[], zh: boolean): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.kind === "tool" && isToolActive(step.status)) return toolLine(step, true, zh);
  }
  const last = steps[steps.length - 1];
  if (!last || last.kind === "thinking") return zh ? "正在思考" : "Thinking";
  return toolLine(last, false, zh);
}

/** The line of a grouped process run: the step under way while it works, what it did by kind once settled. */
export function describeActivity(row: ActivityRow, lang: Lang): string {
  const zh = lang === "zh";
  if (row.running) return currentLine(row.steps, zh);
  if (row.tools.length === 0) return zh ? "查看思考过程" : "View reasoning";
  const groups = new Map<SegmentKey, ToolRow[]>();
  for (const tool of row.tools) {
    const key = segmentKey(classifyTool(tool.name).category);
    groups.set(key, [...(groups.get(key) ?? []), tool]);
  }
  return [...groups].map(([key, tools]) => segmentLine(key, tools, zh)).join(zh ? "，" : ", ");
}

/** Single-line snippet from reasoning text for collapsed previews. */
export function reasoningPreview(text: string, maxLen = 76): string {
  const line = text
    .split("\n")
    .map((s) => s.replace(/^[#>*\-\s`]+/, "").trim())
    .find((s) => s.length > 0);
  if (!line) return "";
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/** Label for an individual Thinking row: never empty! */
export function thinkingLabel(row: Extract<Row, { kind: "thinking" }>, lang: Lang): string {
  const zh = lang === "zh";
  if (row.streaming) return zh ? "正在思考" : "Thinking";
  if (row.redacted && !row.text.trim()) return zh ? "加密思考过程" : "Redacted reasoning";
  return zh ? "查看思考过程" : "View reasoning";
}

/** What a turn's header says: that it works, or how long it took. */
export function describeTurn(row: TurnHeaderRow, lang: Lang): string {
  const zh = lang === "zh";
  if (row.running) return zh ? "正在处理" : "Working";
  if (row.durationMs === undefined) return zh ? "过程记录" : "Activity log";
  if (row.durationMs < 1000) return zh ? "用时不到 1 秒" : "Finished in under 1 second";
  return zh ? `用时 ${spokenDuration(row.durationMs, zh)}` : `Finished in ${spokenDuration(row.durationMs, zh)}`;
}

/** A turn's length in words, as the header says it: "48 seconds", "1 minute 57 seconds", "1 小时 3 分". */
export function spokenDuration(ms: number, zh: boolean): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (n: number, en: string, cn: string) => (zh ? `${n} ${cn}` : `${n} ${en}${n === 1 ? "" : "s"}`);
  const parts = hours > 0
    ? [unit(hours, "hour", "小时"), minutes > 0 ? unit(minutes, "minute", "分") : ""]
    : [minutes > 0 ? unit(minutes, "minute", "分") : "", seconds > 0 || minutes === 0 ? unit(seconds, "second", "秒") : ""];
  return parts.filter(Boolean).join(" ");
}

/** The step a folded running turn is on, in a line. */
export function describeActiveStep(step: NonNullable<TurnHeaderRow["activeStep"]>, lang: Lang): string {
  if (step.kind === "thinking") return thinkingLabel(step, lang);
  return toolLine(step, isToolActive(step.status), lang === "zh");
}

// ── Projection ───────────────────────────────────────────────────────────────

type TurnRow = Extract<Row, { kind: "thinking" | "text" }> | ToolRow;

const isTurnRow = (row: Row): row is TurnRow => row.kind === "thinking" || row.kind === "tool" || row.kind === "text";

function activityOf(steps: ProcessStep[]): ActivityRow {
  const tools = steps.filter((step): step is ToolRow => step.kind === "tool");
  let durationMs: number | undefined;
  for (const step of steps) if (step.durationMs !== undefined) durationMs = (durationMs ?? 0) + step.durationMs;
  return {
    kind: "activity",
    // Named by its first step whether it holds one or several, so the row is not replaced when steps join it.
    id: `act:${steps[0].id}`,
    steps,
    tools,
    running: steps.some((step) => (step.kind === "tool" ? isToolActive(step.status) : step.streaming)),
    hasError: tools.some((tool) => tool.status === "error"),
    durationMs,
    diffStats: sumDiffStats(tools),
  };
}

/**
 * Projects the transcript's flat rows into the rows the chat shows.
 *
 * `isOpen(id, fallback)` is the reader's say on a turn's fold: `fallback`
 * (open until the answer is known) unless they toggled it.
 */
export function buildDisplayRows(
  rows: readonly Row[],
  sessionRunning = false,
  isOpen: (id: string, fallback: boolean, hasDetails: boolean) => boolean = (_, fallback) => fallback,
  /** Filled with the turn each shown process row belongs to, by row id, when given. */
  processOf?: Map<string, string>,
  /** Keeps a closing turn's process rows in the projection until its collapse animation settles. */
  keepProcessMounted?: (id: string) => boolean,
): DisplayRow[] {
  const out: DisplayRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (!isTurnRow(row)) {
      out.push(row);
      i++;
      continue;
    }

    const first = row;
    const process: DisplayRow[] = [];
    const answer: DisplayRow[] = [];
    let steps: ProcessStep[] = [];
    let activeStep: TurnHeaderRow["activeStep"];
    const flushSteps = () => {
      if (steps.length) process.push(activityOf(steps));
      steps = [];
    };
    for (; i < rows.length; i++) {
      const cur = rows[i];
      if (!isTurnRow(cur)) break;
      if (cur.kind === "tool" || cur.kind === "thinking") {
        steps.push(cur);
        activeStep = cur;
        continue;
      }
      // Prose with nothing to read yet (a provider's placeholder) takes no row and breaks no run of steps.
      if (!cur.text.trim()) continue;
      flushSteps();
      if (cur.final) answer.push(cur);
      else process.push(cur);
    }
    flushSteps();

    const answered = answer.length > 0;
    const running = sessionRunning && i === rows.length && !answered;
    const hasDetails = process.length > 0;
    const id = `turn:${first.id}`;
    const open = isOpen(id, !answered, hasDetails);
    if (hasDetails || running || first.turnMs !== undefined) {
      out.push({
        kind: "turn",
        id,
        running,
        startedAt: first.t0,
        durationMs: first.turnMs,
        open,
        hasDetails,
        // Only a folded running turn shows its step; left out otherwise, the header does not change with every delta.
        activeStep: running && !open ? activeStep : undefined,
      });
    }
    if (open || (hasDetails && keepProcessMounted?.(id))) {
      out.push(...process);
      if (processOf) for (const row of process) processOf.set(row.id, id);
    }
    out.push(...answer);
  }
  return out;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((item, at) => item === b[at]);

function sameRow(a: DisplayRow, b: DisplayRow): boolean {
  if (a === b) return true;
  if (a.kind === "activity" && b.kind === "activity") return sameList(a.steps, b.steps);
  if (a.kind === "turn" && b.kind === "turn") {
    return a.running === b.running && a.startedAt === b.startedAt && a.durationMs === b.durationMs && a.open === b.open && a.hasDetails === b.hasDetails && a.activeStep === b.activeStep;
  }
  return false;
}

/**
 * Every row id the chat's list can project from `rows`: the transcript rows
 * themselves, the synthesized `turn:` and `act:` rows (named by their first
 * row or step), and each reply's `#actions` row (minted in `views/Rows.tsx`).
 * A session landing marks them all seen so loaded history never replays the
 * live-row entrance.
 */
export function displayRowIds(rows: readonly Row[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    ids.push(row.id);
    if (!isTurnRow(row)) continue;
    ids.push(`turn:${row.id}`);
    if (row.kind === "text") ids.push(`${row.id}#actions`);
    else ids.push(`act:${row.id}`);
  }
  return ids;
}

/**
 * Keeps the rows that did not change the same objects from one projection to
 * the next, and the list the same array when none did: the chat's list lays
 * out again what it is handed anew, and most events change one row or none.
 */
export function stableDisplayRows(): (next: DisplayRow[]) => DisplayRow[] {
  let last: DisplayRow[] = [];
  let byId = new Map<string, DisplayRow>();
  return (next) => {
    const rows = next.map((row) => {
      const before = byId.get(row.id);
      return before && sameRow(before, row) ? before : row;
    });
    if (sameList(rows, last)) return last;
    last = rows;
    byId = new Map(rows.map((row) => [row.id, row]));
    return rows;
  };
}
