import { computed, locale } from "nsh";
import { builtinAgentSpec } from "../agents/catalog";
import type { AgentHarnessStatus, DelegateRole, RuntimeMode } from "../agents/types";
import type { QueueMode, ThinkingLevel } from "../pi/protocol";
import type { ComposerCommand } from "./slash";
import { language } from "../store/prefs";
import type { IconName } from "../ui/Icon";
import { compactPath, tildePath } from "./format";

/** The languages pipi speaks. */
export type Lang = "en" | "zh";

/** Resolves a BCP 47 tag (`"zh-Hans-CN"`, `"en-US"`) to one of the app's languages. */
export function resolveLang(tag: string): Lang {
  return /^zh\b/i.test(tag.trim()) ? "zh" : "en";
}

/** The active UI language: the user's choice, else the system's locale. */
export const activeLanguage = computed<Lang>(() => {
  const pref = language();
  return pref === "system" ? resolveLang(locale()) : pref;
});

/** Picks the English or Chinese value for the active language (reactive). */
export function tr<T>(en: T, zh: T): T {
  return activeLanguage() === "zh" ? zh : en;
}

/** Thinking level names stay English in every locale (they are the harness's own terms); hints localize. */
export function thinkingText(level: ThinkingLevel): { label: string; hint: string } {
  switch (level) {
    case "off":
      return { label: "Off", hint: tr("Answer directly", "直接回答") };
    case "minimal":
      return { label: "Minimal", hint: tr("A moment's thought", "稍加思考") };
    case "low":
      return { label: "Low", hint: tr("Light reasoning", "轻度推理") };
    case "medium":
      return { label: "Medium", hint: tr("Balanced", "均衡推理") };
    case "high":
      return { label: "High", hint: tr("Careful reasoning", "深度推理") };
    case "xhigh":
      return { label: "Extra high", hint: tr("Long reasoning", "长考推理") };
    case "max":
      return { label: "Max", hint: tr("As much as the model allows", "尽模型所能") };
    default:
      // ACP harnesses advertise effort values outside pipi's union; show their own name.
      return { label: String(level), hint: "" };
  }
}

/** Queue mode label in the active language. */
export function queueModeLabel(mode: QueueMode): string {
  return mode === "all" ? tr("All at once", "一次全部") : tr("One at a time", "逐条发送");
}

/** Whose slash command it is, in the active language: the app's, the agent's own (by its name), or one of Pi's kinds. */
export function commandSourceLabel(source: ComposerCommand["source"], agentName: string): string {
  switch (source) {
    case "app":
      return "pipi";
    case "agent":
      return agentName;
    case "extension":
      return tr("Extension", "扩展");
    case "prompt":
      return tr("Prompt", "提示词");
    case "skill":
      return tr("Skill", "技能");
  }
}

/** Runtime permission mode labels and descriptions in the active language. */
export function runtimeModeText(mode: RuntimeMode): { label: string; short: string; hint: string } {
  switch (mode) {
    case "approval-required":
      return {
        label: tr("Supervised", "需确认"),
        short: tr("Supervised", "确认"),
        hint: tr("Ask before shell commands or edits", "执行命令或修改前先询问"),
      };
    case "auto-accept-edits":
      return {
        label: tr("Auto-accept edits", "自动编辑"),
        short: tr("Auto-edit", "自动编辑"),
        hint: tr("Allow file edits; ask before shell commands", "自动允许改文件，命令需确认"),
      };
    case "full-access":
      return {
        label: tr("Full access", "完全权限"),
        short: tr("Full", "完全"),
        hint: tr("Run commands and edit files without asking", "无需询问即可改文件与跑命令"),
      };
  }
}

/** Icon for each runtime permission mode: locked shield, half shield, bolt shield. */
export function runtimeModeIcon(mode: RuntimeMode): IconName {
  switch (mode) {
    case "approval-required":
      return "shieldLock";
    case "auto-accept-edits":
      return "shieldHalf";
    case "full-access":
      return "shieldBolt";
  }
}

/** Sub-agent role labels in the active language. */
export function delegateRoleText(role: DelegateRole): string {
  switch (role) {
    case "researcher":
      return tr("Researcher", "调研员");
    case "planner":
      return tr("Planner", "规划师");
    case "implementer":
      return tr("Implementer", "实现者");
    case "reviewer":
      return tr("Reviewer", "审查员");
    default:
      return tr("General", "通用");
  }
}

/**
 * Formats a probed agent's metadata into clean, localized, non-redundant pieces
 * so UI rows never show mixed-language jargon, duplicate version strings, or
 * multi-line wrapped CLI paths.
 */
export function formatAgentMeta(
  agent: Pick<AgentHarnessStatus, "id" | "available" | "binaryPath" | "version" | "statusText" | "isCustom">,
  home = "",
): {
  versionBadge?: string;
  statusLabel: string;
  displayPath?: string;
  fullPath?: string;
} {
  const raw = `${agent.version ?? ""} ${agent.statusText ?? ""}`;
  const semverMatch = raw.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/);
  const versionBadge = semverMatch ? `v${semverMatch[1]}` : undefined;

  const hasBinaryPath = !!agent.binaryPath;
  const fullPath = hasBinaryPath ? tildePath(agent.binaryPath!, home) : undefined;
  const displayPath = fullPath ? compactPath(fullPath, 26) : undefined;

  const note = (agent.statusText ?? "").toLowerCase();

  if (!agent.available) {
    if (note.includes("checking")) {
      return { versionBadge, statusLabel: tr("Checking…", "检测中…") };
    }
    if (note.includes("api key saved")) {
      return { versionBadge, statusLabel: tr("Key saved · CLI not installed", "已保存密钥 · 待安装 CLI") };
    }
    if (agent.isCustom) {
      return { versionBadge, statusLabel: tr("Command not found", "未找到可执行命令"), displayPath, fullPath };
    }
    return { versionBadge, statusLabel: tr("Not installed", "未检测到安装") };
  }

  if (agent.isCustom) {
    return {
      versionBadge,
      statusLabel: tr("Stdio ACP", "本地 ACP"),
      displayPath,
      fullPath,
    };
  }

  let statusLabel: string;
  if (note.includes("signed in")) {
    statusLabel = tr("Signed in", "已登录");
  } else if (note.includes("api key saved")) {
    statusLabel = tr("API key configured", "已配置 API 密钥");
  } else if (note.includes("api key") || note.includes("_key") || note.includes("token in env")) {
    statusLabel = tr("API key in env", "环境变量密钥");
  } else if (note.includes("to sign in")) {
    statusLabel = tr("Sign in via terminal", "需在终端登录");
  } else if (note.includes("acp ready")) {
    statusLabel = tr("ACP ready", "ACP 已就绪");
  } else {
    statusLabel = tr("Ready", "已就绪");
  }

  return { versionBadge, statusLabel, displayPath, fullPath };
}

/** Localized description for built-in and custom agent harnesses. */
export function agentDescription(agent: Pick<AgentHarnessStatus, "id" | "description">): string {
  const spec = builtinAgentSpec(agent.id);
  if (!spec) return agent.description;
  return tr(spec.descriptionEn, spec.descriptionZh);
}
