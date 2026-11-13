import { cleanup, computed, createAnimatedValue, effect, openUrl, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX } from "nsh";
import { AlertDialog, Button as BaseButton, Popover } from "nsh/base";
import type { AcpDistribution, AgentHarnessStatus, RuntimeMode } from "../agents/types";
import pkg from "../package.json";
import { basename, compactPath, money, relativeTime, tildePath } from "../lib/format";
import { activeLanguage, agentDescription, formatAgentMeta, queueModeLabel, runtimeModeText, tr } from "../lib/i18n";
import { WALLPAPER_EFFECTS, type WallpaperEffect } from "../lib/wallpaper";
import { COAT_IDS, COATS } from "../mascot/geometry";
import { Pip } from "../mascot/Pip";
import { agentDir } from "../pi/credentials";
import type { QueueMode } from "../pi/protocol";
import { PROVIDERS, type ProviderInfo, providerName } from "../pi/providers";
import { type SessionSummary, sessionTitle } from "../pi/sessions";
import { compactNumber } from "../pi/transcript";
import {
  activeAgent,
  activeAgentId,
  type ArchivedSessionItem,
  archivedSessionItems,
  availableAgents,
  availableModels,
  changeRuntimeMode,
  chooseWallpaperFolder,
  chooseWallpaperImage,
  clearWallpaperFolder,
  copyText,
  currentView,
  deleteAllArchivedSessions,
  deleteCustomAgent,
  externalMcpConfig,
  installPipiCli,
  openSession,
  randomWallpaper,
  refreshAgents,
  refreshUsageStats,
  removeAgentApiKey,
  removeProviderKey,
  removeSession,
  removeWallpaper,
  resetAgentOverride,
  restartPi,
  runtimeMode,
  saveAgentApiKey,
  saveCustomAgent,
  saveProviderKey,
  sessionState,
  type SettingsSection,
  setAutoCompaction,
  setAutoRetry,
  setFollowUpMode,
  setSteeringMode,
  setWallpaperEffect,
  setWallpaperThemeColors,
  showAgentSettings,
  showChat,
  showSettings,
  sidecarPhase,
  storedProviders,
  switchAgentHarness,
  toast,
  unarchiveSession,
  updateAgentOverride,
  updateAutoArchiveDays,
  updatePreferredRuntimeMode,
  usageStats,
  type View as AppView,
  wallpaper,
  wallpaperEffect,
  wallpaperFolder,
  wallpaperThemeColors,
} from "../store/app";
import { backend } from "../store/backend";
import {
  agentSendScope,
  agentSessionTools,
  type Appearance,
  appearance,
  AUTO_ARCHIVE_DAYS,
  type AutoArchiveDays,
  autoArchiveDays,
  autoRetryChoice,
  type Language,
  language,
  pipCoat,
  preferredRuntimeMode,
  runInBackground,
  SESSION_TREE_DEPTHS,
  SESSION_TREE_MAX,
  sessionTreeDepth,
  sessionTreeMax,
  type SessionTreeDepth,
  type SessionTreeMax,
  setAgentSendScope,
  setAgentSessionTools,
  setAppearance,
  setLanguage,
  setPipCoat,
  setPreferredRuntimeMode,
  setRunInBackground,
  setSessionTreeDepth,
  setSessionTreeMax,
  setWorktreeIsolationDefault,
  storedAgentOverrides,
  worktreeIsolationDefault,
} from "../store/prefs";
import { AgentLogo } from "../ui/AgentLogo";
import { Button, Chip, IconButton } from "../ui/Button";
import { Rule, Segmented, SettingGroup, SettingRow, Switch, TextField } from "../ui/Controls";
import { Icon, type IconName } from "../ui/Icon";
import { animateNextLayout, EASING, enterStagger, keepLast, popupHiddenStyle, popupLeavingStyle, popupStyle, Presence, Reveal, SPRING } from "../ui/motion";
import { FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, SCRIM } from "../ui/styles";
import { tip } from "../ui/Tip";
import { CroppedWallpaperSurface, WallpaperAdjustDialog } from "./Wallpaper";

const SECTIONS: { id: SettingsSection; label: () => string; icon: IconName }[] = [
  { id: "general", label: () => tr("General", "常规"), icon: "sliders" },
  { id: "agents", label: () => tr("Agents", "智能体"), icon: "agents" },
  { id: "sessions", label: () => tr("Sessions", "会话"), icon: "layers" },
  { id: "archive", label: () => tr("Archive", "归档"), icon: "archive" },
  { id: "usage", label: () => tr("Usage", "用量"), icon: "bolt" },
  { id: "about", label: () => tr("About", "关于"), icon: "info" },
];

/** A settings page. `back` names the page it was opened from: a page inside a section leads back to it. */
function Page(props: { title: string; lead?: string; action?: JSX.Element; back?: { label: string; onPress: () => void }; children?: JSX.Element }) {
  return (
    <Scroll class="flex-1" contentClass="items-center px-8 pb-10 pt-6">
      <View class="w-full max-w-160 gap-6" style={enterStagger(0)}>
        <View class="flex-row items-start justify-between gap-4">
          <View class="min-w-0 flex-1 gap-1">
            <If when={props.back}>
              {(back) => (
                <BaseButton testID="settings-back" onPress={() => back().onPress()} class={`-ml-1.5 mb-1 h-6 flex-row items-center gap-1 self-start rounded-md px-1.5 ${PRESS} ${FOCUS_RING} hover:bg-accent`}>
                  <Icon name="arrowLeft" size={12} tone="muted-foreground" />
                  <Text class="text-sm text-muted-foreground">{back().label}</Text>
                </BaseButton>
              )}
            </If>
            <Text class="text-xl font-semibold tracking-tight text-foreground" role="header">
              {props.title}
            </Text>
            {props.lead ? <Text class="text-sm leading-relaxed text-muted-foreground">{props.lead}</Text> : null}
          </View>
          {props.action}
        </View>
        <View class="gap-6" style={enterStagger(1)}>
          {props.children}
        </View>
      </View>
    </Scroll>
  );
}

/** A value shown as data: monospaced, selectable, quiet. */
function Value(props: { text: string; fullText?: string }) {
  return (
    <View selectable class="min-w-0 max-w-72 shrink" tooltip={props.fullText && props.fullText !== props.text ? tip(props.fullText) : undefined}>
      <Text class="truncate font-mono text-xs text-muted-foreground">{props.text}</Text>
    </View>
  );
}

/** A file or folder path value: middle-shortened so both prefix and filename remain readable. */
function PathValue(props: { path: string }) {
  const full = () => tildePath(props.path, backend().home());
  return <Value text={compactPath(full(), 38)} fullText={full()} />;
}

// ── Providers ───────────────────────────────────────────────────────────────

/**
 * Whether pipi keeps this agent's model providers itself. Only Pi's RPC documents a credential store
 * (`auth.json`) and run knobs a client may set; every other harness brings its own sign-in and models.
 */
const managesProviders = (agent: AgentHarnessStatus) => agent.driver === "pi";

/** How a provider is connected: from the models the agent lists while it runs (`live`), else from what its credential store holds. */
function connection(id: string, live: boolean): { connected: boolean; via: string; removable: boolean } {
  const stored = storedProviders()[id];
  if (!live) {
    if (stored === "api_key") return { connected: true, via: tr("API key", "API 密钥"), removable: true };
    if (stored === "oauth") return { connected: true, via: tr("Signed in", "已登录"), removable: true };
    return { connected: false, via: "", removable: false };
  }
  const models = availableModels().filter((model) => model.provider === id).length;
  if (stored === "api_key") return { connected: models > 0, via: models ? tr("API key", "API 密钥") : tr("API key saved, no models", "已保存密钥，暂无模型"), removable: true };
  if (stored === "oauth") return { connected: models > 0, via: tr("Signed in", "已登录"), removable: true };
  return { connected: models > 0, via: models ? tr("Environment or models.json", "环境变量或 models.json") : "", removable: false };
}

