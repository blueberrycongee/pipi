import type { Lang } from "./i18n";
import type { DaemonSession } from "../pi/daemon";
import type { Row, ToolRow } from "../pi/transcript";
import { classifyTool, describeActiveStep, elapsedSeconds, type ProcessStep, selectActiveStep } from "../pi/turns";

export type PipPhase =
  | "idle"
  | "thinking"
  | "tool"
  | "writing"
  | "waiting_sessions"
  | "waiting_user"
  | "compacting"
  | "retrying"
  | "error";

export interface PipChildStatus {
  id: string;
  title: string;
  agentName: string;
  status: DaemonSession["status"];
  unread: boolean;
}

export interface PipLiveStatus {
  /** Persona display name (e.g. "Pip"). */
  name: string;
  /** Semantic phase driving status dot, icon, and copy. */
  phase: PipPhase;
  /** Whether Pip itself or any descendant session is actively working or waiting on input. */
  active: boolean;
  /** Short localized headline ("Thinking", "Working", "Writing reply", "Waiting on 2 sessions", "Ready"). */
  headline: string;
  /** Specific live detail when available ("Reading MEMORY.md", retry reason, error message). */
  detail?: string;
  /** Up to 3 recently completed tool steps in the current active turn, oldest to newest. */
  recentSteps: string[];
  /** Start timestamp (ms epoch) of the active run/turn for the live elapsed timer. */
  startedAt?: number;
  /** A prose row in the trailing run is still streaming. */
  textStreaming: boolean;
  /** A complete prose row in the trailing run has already landed on screen. */
  textLanded: boolean;
  /** Descendant sessions currently working or waiting for user confirmation. */
  activeChildren: PipChildStatus[];
  /** Engine/model label shown quietly when idle. */
  engineLabel?: string;
}

export interface PipActivityInput {
  kind: "idle" | "thinking" | "writing" | "tool" | "compacting" | "retrying";
  name?: string;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
}

export interface PipStatusInput {
  name: string;
  lang: Lang;
  rows: readonly Row[];
  running: boolean;
  activity: PipActivityInput;
  runStartedAt?: number;
  pendingDialog?: { method: string; title?: string };
  daemonSession?: DaemonSession;
  childSessions: readonly DaemonSession[];
  sidecarFailed?: boolean;
  engineLabel?: string;
}

const isTurnRow = (row: Row): row is Extract<Row, { kind: "thinking" | "text" | "media" }> | ToolRow =>
  row.kind === "thinking" || row.kind === "tool" || row.kind === "text" || row.kind === "media";

const isToolActive = (status: ToolRow["status"]) => status === "call" || status === "queued" || status === "running";

