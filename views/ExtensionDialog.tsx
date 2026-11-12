import { createMotion, effect, Scroll, signal, Text, View } from "nsh";
import { Button as BaseButton, Dialog, Input } from "nsh/base";
import { clip } from "../lib/format";
import { tr } from "../lib/i18n";
import { answerDialog, cancelPendingDialog, currentView, pendingDialog, pendingDialogCount } from "../store/app";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Controls";
import { Icon, type IconName } from "../ui/Icon";
import { DIALOG_RISE, keepLast, Reveal } from "../ui/motion";
import { FIELD_SURFACE, FOCUS_RING, GLASS_REGULAR, POPUP, PRESS, SCRIM } from "../ui/styles";

const TOOL_ICONS: Record<string, IconName> = {
  bash: "terminal",
  read: "file",
  write: "filePlus",
  edit: "fileEdit",
  grep: "search",
  find: "search",
  ls: "folder",
  delegate_task: "agents",
  orchestrator_capabilities: "agents",
  task_status: "clock",
  task_cancel: "stop",
};

type ConfirmDetail =
  | { kind: "command"; command: string; note?: string }
  | { kind: "file"; path: string; preview?: string }
  | { kind: "code"; text: string }
  | { kind: "text"; text: string };

interface ConfirmPresentation {
  icon: IconName;
  heading: string;
  badge?: string;
  isPermission: boolean;
  detail?: ConfirmDetail;
}

function parseDetail(message: string): ConfirmDetail | undefined {
  const trimmed = message.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "null") return undefined;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.command === "string" && record.command.trim()) {
          const note =
            typeof record.description === "string" && record.description.trim()
              ? record.description.trim()
              : typeof record.cwd === "string" && record.cwd.trim()
                ? record.cwd.trim()
                : undefined;
          return { kind: "command", command: record.command, note };
        }
        const rawPath = typeof record.path === "string" ? record.path : typeof record.file_path === "string" ? record.file_path : undefined;
        if (rawPath && rawPath.trim()) {
          const snippet =
            typeof record.newText === "string"
              ? record.newText
              : typeof record.new_string === "string"
                ? record.new_string
                : typeof record.content === "string"
                  ? record.content
                  : undefined;
          return { kind: "file", path: rawPath.trim(), preview: snippet?.trim() ? clip(snippet, 30, 4000).text : undefined };
        }
        const entries = Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== "");
        if (entries.length === 0) return undefined;
        const allScalar = entries.length <= 4 && entries.every(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
        const formatted = allScalar ? entries.map(([k, v]) => `${k}: ${String(v)}`).join("\n") : JSON.stringify(record, null, 2);
        return { kind: "code", text: clip(formatted, 30, 4000).text };
      }
    } catch {}
  }
  return { kind: "text", text: clip(trimmed, 30, 4000).text };
}

function describeConfirm(title: string, message: string): ConfirmPresentation {
  const subMatch = title.match(/^\[([^\]]+)\]\s*(.+)$/);
  const badge = subMatch ? subMatch[1].trim() : undefined;
  const rawTitle = (subMatch ? subMatch[2] : title).trim();
  const detail = parseDetail(message);

  const allowMatch = rawTitle.match(/^Allow\s+([a-zA-Z0-9_.-]+)\?$/i);
  if (allowMatch) {
    const tool = allowMatch[1];
    const lower = tool.toLowerCase();
    const heading =
      lower === "bash"
        ? tr("Allow shell command?", "允许执行终端命令？")
        : lower === "write"
          ? tr("Allow writing file?", "允许写入文件？")
          : lower === "edit"
            ? tr("Allow editing file?", "允许修改文件？")
            : tr(`Allow ${tool}?`, `允许调用 ${tool}？`);
    return {
      icon: TOOL_ICONS[lower] ?? "shield",
      heading,
      badge,
      isPermission: true,
      detail,
    };
  }

  if (rawTitle === "Allow external agent action?") {
    return {
      icon: detail?.kind === "command" ? "terminal" : detail?.kind === "file" ? "fileEdit" : "shield",
      heading: tr("Allow external agent action?", "允许外部智能体操作？"),
      badge,
      isPermission: true,
      detail,
    };
  }

  const isPermission = /^allow\b/i.test(rawTitle);
  const icon: IconName = detail?.kind === "command" ? "terminal" : detail?.kind === "file" ? "fileEdit" : isPermission ? "shield" : "info";
  return { icon, heading: rawTitle, badge, isPermission, detail };
}