function ProviderRow(props: { provider: ProviderInfo; agentName: string; live: boolean; editing: boolean; onEdit: (editing: boolean) => void }) {
  const key = signal("");
  const saving = signal(false);
  const link = () => connection(props.provider.id, props.live);
  const store = () => `${tildePath(agentDir(), backend().home())}/auth.json`;
  const count = () => availableModels().filter((model) => model.provider === props.provider.id).length;
  const save = async () => {
    if (!key().trim() || saving()) return;
    saving.set(true);
    const saved = await saveProviderKey(props.provider.id, key());
    saving.set(false);
    if (saved) {
      key.set("");
      props.onEdit(false);
    }
  };
  return (
    <View class="py-2.5">
      <View class="min-h-7 flex-row items-center gap-3">
        <View class={`size-2 shrink-0 rounded-full ${link().connected ? "bg-success" : "bg-input"}`} />
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="truncate text-base text-foreground">{props.provider.name}</Text>
          <Text class="truncate text-xs text-subtle">
            {link().connected ? (props.live ? `${link().via} · ${tr(`${count()} ${count() === 1 ? "model" : "models"}`, `${count()} 个模型`)}` : link().via) : link().via || props.provider.env}
          </Text>
        </View>
        <Presence show={!props.editing} class="shrink-0 flex-row items-center gap-1.5">
          <If when={link().removable}>
            <Button label={tr("Remove", "移除")} variant="danger" size="sm" onPress={() => void removeProviderKey(props.provider.id)} />
          </If>
          <If when={props.provider.env}>
            <Button label={link().removable || link().connected ? tr("Replace Key", "更换密钥") : tr("Add Key", "添加密钥")} size="sm" onPress={() => props.onEdit(true)} />
          </If>
        </Presence>
      </View>
      <Reveal open={props.editing}>
        <View class="gap-2 pb-1 pl-5 pt-2.5">
          <View class="flex-row items-center gap-2">
            <TextField
              value={key()}
              onChange={(value) => key.set(value)}
              onSubmit={() => void save()}
              placeholder={tr(`Paste your ${props.provider.name} API key`, `粘贴你的 ${props.provider.name} API 密钥`)}
              label={tr(`${props.provider.name} API key`, `${props.provider.name} API 密钥`)}
              masked
              mono
              autoFocus
              class="min-w-0 flex-1"
            />
            <Button label={saving() ? tr("Saving…", "保存中…") : tr("Save", "保存")} variant="primary" size="lg" disabled={!key().trim() || saving()} onPress={() => void save()} />
            <Button label={tr("Cancel", "取消")} variant="ghost" size="lg" onPress={() => (key.set(""), props.onEdit(false))} />
          </View>
          <View class="flex-row items-center gap-3">
            <Text class="min-w-0 flex-1 text-xs text-subtle">
              {props.live
                ? tr(`Stored in ${store()}. ${props.agentName} restarts to load the new key.`, `保存在 ${store()}，保存后 ${props.agentName} 将重启加载。`)
                : tr(`Stored in ${store()}. ${props.agentName} loads it the next time it starts.`, `保存在 ${store()}，${props.agentName} 下次启动时加载。`)}
            </Text>
            <If when={props.provider.keysUrl}>
              {(url) => (
                <BaseButton onPress={() => void openUrl(url())} role="link" class={`h-6 shrink-0 flex-row items-center gap-1 rounded-md px-1.5 ${PRESS} ${FOCUS_RING} hover:bg-accent`}>
                  <Text class="text-xs text-brand-text">{tr("Get a key", "获取密钥")}</Text>
                  <Icon name="external" size={12} tone="brand-text" />
                </BaseButton>
              )}
            </If>
          </View>
        </View>
      </Reveal>
    </View>
  );
}

/**
 * An agent's own page inside Agents, for one whose providers pipi manages: its key manager and the
 * session knobs its RPC honors. The keys are a file, there whichever agent runs; the knobs are set on
 * a running session, so they show while this agent is the active one.
 */
function AgentProvidersPage(props: { agent: AgentHarnessStatus }) {
  const name = () => props.agent.name;
  const live = () => activeAgentId() === props.agent.id;
  const editing = signal<string | undefined>(undefined);
  // Pi does not report whether retry is on: the switch shows the user's last choice, and Pi's default before one.
  const retry = () => autoRetryChoice() ?? true;
  const queueOptions = () => QUEUE_MODE_VALUES.map((value) => ({ value, label: queueModeLabel(value) }));
  // Providers Pi reports models for but the catalog does not name: custom endpoints from models.json, extensions.
  const known = new Set(PROVIDERS.map((provider) => provider.id));
  const others = computed(() => (live() ? [...new Set(availableModels().map((model) => model.provider))].filter((id) => !known.has(id)).map((id) => ({ id, name: providerName(id), env: "" })) : []));
  // Connected providers come first; the rest keep the catalog's order.
  const ordered = computed(() => {
    const all = [...others(), ...PROVIDERS];
    const linked = (id: string) => connection(id, live()).connected || !!storedProviders()[id];
    return [...all.filter((provider) => linked(provider.id)), ...all.filter((provider) => !linked(provider.id))];
  });
  return (
    <Page
      title={name()}
      lead={tr(`The model providers ${name()} can call, and how its runs behave.`, `${name()} 可调用的模型服务商，以及它的运行方式。`)}
      back={{ label: tr("Agents", "智能体"), onPress: () => showSettings("agents") }}
    >
      <SettingGroup title={tr("Providers", "服务商")}>
        <Each of={ordered()} key={(provider) => provider.id}>
          {(provider, index) => (
            <View>
              <If when={index() > 0}>
                <Rule />
              </If>
              <ProviderRow provider={provider()} agentName={name()} live={live()} editing={editing() === provider().id} onEdit={(on) => editing.set(on ? provider().id : undefined)} />
            </View>
          )}
        </Each>
      </SettingGroup>
      <SettingGroup title={tr("Other ways to connect", "其他连接方式")}>
        <SettingRow
          title={tr("Subscriptions and OAuth", "订阅与 OAuth")}
          description={tr("Sign in to Claude or ChatGPT plans in a terminal: run pi, then /login. Restart afterwards.", "在终端运行 pi 并输入 /login 登录订阅账号，完成后在此重启。")}
        >
          <If when={live()}>
            <Button label={tr(`Restart ${name()}`, `重启 ${name()}`)} icon="refresh" onPress={() => void restartPi()} />
          </If>
        </SettingRow>
        <Rule />
        <SettingRow
          title={tr("Compatible endpoints", "兼容端点")}
          description={tr("Declare Ollama, LM Studio, or other OpenAI-compatible servers in models.json.", "可在数据目录下的 models.json 中声明 Ollama、LM Studio 等兼容服务端。")}
        >
          <PathValue path={`${agentDir()}/models.json`} />
        </SettingRow>
      </SettingGroup>
      <If when={!live()}>
        <SettingGroup title={tr("While working", "运行期间")}>
          <SettingRow
            title={tr("Run behavior", "运行方式")}
            description={tr(`Steering, follow-ups, compaction and retry are set on a running ${name()} session.`, `引导、追问、自动压缩与重试需在 ${name()} 会话运行时设置。`)}
          >
            <If when={props.agent.available}>
              <Button label={tr(`Switch to ${name()}`, `切换到 ${name()}`)} onPress={() => void switchAgentHarness(props.agent.id)} />
            </If>
          </SettingRow>
        </SettingGroup>
      </If>
      <If when={live()}>
        <SettingGroup title={tr("While working", "运行期间")}>
          <SettingRow title={tr("Steering messages", "引导消息")} description={tr("Delivered after the current tool call.", "当前工具调用结束后立即发送。")}>
            <Segmented label={tr("Steering messages", "引导消息")} value={sessionState()?.steeringMode ?? "one-at-a-time"} options={queueOptions()} onChange={(mode) => void setSteeringMode(mode)} />
          </SettingRow>
          <Rule />
          <SettingRow title={tr("Follow-up messages", "追问消息")} description={tr("Queued until the run finishes.", "排队等待整轮回复结束后发送。")}>
            <Segmented label={tr("Follow-up messages", "追问消息")} value={sessionState()?.followUpMode ?? "one-at-a-time"} options={queueOptions()} onChange={(mode) => void setFollowUpMode(mode)} />
          </SettingRow>
        </SettingGroup>
        <SettingGroup title={tr("Long sessions", "长会话")}>
          <SettingRow title={tr("Compact automatically", "自动压缩")}>
            <Switch label={tr("Compact automatically", "自动压缩")} checked={sessionState()?.autoCompactionEnabled ?? true} onChange={(on) => void setAutoCompaction(on)} />
          </SettingRow>
          <Rule />
          <SettingRow title={tr("Retry automatically", "自动重试")}>
            <Switch label={tr("Retry automatically", "自动重试")} checked={retry()} onChange={(on) => void setAutoRetry(on)} />
          </SettingRow>
        </SettingGroup>
      </If>
    </Page>
  );
}

// ── External Coding Agents & Multi-Agent Orchestration ──────────────────────

const PERMISSION_MODES: readonly RuntimeMode[] = ["approval-required", "auto-accept-edits", "full-access"];
type AgentFilter = "all" | "ready" | "acp";
const ACP_DISTRIBUTIONS: readonly AcpDistribution[] = ["binary", "npx", "uvx"];