/** Formats elapsed milliseconds into a compact counter ("8s", "1m 14s", "1h 2m"). */
export function formatElapsedCompact(ms: number): string {
  const total = elapsedSeconds(ms);
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Collects the rows belonging to the trailing in-flight turn (ignoring queued user bubbles behind it). */
function activeTurnRows(rows: readonly Row[]): Array<Extract<Row, { kind: "thinking" | "text" | "media" }> | ToolRow> {
  let end = rows.length - 1;
  while (end >= 0) {
    const row = rows[end];
    if (row.kind !== "user" || !row.queued) break;
    end--;
  }
  const slice: Array<Extract<Row, { kind: "thinking" | "text" | "media" }> | ToolRow> = [];
  for (let i = end; i >= 0; i--) {
    const row = rows[i];
    if (!isTurnRow(row)) break;
    if (row.turnMs !== undefined) break;
    slice.push(row);
    if (row.turnStart) break;
  }
  slice.reverse();
  return slice;
}

function trailingTextState(rows: readonly Row[]): { streaming: boolean; landed: boolean } {
  let end = rows.length - 1;
  while (end >= 0) {
    const row = rows[end];
    if (row.kind !== "user" || !row.queued) break;
    end--;
  }
  let streaming = false;
  let landed = false;
  for (let i = end; i >= 0; i--) {
    const row = rows[i];
    if (!isTurnRow(row)) break;
    if (row.kind === "text") {
      if (row.streaming) streaming = true;
      else landed = true;
    }
    if (row.turnStart) break;
  }
  return { streaming, landed };
}

function toChildStatus(session: DaemonSession): PipChildStatus {
  const title = session.title && session.title !== "New session" ? session.title : session.agentName || session.agentId;
  return {
    id: session.id,
    title,
    agentName: session.agentName || session.agentId,
    status: session.status,
    unread: session.unread,
  };
}

/**
 * Derives Pip's live status card model directly from real store/transcript state.
 * Pure and deterministic so hover cards stay accurate across every engine and edge case.
 */
export function derivePipLiveStatus(input: PipStatusInput): PipLiveStatus {
  const zh = input.lang === "zh";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const activeChildren = input.childSessions
    .filter((s) => s.status === "working" || s.status === "blocked")
    .map(toChildStatus);
  const turnRows = input.running ? activeTurnRows(input.rows) : [];
  const turnSteps = turnRows.filter((r): r is ProcessStep => r.kind === "thinking" || r.kind === "tool");
  const activeStep = selectActiveStep(turnSteps);
  const trailingText = trailingTextState(input.rows);
  const streamingText = trailingText.streaming;
  const landedText = trailingText.landed;
  const startedAt = turnRows[0]?.t0 ?? (input.running ? input.runStartedAt : undefined);

  // Recent completed tool steps in the active turn (last 3 unique descriptions), giving clear momentum.
  const recentSteps: string[] = [];
  if (input.running) {
    for (const step of turnSteps) {
      if (step.kind !== "tool" || step.status !== "done") continue;
      const line = describeActiveStep(step, input.lang);
      if (line && recentSteps[recentSteps.length - 1] !== line) recentSteps.push(line);
    }
  }
  const tailSteps = recentSteps.slice(-3);

  const base = {
    name: input.name || "Pip",
    recentSteps: tailSteps,
    textStreaming: streamingText,
    textLanded: landedText,
    activeChildren,
    ...(input.engineLabel ? { engineLabel: input.engineLabel } : {}),
  };

  // 1. Waiting on user confirmation or form answer.
  if (input.pendingDialog) {
    return {
      ...base,
      phase: "waiting_user",
      active: true,
      headline: input.pendingDialog.method === "form" ? t("Waiting for your answer", "等待你的回答") : t("Waiting for confirmation", "等待确认"),
      ...(input.pendingDialog.title ? { detail: input.pendingDialog.title } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
  }
  if (input.daemonSession?.status === "blocked") {
    return {
      ...base,
      phase: "waiting_user",
      active: true,
      headline: t("Waiting for confirmation", "等待确认"),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
  }

  // 2. Active run phases (compacting, retrying, tool call, writing reply, thinking).
  if (input.running) {
    if (input.activity.kind === "compacting") {
      return {
        ...base,
        phase: "compacting",
        active: true,
        headline: t("Compacting context", "正在整理上下文"),
        ...(startedAt !== undefined ? { startedAt } : {}),
      };
    }
    if (input.activity.kind === "retrying") {
      const attempt = input.activity.attempt ?? 1;
      const max = input.activity.maxAttempts ?? 0;
      return {
        ...base,
        phase: "retrying",
        active: true,
        headline: max > 0 ? t(`Retrying (${attempt}/${max})`, `正在重试（${attempt}/${max}）`) : t(`Retrying (attempt ${attempt})`, `正在重试（第 ${attempt} 次）`),
        ...(input.activity.reason ? { detail: input.activity.reason } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
      };
    }
    if (activeStep?.kind === "tool" && isToolActive(activeStep.status)) {
      const isAgentTool = classifyTool(activeStep.name).category === "agent";
      return {
        ...base,
        phase: "tool",
        active: true,
        headline: isAgentTool ? t("Coordinating", "正在协调子会话") : t("Working", "正在处理"),
        detail: describeActiveStep(activeStep, input.lang),
        ...(startedAt !== undefined ? { startedAt } : {}),
      };
    }
    if (streamingText || input.activity.kind === "writing") {
      return {
        ...base,
        phase: "writing",
        active: true,
        headline: t("Writing reply", "正在整理回复"),
        ...(startedAt !== undefined ? { startedAt } : {}),
      };
    }
    if (input.activity.kind === "tool" && input.activity.name) {
      const synthetic: ToolRow = { kind: "tool", id: "_", name: input.activity.name, args: {}, status: "running", output: "", images: 0 };
      const isAgentTool = classifyTool(input.activity.name).category === "agent";
      return {
        ...base,
        phase: "tool",
        active: true,
        headline: isAgentTool ? t("Coordinating", "正在协调子会话") : t("Working", "正在处理"),
        detail: describeActiveStep(synthetic, input.lang),
        ...(startedAt !== undefined ? { startedAt } : {}),
      };
    }
    return {
      ...base,
      phase: "thinking",
      active: true,
      headline: t("Thinking", "正在思考"),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
  }

  // 3. Pip itself is idle, but descendant sessions are still working or blocked.
  if (activeChildren.length > 0) {
    const blocked = activeChildren.some((c) => c.status === "blocked");
    const count = activeChildren.length;
    return {
      ...base,
      phase: "waiting_sessions",
      active: true,
      headline: blocked
        ? t("A session needs confirmation", "有子会话等待确认")
        : t(`Waiting on ${count} ${count === 1 ? "session" : "sessions"}`, `等待 ${count} 个子会话`),
    };
  }

  // 4. Error / failed state.
  if (input.sidecarFailed || input.daemonSession?.status === "failed") {
    return {
      ...base,
      phase: "error",
      active: false,
      headline: t("Ran into a problem", "遇到了问题"),
      ...(input.daemonSession?.error ? { detail: input.daemonSession.error } : {}),
    };
  }

  // 5. Ready / idle.
  return {
    ...base,
    phase: "idle",
    active: false,
    headline: t("Ready", "空闲待命"),
  };
}