function ConfirmBody(props: { detail?: ConfirmDetail }) {
  const of = <K extends ConfirmDetail["kind"]>(kind: K) => (props.detail?.kind === kind ? (props.detail as Extract<ConfirmDetail, { kind: K }>) : undefined);
  return (
    <If when={props.detail}>
      <If when={of("command")}>
        {(d) => (
          <View selectable class="overflow-hidden rounded-lg border border-border bg-sunken">
            <Scroll class="max-h-36" contentClass="px-3 py-2">
              <If when={d().note}>
                <Text class="pb-1 text-xs text-subtle">{d().note}</Text>
              </If>
              <View class="flex-row items-start gap-1.5">
                <Text class="font-mono text-xs leading-relaxed text-brand-text">$</Text>
                <Text class="flex-1 font-mono text-xs leading-relaxed text-foreground">{d().command}</Text>
              </View>
            </Scroll>
          </View>
        )}
      </If>
      <If when={of("file")}>
        {(d) => (
          <View selectable class="overflow-hidden rounded-lg border border-border bg-sunken">
            <View class={`flex-row items-center gap-1.5 px-3 py-1.5 ${d().preview ? "border-b border-border" : ""}`}>
              <Icon name="file" size={12} tone="subtle" />
              <Text class="flex-1 truncate font-mono text-xs text-foreground">{d().path}</Text>
            </View>
            <If when={d().preview}>
              <Scroll class="max-h-32" contentClass="px-3 py-2">
                <View>
                  <Text class="font-mono text-xs leading-relaxed text-muted-foreground">{d().preview}</Text>
                </View>
              </Scroll>
            </If>
          </View>
        )}
      </If>
      <If when={of("code")}>
        {(d) => (
          <View selectable class="overflow-hidden rounded-lg border border-border bg-sunken">
            <Scroll class="max-h-36" contentClass="px-3 py-2">
              <View>
                <Text class="font-mono text-xs leading-relaxed text-muted-foreground">{d().text}</Text>
              </View>
            </Scroll>
          </View>
        )}
      </If>
      <If when={of("text")}>
        {(d) => (
          <View selectable>
            <Scroll class="max-h-32">
              <View>
                <Text class="text-sm leading-relaxed text-muted-foreground">{d().text}</Text>
              </View>
            </Scroll>
          </View>
        )}
      </If>
    </If>
  );
}

/** Whether the active extension prompt is shown inline above the composer rather than as a modal. */
export function hasInlinePrompt() {
  const dialog = pendingDialog();
  return !!dialog && currentView().name === "chat" && dialog.method !== "editor";
}

/**
 * Floating inline prompt anchored directly above the Composer so permission
 * confirmations, choices and quick inputs never obscure or blur the transcript.
 */