function AgentHarnessRow(props: { agent: AgentHarnessStatus; editing: boolean; onEdit: (on: boolean) => void }) {
  const override = () => storedAgentOverrides()[props.agent.id];
  const enabled = () => props.agent.enabled !== false;
  const hasOverride = () => !!(override()?.binaryPath || override()?.extraArgs?.length);
  const storedKeySaved = () => !!storedProviders()[`agent:${props.agent.id}`];
  const binPath = signal(override()?.binaryPath ?? "");
  const extraFlags = signal((override()?.extraArgs ?? []).join(" "));
  const apiKeyInput = signal("");
  const savingKey = signal(false);
  const active = () => activeAgentId() === props.agent.id;
  const meta = () => formatAgentMeta(props.agent, backend().home());
  const desc = () => agentDescription(props.agent);
  const protocolLabel = () => {
    const p = props.agent.protocol ?? (props.agent.driver === "pi" ? "rpc" : props.agent.driver === "acp" ? "acp" : "cli");
    return p.toUpperCase();
  };

  const saveOverride = async () => {
    const extraArgs = extraFlags()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    await updateAgentOverride(props.agent.id, {
      binaryPath: binPath().trim() || undefined,
      extraArgs: extraArgs.length ? extraArgs : undefined,
    });
    props.onEdit(false);
  };

  const clearOverride = async () => {
    binPath.set("");
    extraFlags.set("");
    await resetAgentOverride(props.agent.id);
    props.onEdit(false);
  };

  const submitKey = async () => {
    if (!apiKeyInput().trim() || savingKey()) return;
    savingKey.set(true);
    const ok = await saveAgentApiKey(props.agent.id, apiKeyInput());
    savingKey.set(false);
    if (ok) apiKeyInput.set("");
  };

  return (
    <View class={`py-2.5 ${!enabled() && !active() ? "opacity-65" : ""}`}>
      <View class="min-h-8 flex-row items-center gap-3">
        <AgentLogo id={props.agent.id} size={18} tone={props.agent.available ? "foreground" : "muted-foreground"} status={props.agent.available ? "ready" : "off"} />
        <View class="min-w-0 flex-1 gap-0.5">
          <View class="min-w-0 flex-row items-center gap-1.5">
            <Text class="shrink truncate text-base font-medium text-foreground">{props.agent.name}</Text>
            <Text class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs text-subtle">{protocolLabel()}</Text>
            <If when={meta().versionBadge}>
              {(v) => <Text class="shrink-0 font-mono text-xs text-subtle">{v()}</Text>}
            </If>
            <If when={active()}>
              <Text class="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-2xs font-medium text-secondary-foreground">{tr("Active", "当前")}</Text>
            </If>
            <If when={props.agent.hasApiKey || storedKeySaved()}>
              <Text class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-subtle">{tr("Key", "已配密钥")}</Text>
            </If>
            <If when={hasOverride()}>
              <Text class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-subtle">{tr("Custom", "已定制")}</Text>
            </If>
          </View>
          <Text class="truncate text-xs text-muted-foreground">{desc()}</Text>
          <View class="min-w-0 flex-row items-center gap-1.5">
            <Text class={`shrink-0 text-xs ${props.agent.available ? "text-subtle" : "text-muted-foreground"}`}>{meta().statusLabel}</Text>
            <If when={meta().displayPath}>
              {(shortPath) => (
                <View
                  class="min-w-0 flex-1 flex-row items-center gap-1.5"
                  tooltip={meta().fullPath && meta().fullPath !== shortPath() ? tip(meta().fullPath!) : undefined}
                >
                  <Text class="shrink-0 text-xs text-subtle">·</Text>
                  <Text class="shrink truncate font-mono text-xs text-subtle">{shortPath()}</Text>
                </View>
              )}
            </If>
          </View>
        </View>
        <If when={!props.editing}>
          <View class="shrink-0 flex-row items-center gap-1.5">
            <If when={props.agent.available && enabled() && !active()}>
              <Button
                label={tr("Switch", "切换")}
                size="sm"
                onPress={() => {
                  showChat();
                  void switchAgentHarness(props.agent.id);
                }}
              />
            </If>
            <If when={managesProviders(props.agent)}>
              <Button label={tr("Providers", "服务商")} size="sm" icon="plug" onPress={() => showAgentSettings(props.agent.id)} />
            </If>
            <IconButton
              icon="sliders"
              label={tr(`Configure ${props.agent.name}`, `配置 ${props.agent.name}`)}
              onPress={() => {
                binPath.set(override()?.binaryPath ?? "");
                extraFlags.set((override()?.extraArgs ?? []).join(" "));
                apiKeyInput.set("");
                props.onEdit(true);
              }}
            />
            <If when={props.agent.id !== "pi" && !props.agent.isCustom}>
              <Switch
                label={tr(`Show ${props.agent.name} in picker`, `在选择器中启用 ${props.agent.name}`)}
                checked={enabled()}
                onChange={(on) => void updateAgentOverride(props.agent.id, { enabled: on })}
              />
            </If>
            <If when={props.agent.isCustom}>
              <Button label={tr("Remove", "移除")} variant="danger" size="sm" onPress={() => void deleteCustomAgent(props.agent.id)} />
            </If>
          </View>
        </If>
      </View>
      <Reveal open={props.editing}>
        <View class="gap-2.5 pb-1 pl-6 pt-3">
          <If when={!props.agent.available ? props.agent.installCommand : undefined}>
            {(cmd) => (
              <View class="flex-row items-center gap-2 rounded-lg border border-border bg-sunken px-3 py-2">
                <Icon name="terminal" size={14} tone="subtle" />
                <Text class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{cmd()}</Text>
                <Button label={tr("Copy Install", "复制安装命令")} size="sm" icon="copy" onPress={() => void copyText(cmd())} />
              </View>
            )}
          </If>
          <If when={props.agent.envVar}>
            {(envName) => (
              <View class="gap-1.5">
                <View class="flex-row items-center gap-2">
                  <TextField
                    value={apiKeyInput()}
                    onChange={(v) => apiKeyInput.set(v)}
                    onSubmit={() => void submitKey()}
                    placeholder={
                      storedKeySaved()
                        ? tr(`Replace saved ${envName()} key`, `替换已保存的 ${envName()} 密钥`)
                        : tr(`Paste ${envName()} (stored in auth.json)`, `粘贴 ${envName()}（加密保存在 auth.json）`)
                    }
                    label={`${props.agent.name} API key (${envName()})`}
                    masked
                    mono
                    class="min-w-0 flex-1"
                  />
                  <Button
                    label={savingKey() ? tr("Saving…", "保存中…") : tr("Save Key", "保存密钥")}
                    size="lg"
                    variant={apiKeyInput().trim() ? "primary" : "secondary"}
                    disabled={!apiKeyInput().trim() || savingKey()}
                    onPress={() => void submitKey()}
                  />
                  <If when={storedKeySaved()}>
                    <Button label={tr("Clear Key", "清除密钥")} size="lg" variant="danger" onPress={() => void removeAgentApiKey(props.agent.id)} />
                  </If>
                </View>
              </View>
            )}
          </If>
          <If when={!props.agent.isCustom}>
            <TextField
              value={binPath()}
              onChange={(v) => binPath.set(v)}
              placeholder={tr("Custom binary path (empty for auto-detect)", "自定义可执行路径（留空则自动探测）")}
              label={tr(`${props.agent.name} binary path`, `${props.agent.name} 可执行路径`)}
              mono
            />
          </If>
          <View class="flex-row items-center gap-2">
            <TextField
              value={extraFlags()}
              onChange={(v) => extraFlags.set(v)}
              onSubmit={() => void saveOverride()}
              placeholder={tr("Extra launch flags (optional)", "附加启动参数（可选）")}
              label={tr("Extra CLI launch flags", "附加启动参数")}
              mono
              class="min-w-0 flex-1"
            />
            <If when={props.agent.docsUrl}>
              {(url) => (
                <BaseButton onPress={() => void openUrl(url())} role="link" class={`h-8 shrink-0 flex-row items-center gap-1 rounded-md px-2 ${PRESS} ${FOCUS_RING} hover:bg-accent`}>
                  <Text class="text-xs text-brand-text">{tr("Docs", "文档")}</Text>
                  <Icon name="external" size={12} tone="brand-text" />
                </BaseButton>
              )}
            </If>
            <If when={hasOverride()}>
              <Button label={tr("Reset", "恢复默认")} variant="ghost" size="lg" onPress={() => void clearOverride()} />
            </If>
            <Button label={tr("Cancel", "取消")} variant="ghost" size="lg" onPress={() => props.onEdit(false)} />
            <Button label={tr("Save", "保存")} variant="primary" size="lg" onPress={() => void saveOverride()} />
          </View>
        </View>
      </Reveal>
    </View>
  );
}