export function ExtensionPrompt() {
  const text = signal("");
  let lastId = "";
  effect(() => {
    const dialog = pendingDialog();
    const id = dialog?.id ?? "";
    if (id !== lastId) {
      lastId = id;
      text.set("");
    }
  });

  const shownDialog = keepLast(() => (hasInlinePrompt() ? pendingDialog() : undefined));

  const submit = () => {
    const dialog = pendingDialog();
    if (dialog) answerDialog(dialog.id, { value: text() });
  };

  const of = <M extends "select" | "confirm" | "input">(method: M) => {
    const dialog = shownDialog();
    return dialog?.method === method ? (dialog as Extract<NonNullable<typeof dialog>, { method: M }>) : undefined;
  };

  return (
    <Reveal open={hasInlinePrompt()} offset={6}>
      <If when={shownDialog()}>
        <View
          role="region"
          accessibilityLabel={tr("Confirmation prompt", "确认提示")}
          class={`mb-2.5 gap-2.5 rounded-2xl p-3.5 ${POPUP}`}
          style={GLASS_REGULAR}
        >
        <If when={of("confirm")}>
          {(dialog) => {
            const info = () => describeConfirm(dialog().title, dialog().message);
            return (
              <View class="gap-2.5">
                <View class="flex-row items-center gap-2">
                  <Icon name={info().icon} size={15} tone={info().isPermission ? "brand-text" : "muted-foreground"} />
                  <Text class="min-w-0 flex-1 truncate text-base font-semibold text-foreground" role="header">
                    {info().heading}
                  </Text>
                  <If when={info().badge}>
                    <Text class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{info().badge}</Text>
                  </If>
                  <If when={pendingDialogCount() > 1}>
                    <Text class="shrink-0 tabular-nums text-xs text-subtle">{`1 / ${pendingDialogCount()}`}</Text>
                  </If>
                  <View class="shrink-0 flex-row items-center gap-1.5 pl-1">
                    <Button
                      label={info().isPermission ? tr("Deny", "拒绝") : tr("Cancel", "取消")}
                      size="md"
                      shortcut="escape"
                      onPress={() => answerDialog(dialog().id, { confirmed: false })}
                    />
                    <Button
                      label={info().isPermission ? tr("Allow", "允许") : tr("Confirm", "确认")}
                      variant="primary"
                      size="md"
                      onPress={() => answerDialog(dialog().id, { confirmed: true })}
                    />
                  </View>
                </View>
                <ConfirmBody detail={info().detail} />
              </View>
            );
          }}
        </If>

        <If when={of("select")}>
          {(dialog) => (
            <View class="gap-2">
              <View class="flex-row items-center gap-2">
                <Icon name="info" size={15} tone="brand-text" />
                <Text class="min-w-0 flex-1 truncate text-base font-semibold text-foreground" role="header">
                  {dialog().title}
                </Text>
                <If when={pendingDialogCount() > 1}>
                  <Text class="shrink-0 tabular-nums text-xs text-subtle">{`1 / ${pendingDialogCount()}`}</Text>
                </If>
                <Button label={tr("Cancel", "取消")} size="sm" variant="ghost" shortcut="escape" onPress={cancelPendingDialog} />
              </View>
              <Scroll class="max-h-44">
                <View class="-mx-1 gap-0.5">
                  <Each of={dialog().options} key="index">
                    {(option) => (
                      <BaseButton
                        onPress={() => answerDialog(dialog().id, { value: option() })}
                        class={`min-h-8 flex-row items-center rounded-md px-2.5 py-1.5 ${PRESS} ${FOCUS_RING} hover:bg-accent focus:bg-accent active:bg-accent`}
                      >
                        <Text class="text-base text-foreground">{option()}</Text>
                      </BaseButton>
                    )}
                  </Each>
                </View>
              </Scroll>
            </View>
          )}
        </If>

        <If when={of("input")}>
          {(dialog) => (
            <View class="gap-2.5">
              <View class="flex-row items-center gap-2">
                <Icon name="pencil" size={14} tone="brand-text" />
                <Text class="min-w-0 flex-1 truncate text-base font-semibold text-foreground" role="header">
                  {dialog().title}
                </Text>
                <If when={pendingDialogCount() > 1}>
                  <Text class="shrink-0 tabular-nums text-xs text-subtle">{`1 / ${pendingDialogCount()}`}</Text>
                </If>
              </View>
              <View class="flex-row items-center gap-2">
                <TextField
                  value={text()}
                  onChange={(value) => text.set(value)}
                  onSubmit={submit}
                  placeholder={dialog().placeholder}
                  label={dialog().title}
                  autoFocus
                  class="flex-1"
                />
                <Button label={tr("Cancel", "取消")} size="lg" shortcut="escape" onPress={cancelPendingDialog} />
                <Button label={tr("Submit", "提交")} variant="primary" size="lg" onPress={submit} />
              </View>
            </View>
          )}
        </If>
        </View>
      </If>
    </Reveal>
  );
}

/**
 * Fallback modal dialog used only for multiline `editor` prompts or when an
 * extension requests input while the user is away from the Chat screen.
 */
export function ExtensionDialog() {
  const text = signal("");
  let lastId = "";
  effect(() => {
    const dialog = pendingDialog();
    const id = dialog?.id ?? "";
    if (id !== lastId) {
      lastId = id;
      text.set(dialog?.method === "editor" ? (dialog.prefill ?? "") : "");
    }
  });
  const submit = () => {
    const dialog = pendingDialog();
    if (dialog) answerDialog(dialog.id, { value: text() });
  };
  const modalOpen = () => !!pendingDialog() && !hasInlinePrompt();
  const of = <M extends "select" | "confirm" | "input" | "editor">(method: M) => {
    if (!modalOpen()) return undefined;
    const dialog = pendingDialog();
    return dialog?.method === method ? (dialog as Extract<typeof dialog, { method: M }>) : undefined;
  };
  return (
    <Dialog open={modalOpen()} animation="fade" onOpenChange={({ open }) => !open && cancelPendingDialog()} backdropClass={SCRIM} class="m-auto w-full max-w-110 px-4">
      <View class={`gap-4 p-5 ${POPUP}`} style={{ ...GLASS_REGULAR, ...createMotion({ enter: DIALOG_RISE }).style }}>
        <If when={of("confirm")}>
          {(dialog) => {
            const info = () => describeConfirm(dialog().title, dialog().message);
            return (
              <View class="gap-4">
                <View class="flex-row items-center gap-2">
                  <Icon name={info().icon} tone={info().isPermission ? "brand-text" : "muted-foreground"} />
                  <Text class="flex-1 text-lg font-semibold text-foreground" role="header">
                    {info().heading}
                  </Text>
                </View>
                <ConfirmBody detail={info().detail} />
                <View class="flex-row justify-end gap-2">
                  <Button
                    label={info().isPermission ? tr("Deny", "拒绝") : tr("Cancel", "取消")}
                    size="lg"
                    onPress={() => answerDialog(dialog().id, { confirmed: false })}
                  />
                  <Button
                    label={info().isPermission ? tr("Allow", "允许") : tr("Confirm", "确认")}
                    variant="primary"
                    size="lg"
                    onPress={() => answerDialog(dialog().id, { confirmed: true })}
                  />
                </View>
              </View>
            );
          }}
        </If>
        <If when={of("select")}>
          {(dialog) => (
            <View class="gap-3">
              <Text class="text-lg font-semibold text-foreground" role="header">
                {dialog().title}
              </Text>
              <View class="-mx-2 gap-0.5">
                <Each of={dialog().options} key="index">
                  {(option) => (
                    <BaseButton onPress={() => answerDialog(dialog().id, { value: option() })} class={`min-h-8 flex-row items-center rounded-md px-2 py-1.5 ${PRESS} hover:bg-accent focus:bg-accent active:bg-accent`}>
                      <Text class="text-base text-foreground">{option()}</Text>
                    </BaseButton>
                  )}
                </Each>
              </View>
            </View>
          )}
        </If>
        <If when={of("input")}>
          {(dialog) => (
            <View class="gap-4">
              <Text class="text-lg font-semibold text-foreground" role="header">
                {dialog().title}
              </Text>
              <TextField value={text()} onChange={(value) => text.set(value)} onSubmit={submit} placeholder={dialog().placeholder} label={dialog().title} autoFocus />
              <View class="flex-row justify-end gap-2">
                <Button label={tr("Cancel", "取消")} size="lg" onPress={cancelPendingDialog} />
                <Button label={tr("Submit", "提交")} variant="primary" size="lg" onPress={submit} />
              </View>
            </View>
          )}
        </If>
        <If when={of("editor")}>
          {(dialog) => (
            <View class="gap-4">
              <Text class="text-lg font-semibold text-foreground" role="header">
                {dialog().title}
              </Text>
              <Input
                multiline
                autoFocus
                value={text()}
                onChange={({ value }) => text.set(value)}
                accessibilityLabel={dialog().title}
                class={`h-56 rounded-lg p-2.5 font-mono text-sm text-foreground caret-brand ${FIELD_SURFACE}`}
              />
              <View class="flex-row justify-end gap-2">
                <Button label={tr("Cancel", "取消")} size="lg" onPress={cancelPendingDialog} />
                <Button label={tr("Save", "保存")} variant="primary" size="lg" onPress={submit} />
              </View>
            </View>
          )}
        </If>
      </View>
    </Dialog>
  );
}