/** The agents list. `focus` is an agent opened from outside (the Connect screen, the palette): it arrives with its configuration unfolded. */
function AgentsPage(props: { focus?: string }) {
  const editing = signal<string | undefined>(untracked(() => props.focus));
  effect(() => {
    const id = props.focus;
    if (id) editing.set(id);
  });
  const filter = signal<AgentFilter>("all");
  const query = signal("");
  const addingCustom = signal(false);
  const customDist = signal<AcpDistribution>("binary");
  const customName = signal("");
  const customCommand = signal("");
  const customArgs = signal("");
  const customEnvVar = signal("");
  const customModel = signal("");
  const refreshing = signal(false);

  const filteredAgents = computed(() => {
    const q = query().trim().toLowerCase();
    const f = filter();
    // Sort ready & active harnesses first, preserving catalog order within each group.
    const all = availableAgents();
    const sorted = [
      ...all.filter((a) => a.id === "pi" || a.available || a.isCustom),
      ...all.filter((a) => a.id !== "pi" && !a.available && !a.isCustom),
    ];
    return sorted.filter((a) => {
      if (f === "ready" && !a.available) return false;
      if (f === "acp" && a.protocol !== "acp" && a.driver !== "acp") return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        (a.envVar ?? "").toLowerCase().includes(q)
      );
    });
  });

  const readyCount = computed(() => availableAgents().filter((a) => a.available).length);

  const probe = async () => {
    refreshing.set(true);
    await refreshAgents();
    refreshing.set(false);
  };

  const createCustom = async () => {
    const name = customName().trim();
    const rawTarget = customCommand().trim();
    if (!name || !rawTarget) return;
    const dist = customDist();
    const args = customArgs()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    await saveCustomAgent({
      id: `acp-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36).slice(-4)}`,
      name,
      driver: "acp",
      distribution: dist,
      command: dist === "npx" ? "npx" : dist === "uvx" ? "uvx" : rawTarget,
      packageName: dist === "binary" ? undefined : rawTarget,
      args,
      envVar: customEnvVar().trim() || undefined,
      defaultModel: customModel().trim() || undefined,
    });
    customName.set("");
    customCommand.set("");
    customArgs.set("");
    customEnvVar.set("");
    customModel.set("");
    customDist.set("binary");
    addingCustom.set(false);
  };

  return (
    <Page
      title={tr("Agents", "智能体")}
      lead={tr(
        "Built-in presets for Pi, Claude Code, Codex, Devin, Cursor, Gemini, Grok, Copilot, Goose, Kimi, Qwen, and any ACP engine.",
        "内置支持 Pi、Claude Code、Codex、Devin、Cursor、Gemini、Grok、Copilot、Goose、Kimi、Qwen 等引擎与任意 ACP 智能体。",
      )}
    >
      <SettingGroup title={tr("Coding Agent Harnesses", "编码智能体引擎")}>
        <View class="flex-row items-center gap-2 py-2.5">
          <TextField
            value={query()}
            onChange={(v) => query.set(v)}
            placeholder={tr("Filter engines (Devin, Gemini, Grok…)", "搜索引擎（如 Devin、Gemini、Grok…）")}
            label={tr("Search coding agents", "搜索编码智能体")}
            class="min-w-0 flex-1"
          />
          <Segmented
            label={tr("Filter agents", "筛选智能体")}
            value={filter()}
            options={[
              { value: "all" as const, label: tr(`All (${availableAgents().length})`, `全部 (${availableAgents().length})`) },
              { value: "ready" as const, label: tr(`Ready (${readyCount()})`, `已就绪 (${readyCount()})`) },
              { value: "acp" as const, label: "ACP" },
            ]}
            onChange={(v) => filter.set(v)}
          />
          <IconButton icon="refresh" label={tr("Re-scan for coding agents", "重新扫描已安装的智能体")} disabled={refreshing()} onPress={() => void probe()} />
        </View>
        <Rule />
        <Each of={filteredAgents()} key={(a) => a.id}>
          {(agent, index) => (
            <View>
              <If when={index() > 0}>
                <Rule />
              </If>
              <AgentHarnessRow agent={agent()} editing={editing() === agent().id} onEdit={(on) => editing.set(on ? agent().id : undefined)} />
            </View>
          )}
        </Each>
        <If when={filteredAgents().length === 0}>
          <View class="items-center py-6">
            <Text class="text-sm text-subtle">{tr("No matching agent harnesses.", "没有匹配的智能体引擎。")}</Text>
          </View>
        </If>
      </SettingGroup>

      <SettingGroup title={tr("Custom ACP Agents", "自定义 ACP 智能体")}>
        <SettingRow
          title={tr("Custom stdio / npx / uvx agent", "接入任意 ACP 智能体")}
          description={tr(
            "Connect any binary, npx package, or uvx tool speaking Agent Client Protocol (ACP) over stdio.",
            "通过可执行文件、npx 包或 uvx 工具接入任意支持 Agent Client Protocol (ACP) 的外部智能体。",
          )}
        >
          <Presence show={!addingCustom()}>
            <Button label={tr("Add ACP Agent", "添加智能体")} icon="plus" onPress={() => addingCustom.set(true)} />
          </Presence>
        </SettingRow>
        <Reveal open={addingCustom()}>
          <View>
            <Rule />
            <View class="gap-2.5 py-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-xs font-medium text-subtle">{tr("Launch distribution", "运行方式")}</Text>
                <Segmented
                  label={tr("ACP distribution", "ACP 运行方式")}
                  value={customDist()}
                  options={ACP_DISTRIBUTIONS.map((d) => ({
                    value: d,
                    label: d === "binary" ? tr("Binary", "可执行文件") : d,
                  }))}
                  onChange={(d) => customDist.set(d)}
                />
              </View>
              <View class="flex-row gap-2">
                <TextField value={customName()} onChange={(v) => customName.set(v)} placeholder={tr("Display name (e.g. OpenHands)", "显示名称（如 OpenHands）")} label={tr("Agent name", "智能体名称")} autoFocus class="min-w-0 flex-1" />
                <TextField value={customModel()} onChange={(v) => customModel.set(v)} placeholder={tr("Default model (optional)", "默认模型（可选）")} label={tr("Default model", "默认模型")} mono class="min-w-0 flex-1" />
              </View>
              <View class="flex-row gap-2">
                <TextField
                  value={customCommand()}
                  onChange={(v) => customCommand.set(v)}
                  placeholder={
                    customDist() === "npx"
                      ? tr("NPM package (e.g. @zed-industries/claude-agent-acp)", "NPM 包名（如 @zed-industries/claude-agent-acp）")
                      : customDist() === "uvx"
                        ? tr("Python tool package (e.g. openhands)", "Python 工具包（如 openhands）")
                        : tr("Command or path (e.g. my-agent)", "命令或路径（如 my-agent）")
                  }
                  label={tr("Executable command", "可执行命令")}
                  mono
                  class="min-w-0 flex-1"
                />
                <TextField value={customArgs()} onChange={(v) => customArgs.set(v)} onSubmit={() => void createCustom()} placeholder={tr("Arguments (e.g. acp --stdio)", "参数（如 acp --stdio）")} label={tr("Command arguments", "命令参数")} mono class="min-w-0 flex-1" />
              </View>
              <TextField
                value={customEnvVar()}
                onChange={(v) => customEnvVar.set(v)}
                placeholder={tr("API key environment variable (optional, e.g. OPENHANDS_API_KEY)", "API 密钥环境变量名（可选，如 OPENHANDS_API_KEY）")}
                label={tr("API key environment variable", "API 密钥环境变量")}
                mono
              />
              <View class="flex-row justify-end gap-2 pt-1">
                <Button label={tr("Cancel", "取消")} variant="ghost" size="lg" onPress={() => addingCustom.set(false)} />
                <Button label={tr("Save ACP Agent", "保存智能体")} variant="primary" size="lg" disabled={!customName().trim() || !customCommand().trim()} onPress={() => void createCustom()} />
              </View>
            </View>
          </View>
        </Reveal>
      </SettingGroup>

    </Page>
  );
}

// ── Sessions ────────────────────────────────────────────────────────────

const SESSION_DEPTH_VALUES: readonly SessionTreeDepth[] = [...SESSION_TREE_DEPTHS];
const SESSION_MAX_VALUES: readonly SessionTreeMax[] = [...SESSION_TREE_MAX];

/** How sessions run and how agents collaborate inside them — every row maps to a rule the session daemon enforces. */
function SessionsPage() {
  const cliInstalled = signal<string | undefined>(undefined);
  const cliInstalling = signal(false);
  const mcpCopied = signal(false);

  const installCli = async () => {
    cliInstalling.set(true);
    try {
      const path = await installPipiCli();
      cliInstalled.set(path);
      toast("success", tr(`pipi installed to ${path}`, `pipi 已安装到 ${path}`));
    } catch {
      toast("error", tr("Could not install the pipi command", "pipi 命令安装失败"));
    } finally {
      cliInstalling.set(false);
    }
  };

  const copyMcp = () => {
    void externalMcpConfig().then((snippet) => {
      copyText(snippet);
      mcpCopied.set(true);
      setTimeout(() => mcpCopied.set(false), 1800);
    });
  };

  return (
    <Page
      title={tr("Sessions", "会话")}
      lead={tr(
        "How sessions run — and whether agents inside them may start, message, and stop sessions of their own.",
        "会话如何运行，以及会话里的智能体能否开会话、发消息、停止会话。",
      )}
    >
      <SettingGroup title={tr("New session defaults", "新会话默认值")}>
        <SettingRow
          title={tr("Permission mode", "运行权限")}
          description={tr(
            "The default for sessions you open. A session's own children never exceed its mode.",
            "新开会话的默认权限。会话的子会话不会超出它自己的权限。",
          )}
        >
          <Segmented
            label={tr("Permission mode", "运行权限")}
            value={preferredRuntimeMode()}
            options={PERMISSION_MODES.map((m) => ({ value: m, label: runtimeModeText(m).short }))}
            onChange={(m) => updatePreferredRuntimeMode(m)}
          />
        </SettingRow>
        <Rule />
        <SettingRow
          title={tr("Git worktree isolation", "Git 工作树隔离")}
          description={tr(
            "Agent-started and comparison sessions each get their own pipi/* branch worktree.",
            "智能体开出的会话和并行对比的会话各自使用独立的 pipi/* 分支工作树。",
          )}
        >
          <Switch label={tr("Git worktree isolation", "Git 工作树隔离")} checked={worktreeIsolationDefault()} onChange={setWorktreeIsolationDefault} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={tr("Agent collaboration", "智能体协作")}>
        <SettingRow
          title={tr("Let agents drive sessions", "允许智能体操作会话")}
          description={tr(
            "Agents get six session tools: list, read, send, start, and stop. Off: the daemon refuses them at once.",
            "为智能体提供六个会话工具：列出、读取、发消息、开会话、停止。关闭后守护进程立即拒绝调用。",
          )}
        >
          <Switch label={tr("Let agents drive sessions", "允许智能体操作会话")} checked={agentSessionTools()} onChange={setAgentSessionTools} />
        </SettingRow>
        <Rule />
        <SettingRow
          title={tr("Can message", "可以发消息给")}
          description={tr("Which sessions an agent may send to.", "智能体可以发消息给哪些会话。")}
        >
          <Segmented
            label={tr("Can message", "可以发消息给")}
            value={agentSendScope()}
            options={[
              { value: "children" as const, label: tr("Its own sessions", "自己开的会话") },
              { value: "all" as const, label: tr("All sessions", "所有会话") },
            ]}
            onChange={setAgentSendScope}
          />
        </SettingRow>
        <Rule />
        <SettingRow title={tr("Child session depth", "子会话层数")} description={tr("How deep agent-started sessions may nest.", "智能体开出的会话最多嵌套几层。")}>
          <Segmented
            label={tr("Child session depth", "子会话层数")}
            value={String(sessionTreeDepth())}
            options={SESSION_DEPTH_VALUES.map((d) => ({ value: String(d), label: String(d) }))}
            onChange={(v) => setSessionTreeDepth(Number(v) as SessionTreeDepth)}
          />
        </SettingRow>
        <Rule />
        <SettingRow
          title={tr("Running per tree", "每棵树同时运行的会话")}
          description={tr("Concurrent sessions in one tree.", "一棵会话树同时运行的会话数。")}
        >
          <Segmented
            label={tr("Running per tree", "同时运行数")}
            value={String(sessionTreeMax())}
            options={SESSION_MAX_VALUES.map((m) => ({ value: String(m), label: String(m) }))}
            onChange={(v) => setSessionTreeMax(Number(v) as SessionTreeMax)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={tr("Background", "后台")}>
        <SettingRow
          title={tr("Keep running after the window closes", "关闭窗口后继续运行")}
          description={tr(
            "Sessions stay alive under the pipi daemon; reopen the window to find them where they were.",
            "会话由 pipi 守护进程保持运行；重新打开窗口即可回到原处。",
          )}
        >
          <Switch label={tr("Keep running in the background", "后台继续运行")} checked={runInBackground()} onChange={setRunInBackground} />
        </SettingRow>
        <Rule />
        <SettingRow
          title={tr("Command line tool", "命令行工具")}
          description={
            cliInstalled()
              ? tr(`Installed at ${cliInstalled()}`, `已安装到 ${cliInstalled()}`)
              : tr("Install the `pipi` command — drive sessions from scripts and other agents.", "安装 `pipi` 命令——从脚本和其他智能体驱动会话。")
          }
        >
          <Button
            label={cliInstalled() ? tr("Installed", "已安装") : tr("Install", "安装")}
            variant="secondary"
            size="sm"
            disabled={cliInstalling() || !!cliInstalled()}
            onPress={() => void installCli()}
          />
        </SettingRow>
        <Rule />
        <SettingRow
          title={tr("Use in other apps", "在其他应用里使用")}
          description={tr("Copy the MCP config for agents not started by pipi.", "复制一段 MCP 配置，给不是 pipi 启动的智能体用。")}
        >
          <Button label={mcpCopied() ? tr("Copied", "已复制") : tr("Copy config", "复制配置")} variant="secondary" size="sm" icon="copy" onPress={copyMcp} />
        </SettingRow>
      </SettingGroup>
    </Page>
  );
}

// ── General ─────────────────────────────────────────────────────────────

const QUEUE_MODE_VALUES: readonly QueueMode[] = ["one-at-a-time", "all"];
const APPEARANCE_VALUES: readonly Appearance[] = ["system", "light", "dark"];
const LANGUAGE_VALUES: readonly Language[] = ["system", "en", "zh"];

function appearanceLabel(value: Appearance) {
  switch (value) {
    case "system":
      return tr("System", "跟随系统");
    case "light":
      return tr("Light", "浅色");
    case "dark":
      return tr("Dark", "深色");
  }
}

function languageOptionLabel(value: Language) {
  switch (value) {
    case "system":
      return tr("System", "跟随系统");
    case "en":
      return "English";
    case "zh":
      return "中文";
  }
}

function wallpaperEffectLabel(effect: WallpaperEffect) {
  switch (effect) {
    case "none":
      return tr("None", "无");
    case "dither":
      return tr("Dither", "抖动");
    case "ascii":
      return "ASCII";
    case "halftone":
      return tr("Halftone", "半调网点");
    case "scanlines":
      return tr("Scanlines", "扫描线");
  }
}

function wallpaperEffectDescription(effect: WallpaperEffect) {
  switch (effect) {
    case "none":
      return tr("Render the original image without a shader pass.", "直接显示原图，不叠加着色器滤镜。");
    case "dither":
      return tr("Ordered Bayer matrix dithering with crisp ink contrast.", "使用有序 Bayer 矩阵抖动，呈现复古墨点质感。");
    case "ascii":
      return tr("5×7 bitmap glyph matrix mapped by local luminance.", "按局部亮度映射为 5×7 位图字符矩阵。");
    case "halftone":
      return tr("Print-style halftone dots sized by tone.", "按明暗阶调缩放的印刷半调圆点。");
    case "scanlines":
      return tr("Subtle horizontal CRT scanline modulation.", "细腻的水平 CRT 扫描线纹理。");
  }
}

/** App-wide preferences only: the model, thinking and run knobs belong to a session and its harness. */
function General() {
  const adjustOpen = signal(false);
  return (
    <Page title={tr("General", "常规")}>
      <SettingGroup title={tr("Appearance", "外观")}>
        <SettingRow title={tr("Theme", "主题")}>
          <Segmented label={tr("Theme", "主题")} value={appearance()} options={APPEARANCE_VALUES.map((value) => ({ value, label: appearanceLabel(value) }))} onChange={setAppearance} />
        </SettingRow>
        <Rule />
        <SettingRow title={tr("Language", "语言")}>
          <Segmented label={tr("Language", "语言")} value={language()} options={LANGUAGE_VALUES.map((value) => ({ value, label: languageOptionLabel(value) }))} onChange={setLanguage} />
        </SettingRow>
        <Rule />
        <SettingRow
          title={tr("Wallpaper", "壁纸")}
          description={
            wallpaper()
              ? `${wallpaper()!.name} · ${wallpaper()!.width}×${wallpaper()!.height}`
              : tr("A picture behind the whole window.", "铺在整个窗口之下的图片。")
          }
        >
          <View class="flex-row items-center gap-2">
            <If
              when={wallpaper()}
              else={
                <Button
                  label={tr("Choose image", "选择图片")}
                  icon="image"
                  size="sm"
                  onPress={() => void chooseWallpaperImage()}
                />
              }
            >
              {(wp) => (
                <>
                  <BaseButton
                    onPress={() => adjustOpen.set(true)}
                    accessibilityLabel={tr("Preview and adjust wallpaper", "预览并调整壁纸")}
                    class={`relative h-9 w-15 overflow-hidden rounded-md border border-border bg-sunken ${PRESS} ${FOCUS_RING}`}
                  >
                    <CroppedWallpaperSurface
                      config={wp()}
                      effect={wallpaperEffect()}
                    />
                  </BaseButton>
                  <Button
                    label={tr("Adjust", "调整")}
                    size="sm"
                    onPress={() => adjustOpen.set(true)}
                  />
                  <Button
                    label={tr("Replace image", "更换图片")}
                    size="sm"
                    onPress={() => void chooseWallpaperImage()}
                  />
                  <Button
                    label={tr("Remove", "移除")}
                    variant="danger"
                    size="sm"
                    onPress={() => void removeWallpaper()}
                  />
                </>
              )}
            </If>
          </View>
        </SettingRow>
        <Rule />
        <SettingRow
          title={tr("Wallpaper folder", "壁纸文件夹")}
          description={
            wallpaperFolder()
              ? `${tildePath(wallpaperFolder()!, backend().home())} · ${tr("⌘U picks a random image from this folder.", "按 ⌘U 从此文件夹随机切换壁纸。")}`
              : tr("Choose a folder so ⌘U can rotate random wallpapers.", "选择一个壁纸文件夹，随时按 ⌘U 随机切换背景。")
          }
        >
          <View class="flex-row items-center gap-2">
            <If when={wallpaperFolder()}>
              <Button
                label={tr("Shuffle", "随机一张")}
                icon="shuffle"
                size="sm"
                onPress={() => void randomWallpaper()}
              />
            </If>
            <Button
              label={wallpaperFolder() ? tr("Change folder", "更换文件夹") : tr("Choose folder", "选择文件夹")}
              icon="folder"
              size="sm"
              onPress={() => void chooseWallpaperFolder()}
            />
            <If when={wallpaperFolder()}>
              <Button
                label={tr("Clear", "清除")}
                variant="ghost"
                size="sm"
                onPress={clearWallpaperFolder}
              />
            </If>
          </View>
        </SettingRow>
        <If when={wallpaper()}>
          <Rule />
          <SettingRow
            title={tr("Wallpaper effect", "壁纸效果")}
            description={wallpaperEffectDescription(wallpaperEffect())}
          >
            <Segmented
              label={tr("Wallpaper effect", "壁纸效果")}
              value={wallpaperEffect()}
              options={WALLPAPER_EFFECTS.map((eff) => ({
                value: eff,
                label: wallpaperEffectLabel(eff),
              }))}
              onChange={setWallpaperEffect}
            />
          </SettingRow>
          <Rule />
          <SettingRow
            title={tr("Match wallpaper colors", "匹配壁纸配色")}
            description={tr(
              "Tint window surfaces and brand accents using the wallpaper's dominant color.",
              "根据当前壁纸的主色调微调界面背景与强调色。",
            )}
          >
            <Switch
              label={tr("Match wallpaper colors", "匹配壁纸配色")}
              checked={wallpaperThemeColors()}
              onChange={setWallpaperThemeColors}
            />
          </SettingRow>
        </If>
      </SettingGroup>
      <WallpaperAdjustDialog open={adjustOpen()} onClose={() => adjustOpen.set(false)} />
      <SettingGroup title="pipi">
        <View class="gap-3 px-3 py-3">
          {(["cat", "dog"] as const).map((species) => (
            <View class="gap-1">
              <Text class="px-1 text-2xs text-subtle">{species === "cat" ? tr("Cats", "猫") : tr("Dogs", "狗")}</Text>
              <View class="flex-row flex-wrap gap-2">
                {COAT_IDS.filter((id) => COATS[id].species === species).map((id) => {
                  const name = () => tr(COATS[id].name.en, COATS[id].name.zh);
                  const chosen = () => pipCoat() === id;
                  return (
                    <BaseButton
                      onPress={() => setPipCoat(id)}
                      role="radio"
                      selected={chosen()}
                      accessibilityLabel={name()}
                      class={`w-19 items-center gap-1.5 rounded-lg border py-2.5 ${PRESS} ${FOCUS_RING} ${chosen() ? "border-brand bg-brand-soft" : "border-transparent hover:bg-accent"}`}
                    >
                      <Pip size={40} coat={id} mood={chosen() ? "happy" : "idle"} still={!chosen()} />
                      <Text class={`text-xs ${chosen() ? "font-medium text-foreground" : "text-muted-foreground"}`}>{name()}</Text>
                    </BaseButton>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      </SettingGroup>
    </Page>
  );
}

// ── Archive ─────────────────────────────────────────────────────────────────

function autoArchiveLabel(days: AutoArchiveDays) {
  return days === 0 ? tr("Off", "关闭") : tr(`After ${days} days`, `${days} 天后`);
}

function archiveProjectLabel(cwd: string, allCwds: readonly string[]) {
  if (!cwd) return tr("No workspace", "未归属工作区");
  const name = basename(cwd) || cwd;
  const clashes = allCwds.filter((other) => other !== cwd && basename(other) === name);
  if (!clashes.length) return name;
  return tildePath(cwd, backend().home());
}

function ArchivePage() {
  const query = signal("");
  const workspaceFilter = signal("all");
  const daysMenuOpen = signal(false);
  const wsMenuOpen = signal(false);
  const deletingAll = signal(false);

  const allItems = () => archivedSessionItems();
  const allCwds = computed(() => [...new Set(allItems().map((item) => item.cwd))]);
  const workspaceOptions = computed(() => [
    { value: "all", label: tr("All workspaces", "所有工作区") },
    ...allCwds().map((cwd) => ({ value: cwd, label: archiveProjectLabel(cwd, allCwds()) })),
  ]);
  const selectedWorkspaceLabel = () => {
    const active = workspaceFilter();
    return workspaceOptions().find((opt) => opt.value === active)?.label ?? tr("All workspaces", "所有工作区");
  };

  const groups = computed(() => {
    const q = query().trim().toLowerCase();
    const filterCwd = workspaceFilter();
    const validFilter = filterCwd === "all" || allCwds().includes(filterCwd) ? filterCwd : "all";
    const grouped = new Map<string, { cwd: string; projectName: string; items: ArchivedSessionItem[] }>();
    for (const item of allItems()) {
      const title = sessionTitle(item.session, tr("New session", "新会话"));
      if (validFilter !== "all" && item.cwd !== validFilter) continue;
      if (q && !title.toLowerCase().includes(q) && !basename(item.cwd).toLowerCase().includes(q)) continue;
      const key = item.cwd || "no-workspace";
      let group = grouped.get(key);
      if (!group) {
        group = { cwd: item.cwd, projectName: archiveProjectLabel(item.cwd, allCwds()), items: [] };
        grouped.set(key, group);
      }
      group.items.push(item);
    }
    return [...grouped.values()];
  });

  const noMatches = () => allItems().length > 0 && groups().length === 0;

  const confirmDeleteOne = async (session: SessionSummary, cwd: string) => {
    const title = sessionTitle(session, tr("New session", "新会话"));
    const { action } = await AlertDialog.show({
      title: tr("Delete this archived session?", "删除此归档会话？"),
      description: tr(
        `“${title}” will be permanently removed from this Mac. This cannot be undone.`,
        `「${title}」将从此设备永久删除，此操作无法撤销。`,
      ),
      actions: [
        { label: tr("Cancel", "取消"), role: "cancel", id: "cancel" },
        { label: tr("Delete", "删除"), role: "destructive", id: "delete" },
      ],
    });
    if (action === "delete") {
      animateNextLayout(180);
      await removeSession(session.path, cwd);
    }
  };

  const confirmDeleteAll = async () => {
    const count = allItems().length;
    if (count === 0 || deletingAll()) return;
    const { action } = await AlertDialog.show({
      title: tr(
        `Delete ${count} archived conversation${count === 1 ? "" : "s"}?`,
        `删除 ${count} 个归档会话？`,
      ),
      description: tr(
        "This permanently deletes these conversations and their history across all workspaces, including items hidden by filters. This cannot be undone. Unarchived conversations are kept.",
        "这将永久删除所有工作区中的这些会话及其历史记录，包括被筛选条件隐藏的内容。此操作无法撤销，未归档的会话将被保留。",
      ),
      actions: [
        { label: tr("Cancel", "取消"), role: "cancel", id: "cancel" },
        {
          label: tr(`Delete ${count} Conversation${count === 1 ? "" : "s"}`, `删除 ${count} 个会话`),
          role: "destructive",
          id: "delete",
        },
      ],
    });
    if (action !== "delete") return;
    deletingAll.set(true);
    try {
      await deleteAllArchivedSessions();
    } finally {
      deletingAll.set(false);
    }
  };

  return (
    <Page
      title={tr("Archive", "归档")}
      lead={tr(
        "Conversations hidden from the sidebar stay on disk and can be opened or restored here anytime.",
        "从侧边栏收起的对话仍保留在本地，随时可以在这里打开阅读或恢复。",
      )}
      action={
        allItems().length > 0 || deletingAll() ? (
          <Button
            label={deletingAll() ? tr("Deleting…", "正在删除…") : tr("Delete All Archived", "删除全部归档")}
            icon="trash"
            variant="danger"
            disabled={deletingAll()}
            onPress={() => void confirmDeleteAll()}
          />
        ) : undefined
      }
    >
      <SettingGroup>
        <SettingRow
          title={tr("Archive inactive conversations", "自动归档无活动的对话")}
          description={tr(
            "Running and open conversations are never archived.",
            "运行中和正在打开的对话不会被归档。",
          )}
        >
          <Popover
            open={daysMenuOpen()}
            onOpenChange={(e) => daysMenuOpen.set(e.open)}
            placement="bottom"
            align="end"
            offset={6}
            margin={12}
            popupClass={`w-44 overflow-hidden p-1.5 ${POPUP}`}
            popupStyle={popupStyle("bottom", "end")}
            popupStartingStyle={popupHiddenStyle("bottom", "end")}
            popupEndingStyle={popupLeavingStyle("bottom", "end")}
            trigger={
              <Chip
                testID="settings-auto-archive"
                label={autoArchiveLabel(autoArchiveDays())}
                class="bg-secondary text-secondary-foreground"
                trailing={<Icon name="chevronDown" size={12} tone="subtle" />}
              />
            }
          >
            <Each of={AUTO_ARCHIVE_DAYS}>
              {(days) => (
                <BaseButton
                  selected={autoArchiveDays() === days()}
                  onPress={() => {
                    updateAutoArchiveDays(days());
                    daysMenuOpen.set(false);
                  }}
                  class={`h-8 flex-row items-center justify-between rounded-lg px-2.5 ${PRESS} ${FOCUS_RING} hover:bg-accent selected:bg-accent`}
                >
                  <Text class="text-base text-foreground">{autoArchiveLabel(days())}</Text>
                  <If when={autoArchiveDays() === days()}>
                    <Icon name="check" size={14} tone="brand-text" />
                  </If>
                </BaseButton>
              )}
            </Each>
          </Popover>
        </SettingRow>
      </SettingGroup>

      <If when={allItems().length > 0}>
        <View class="flex-row items-center gap-2">
          <View class="relative min-w-0 flex-1 justify-center">
            <TextField
              value={query()}
              onChange={(v) => query.set(v)}
              placeholder={tr("Search archived items", "搜索归档内容")}
              label={tr("Search archived items", "搜索归档内容")}
              class="w-full"
              inputClass="pl-8"
              hintClass="left-8"
            />
            <View class="pointer-events-none absolute inset-y-0 left-2.5 justify-center">
              <Icon name="search" size={14} tone="subtle" />
            </View>
          </View>
          <If when={workspaceOptions().length > 2}>
            <Popover
              open={wsMenuOpen()}
              onOpenChange={(e) => wsMenuOpen.set(e.open)}
              placement="bottom"
              align="end"
              offset={6}
              margin={12}
              popupClass={`w-56 overflow-hidden p-1.5 ${POPUP}`}
              popupStyle={popupStyle("bottom", "end")}
              popupStartingStyle={popupHiddenStyle("bottom", "end")}
              popupEndingStyle={popupLeavingStyle("bottom", "end")}
              trigger={
                <Chip
                  label={selectedWorkspaceLabel()}
                  icon="folder"
                  class="h-8 bg-secondary px-2.5 text-secondary-foreground"
                  trailing={<Icon name="chevronDown" size={12} tone="subtle" />}
                />
              }
            >
              <Each of={workspaceOptions()} key={(opt) => opt.value}>
                {(opt) => (
                  <BaseButton
                    selected={workspaceFilter() === opt().value}
                    onPress={() => {
                      workspaceFilter.set(opt().value);
                      wsMenuOpen.set(false);
                    }}
                    class={`h-8 flex-row items-center justify-between gap-2 rounded-lg px-2.5 ${PRESS} ${FOCUS_RING} hover:bg-accent selected:bg-accent`}
                  >
                    <Text class="min-w-0 flex-1 truncate text-base text-foreground">{opt().label}</Text>
                    <If when={workspaceFilter() === opt().value}>
                      <Icon name="check" size={14} tone="brand-text" />
                    </If>
                  </BaseButton>
                )}
              </Each>
            </Popover>
          </If>
        </View>
      </If>

      <If
        when={allItems().length > 0 && !noMatches()}
        else={
          <SettingGroup>
            <View class="items-center gap-1 py-8">
              <Text class="text-base font-medium text-foreground">
                {noMatches() ? tr("No matching archived items", "没有匹配的归档内容") : tr("No archived conversations", "暂无已归档的对话")}
              </Text>
              <If when={!noMatches()}>
                <Text class="text-center text-sm text-muted-foreground">
                  {tr("Conversations hidden from the sidebar can also be restored here.", "从侧边栏隐藏的对话也可在这里恢复。")}
                </Text>
              </If>
            </View>
          </SettingGroup>
        }
      >
        <View class="gap-5" testID="settings-archive-list">
          <Each of={groups()} key={(g) => g.cwd || "no-workspace"}>
            {(group) => (
              <View class="gap-1.5">
                <View class="flex-row items-center justify-between px-1">
                  <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                    <Icon name="folder" size={14} tone="muted-foreground" />
                    <Text class="truncate text-sm font-medium text-muted-foreground">{group().projectName}</Text>
                  </View>
                  <Text class="text-xs tabular-nums text-subtle">{String(group().items.length)}</Text>
                </View>
                <View class="overflow-hidden rounded-xl bg-muted/50 px-4">
                  <Each of={group().items} key={(item) => item.id}>
                    {(entry, index) => {
                      const title = () => sessionTitle(entry().session, tr("New session", "新会话"));
                      return (
                        <View>
                          <If when={index() > 0}>
                            <Rule />
                          </If>
                          <View class="min-h-11 flex-row items-center justify-between gap-3 py-2">
                            <BaseButton
                              onPress={() => void openSession(entry().session.path, entry().cwd)}
                              tooltip={tip(tr("Open conversation", "打开对话"))}
                              class={`min-w-0 flex-1 flex-row items-center gap-2.5 rounded-lg px-1.5 py-1 -ml-1.5 ${PRESS} ${FOCUS_RING} hover:bg-accent`}
                            >
                              <AgentLogo id={entry().session.agentId ?? "pi"} size={15} tone="muted-foreground" />
                              <Text class="min-w-0 flex-1 truncate text-base text-foreground">{title()}</Text>
                              <Text class="shrink-0 text-xs tabular-nums text-subtle">
                                {relativeTime(entry().session.modified, Date.now(), activeLanguage())}
                              </Text>
                            </BaseButton>
                            <View class="shrink-0 flex-row items-center gap-1">
                              <Button
                                label={tr("Restore", "恢复")}
                                icon="unarchive"
                                size="sm"
                                variant="ghost"
                                disabled={deletingAll()}
                                onPress={() => {
                                  animateNextLayout(180);
                                  unarchiveSession(entry().session.path);
                                }}
                              />
                              <IconButton
                                icon="trash"
                                size="sm"
                                label={tr(`Delete ${title()}`, `删除 ${title()}`)}
                                disabled={deletingAll()}
                                onPress={() => void confirmDeleteOne(entry().session, entry().cwd)}
                              />
                            </View>
                          </View>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </View>
            )}
          </Each>
        </View>
      </If>
    </Page>
  );
}

// ── Usage ───────────────────────────────────────────────────────────────────

/** A day in the trailing-30-day chart, zero-filled so gaps read as gaps. */
function trailingDays() {
  const byDay = new Map(usageStats().daily.map((day) => [day.day, day]));
  const pad = (n: number) => String(n).padStart(2, "0");
  const out: { day: string; tokens: number; cost: number }[] = [];
  for (let back = 29; back >= 0; back--) {
    const at = new Date(Date.now() - back * 86_400_000);
    const key = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    out.push(byDay.get(key) ?? { day: key, tokens: 0, cost: 0 });
  }
  return out;
}

function Usage() {
  const data = () => usageStats();
  const totals = () => data().totals;
  const maxDay = () => Math.max(1, ...trailingDays().map((day) => day.tokens));
  const agentName = (id: string) => availableAgents().find((agent) => agent.id === id)?.name ?? id;
  const share = (tokens: number) => (totals().total ? Math.round((tokens / totals().total) * 100) : 0);
  return (
    <Page
      title={tr("Usage", "用量")}
      lead={tr(
        "Token use and cost accumulated across every agent and saved session on this machine.",
        "本机全部智能体与已保存会话累计的 token 消耗与费用。",
      )}
    >
      <SettingGroup title={tr("Total", "总计")}>
        <SettingRow
          title="Tokens"
          description={tr(
            `${compactNumber(totals().input)} in · ${compactNumber(totals().output)} out · ${compactNumber(totals().cacheRead + totals().cacheWrite)} cached`,
            `输入 ${compactNumber(totals().input)} · 输出 ${compactNumber(totals().output)} · 缓存 ${compactNumber(totals().cacheRead + totals().cacheWrite)}`,
          )}
        >
          <Value text={compactNumber(totals().total)} />
        </SettingRow>
        <Rule />
        <SettingRow title={tr("Estimated cost", "估算费用")}>
          <Value text={money(totals().cost)} />
        </SettingRow>
        <Rule />
        <SettingRow title={tr("Sessions", "会话")}>
          <Value
            text={tr(
              `${totals().sessions} sessions · ${totals().userMessages + totals().assistantMessages} messages · ${totals().toolCalls} tool calls`,
              `${totals().sessions} 个会话 · ${totals().userMessages + totals().assistantMessages} 条消息 · ${totals().toolCalls} 次工具调用`,
            )}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={tr("Last 30 days", "近 30 天")}>
        <View class="gap-2 py-3">
          <View class="h-20 flex-row items-end gap-1">
            <Each of={trailingDays()}>
              {(day) => (
                <View
                  class={`min-w-0 flex-1 rounded-sm ${day().tokens ? "bg-primary" : "bg-input"}`}
                  style={{ height: day().tokens ? `${Math.max(4, Math.round((day().tokens / maxDay()) * 100))}%` : 3 }}
                  tooltip={tip(`${day().day} · ${compactNumber(day().tokens)} tokens · ${money(day().cost)}`)}
                />
              )}
            </Each>
          </View>
          <View class="flex-row items-center justify-between">
            <Text class="text-2xs text-subtle">{trailingDays()[0]?.day ?? ""}</Text>
            <View class="flex-row items-center gap-1.5">
              <Text class="text-2xs text-subtle">{tr("today", "今天")}</Text>
              <IconButton icon="refresh" size="sm" label={tr("Re-scan saved sessions", "重新扫描已保存会话")} onPress={() => void refreshUsageStats()} />
            </View>
          </View>
        </View>
      </SettingGroup>
      <If when={data().agents.length > 0}>
        <SettingGroup title={tr("By agent", "按智能体")}>
          <Each of={data().agents} key={(agent) => agent.agentId}>
            {(agent, index) => (
              <View>
                <If when={index() > 0}>
                  <Rule />
                </If>
                <View class="gap-1.5 py-2.5">
                  <View class="flex-row items-center justify-between gap-4">
                    <View class="min-w-0 flex-1 flex-row items-center gap-2">
                      <AgentLogo id={agent().agentId} size={16} tone="muted-foreground" />
                      <Text class="text-base text-foreground">{agentName(agent().agentId)}</Text>
                      <Text class="shrink truncate text-sm text-muted-foreground">
                        {tr(`${agent().sessions} sessions · ${agent().messages} messages`, `${agent().sessions} 个会话 · ${agent().messages} 条消息`)}
                      </Text>
                    </View>
                    <Value text={`${compactNumber(agent().tokens.total)} · ${money(agent().cost)}`} />
                  </View>
                  <View class="h-1 overflow-hidden rounded-full bg-input">
                    <View class="h-1 rounded-full bg-primary" style={{ width: `${share(agent().tokens.total)}%` }} />
                  </View>
                </View>
              </View>
            )}
          </Each>
        </SettingGroup>
      </If>
      <If when={data().models.length > 0}>
        <SettingGroup title={tr("By model", "按模型")}>
          <Each of={data().models} key={(m) => `${m.provider}·${m.model}`}>
            {(model, index) => (
              <View>
                <If when={index() > 0}>
                  <Rule />
                </If>
                <SettingRow
                  title={model().model || tr("Unattributed", "未归属")}
                  description={model().provider ? `${providerName(model().provider)} · ${tr(`${model().messages} calls`, `${model().messages} 次调用`)}` : undefined}
                >
                  <Value text={`${compactNumber(model().tokens.total)} · ${money(model().cost)}`} />
                </SettingRow>
              </View>
            )}
          </Each>
        </SettingGroup>
      </If>
    </Page>
  );
}

function About() {
  const processStatus = () => {
    const name = sidecarPhase().name;
    if (name === "ready") return tr("Running", "运行中");
    if (name === "starting") return tr("Starting", "启动中");
    return tr("Stopped", "已停止");
  };
  return (
    <Page
      title={tr("About", "关于")}
      lead={tr(
        "A native control surface for the coding agents already on your machine.",
        "为你机器上已有的编码智能体打造的原生桌面控制台。",
      )}
    >
      <View class="items-center gap-5 rounded-xl border border-border bg-card px-6 py-10">
        <Pip size={88} />
        <View class="items-center gap-1">
          <Text class="text-xl font-semibold tracking-tight text-foreground">pipi</Text>
          <Text class="text-sm text-muted-foreground">{tr(`Version ${pkg.version}`, `版本 ${pkg.version}`)}</Text>
        </View>
        <Text class="max-w-100 text-center text-sm text-muted-foreground">
          {tr(
            "This is pipi, a little ghost. pipi thinks when the agent thinks, bobs and wags while it works, and jumps when a run ends well. Pick its coat in General — cats and dogs.",
            "这是 pipi，一只小幽灵。智能体思考时它思考，工作时它飘动摇尾，运行圆满结束时它会欢快跃起。可在“常规”里给它换毛色——猫狗都有。",
          )}
        </Text>
      </View>
      <SettingGroup>
        <SettingRow title={tr("Active engine", "当前引擎")}>
          <Value text={`${activeAgent().name} · ${processStatus()}`} />
        </SettingRow>
        <Rule />
        <SettingRow title={tr("Data directory", "数据目录")}>
          <PathValue path={backend().dataDir()} />
        </SettingRow>
      </SettingGroup>
    </Page>
  );
}

/** The section nav inside the settings panel: the same sections whichever agent is active. */
function SettingsNav(props: { section: SettingsSection }) {
  return (
    <View class="w-44 shrink-0 border-r border-border">
      <View class="min-h-0 flex-1 gap-0.5 p-2">
        <Text class="px-2.5 pb-2 pt-2 text-xs font-medium text-subtle" role="header">
          {tr("Settings", "设置")}
        </Text>
        <Each of={SECTIONS}>
          {(item) => (
            <BaseButton
              testID={`settings-nav-${item().id}`}
              selected={props.section === item().id}
              onPress={() => showSettings(item().id)}
              class={`h-8 flex-row items-center gap-2 rounded-lg px-2.5 ${PRESS} ${FOCUS_RING} hover:bg-accent selected:bg-accent`}
            >
              <Icon name={item().icon} tone={props.section === item().id ? "foreground" : "muted-foreground"} />
              <Text class={`shrink truncate text-base ${props.section === item().id ? "font-medium text-foreground" : "text-muted-foreground"}`}>{item().label()}</Text>
            </BaseButton>
          )}
        </Each>
      </View>
    </View>
  );
}

/** Settings floats over the chat: an in-window layer over the backdrop every floating layer has (`SCRIM`), the window still in sight behind it; Escape or a press outside closes it. */
export function Settings() {
  const open = () => currentView().name === "settings";
  const shown = keepLast<Extract<AppView, { name: "settings" }>>(() => {
    const view = currentView();
    return view.name === "settings" ? view : undefined;
  });
  const section = (): SettingsSection => shown()?.section ?? "general";
  const focusedAgent = () => (section() === "agents" ? shown()?.agent : undefined);
  /** The agent whose own page is open inside Agents; one without a page unfolds in the list instead. */
  const pagedAgent = () => {
    const id = focusedAgent();
    const agent = id ? availableAgents().find((a) => a.id === id) : undefined;
    return agent && managesProviders(agent) ? agent : undefined;
  };

  const mounted = signal(untracked(open));
  const scrimOpacity = createAnimatedValue(untracked(open) ? 1 : 0);
  const panelOpacity = createAnimatedValue(untracked(open) ? 1 : 0);
  const panelScale = createAnimatedValue(untracked(open) ? 1 : 0.97);
  const panelY = createAnimatedValue(untracked(open) ? 0 : 10);
  let wasOpen = untracked(open);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const isOpen = open();
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(exitTimer);
      void scrimOpacity.stop();
      void panelOpacity.stop();
      void panelScale.stop();
      void panelY.stop();
      if (isOpen) {
        mounted.set(true);
        if (reduced) {
          scrimOpacity.set(1);
          panelOpacity.set(1);
          panelScale.set(1);
          panelY.set(0);
        } else {
          scrimOpacity.set(0);
          panelOpacity.set(0);
          panelScale.set(0.97);
          panelY.set(10);
          void scrimOpacity.timing(1, { duration: 180, easing: EASING.out });
          void panelOpacity.timing(1, { duration: 200, easing: EASING.smoothOut });
          void panelScale.spring(1, SPRING.snappy);
          void panelY.spring(0, SPRING.snappy);
        }
      } else if (mounted()) {
        if (reduced) {
          scrimOpacity.set(0);
          panelOpacity.set(0);
          mounted.set(false);
        } else {
          void scrimOpacity.timing(0, { duration: 150, easing: EASING.out });
          void panelOpacity.timing(0, { duration: 150, easing: EASING.out });
          void panelScale.timing(0.98, { duration: 150, easing: EASING.out });
          void panelY.timing(6, { duration: 150, easing: EASING.out });
          exitTimer = setTimeout(() => mounted.set(false), 155);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    void scrimOpacity.stop();
    void panelOpacity.stop();
    void panelScale.stop();
    void panelY.stop();
  });

  return (
    <If when={mounted()}>
      <View class={`absolute inset-0 z-40 items-center justify-center p-6${open() ? "" : " pointer-events-none"}`}>
        <View class={`absolute inset-0 ${SCRIM}`} style={{ opacity: scrimOpacity }} />
        <BaseButton onPress={showChat} accessibilityLabel={tr("Close settings", "关闭设置")} class="absolute inset-0" />
        <View
          class={`h-full max-h-160 w-full max-w-220 min-h-0 flex-row overflow-hidden ${POPUP}`}
          style={{ ...GLASS_REGULAR, opacity: panelOpacity, transform: [{ translateY: panelY }, { scale: panelScale }] }}
        >
          <SettingsNav section={section()} />
          <View class="min-h-0 min-w-0 flex-1">
            <If when={section() === "general"}>
              <General />
            </If>
            <If when={section() === "agents" && !pagedAgent()}>
              <AgentsPage focus={focusedAgent()} />
            </If>
            <If when={pagedAgent()}>{(agent) => <AgentProvidersPage agent={agent()} />}</If>
            <If when={section() === "sessions"}>
              <SessionsPage />
            </If>
            <If when={section() === "archive"}>
              <ArchivePage />
            </If>
            <If when={section() === "usage"}>
              <Usage />
            </If>
            <If when={section() === "about"}>
              <About />
            </If>
          </View>
        </View>
      </View>
    </If>
  );
}
