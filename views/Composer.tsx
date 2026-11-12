import { readFile } from "fs/promises";
import { cleanup, Clipboard, computed, createAnimatedValue, effect, Image, keymap, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { InputRef, PasteEvent } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { commandSourceLabel, tr } from "../lib/i18n";
import type { SlashCommand } from "../pi/protocol";
import {
  activeAgent,
  addAttachment,
  composerAttachments,
  composerDraft,
  composerFocusTick,
  extensionStatuses,
  extensionWidgets,
  hasModel,
  inspectingTask,
  isBashRunning,
  isRunning,
  messageQueue,
  recallQueue,
  removeAttachment,
  send,
  sessionState,
  setDraft,
  sidecarPhase,
  slashCommands,
  stop,
  toast,
  trackAttachmentRead,
} from "../store/app";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { animateLayoutOn, EASING, enter, keepLast, Reveal, SPRING } from "../ui/motion";
import { COMPOSER_SURFACE, FOCUS_RING, GLASS_REGULAR, POPUP, PRESS } from "../ui/styles";
import { tip } from "../ui/Tip";
import { AgentPicker, PermissionPicker, SubagentStrip } from "./AgentPicker";
import { ExtensionPrompt } from "./ExtensionDialog";
import { ModelPicker, ThinkingPicker } from "./ModelPicker";

const MIN_HEIGHT = 32;
const MAX_HEIGHT = 220;

/** The image types Pi's providers take; past its bound a paste stays a path instead. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const IMAGE_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** What the bytes say they are: a pasted File's `type` and a copied file's name can both lie. */
const sniffImageType = (bytes: Uint8Array): string | undefined => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return undefined;
};

/** A local file copied in a file manager arrives as a `file:` URL, not pasted bytes. */
const fileUriPath = (uri: string): string | undefined => {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return decodeURIComponent(uri.slice("file://".length).replace(/^localhost/, ""));
  } catch {
    return undefined;
  }
};

/** The slash commands that match what is being typed: `/` and a name, before any space. */
function useSlashMenu() {
  const selected = signal(0);
  const matches = computed<SlashCommand[]>(() => {
    const text = composerDraft();
    if (!text.startsWith("/") || /\s/.test(text)) return [];
    const query = text.slice(1).toLowerCase();
    const all = slashCommands();
    const starts = all.filter((command) => command.name.toLowerCase().startsWith(query));
    const holds = all.filter((command) => !command.name.toLowerCase().startsWith(query) && command.name.toLowerCase().includes(query));
    return [...starts, ...holds].slice(0, 8);
  });
  const open = () => matches().length > 0;
  const accept = (command = matches()[Math.min(selected(), matches().length - 1)]) => {
    if (command) setDraft(`/${command.name} `);
  };
  effect(() => {
    matches();
    selected.set(0);
  });
  // The arrow keys belong to the menu only while it shows.
  effect(() => {
    if (!open()) return;
    const move = (by: number) => selected.update((at) => (at + by + matches().length) % matches().length);
    cleanup(keymap.bind({ up: () => move(-1), down: () => move(1), tab: () => accept() }, { when: "always", repeat: true }));
  });
  return { matches, selected, open, accept };
}

function SlashMenu(props: { menu: ReturnType<typeof useSlashMenu> }) {
  const mounted = signal(false);
  const opacity = createAnimatedValue(0);
  const translateY = createAnimatedValue(6);
  const scale = createAnimatedValue(0.97);
  const shownMatches = keepLast(() => {
    const list = props.menu.matches();
    return list.length > 0 ? list : undefined;
  }, [] as SlashCommand[]);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  effect(() => {
    const open = props.menu.open();
    const reduced = reduceMotion();
    untracked(() => {
      clearTimeout(exitTimer);
      void opacity.stop();
      void translateY.stop();
      void scale.stop();
      if (open) {
        mounted.set(true);
        if (reduced) {
          opacity.set(1);
          translateY.set(0);
          scale.set(1);
        } else {
          opacity.set(0);
          translateY.set(6);
          scale.set(0.97);
          void opacity.timing(1, { duration: 160, easing: EASING.smoothOut });
          void translateY.spring(0, SPRING.snappy);
          void scale.spring(1, SPRING.snappy);
        }
      } else if (mounted()) {
        if (reduced) {
          opacity.set(0);
          mounted.set(false);
        } else {
          void opacity.timing(0, { duration: 130, easing: EASING.out });
          void translateY.timing(4, { duration: 130, easing: EASING.out });
          void scale.timing(0.98, { duration: 130, easing: EASING.out });
          exitTimer = setTimeout(() => mounted.set(false), 135);
        }
      }
    });
  });

  cleanup(() => {
    clearTimeout(exitTimer);
    void opacity.stop();
    void translateY.stop();
    void scale.stop();
  });

  return (
    <If when={mounted()}>
      <View
        class={`absolute inset-x-0 bottom-full mb-2 p-1 ${POPUP}${props.menu.open() ? "" : " pointer-events-none"}`}
        style={{ ...GLASS_REGULAR, opacity, transform: [{ translateY }, { scale }] }}
        role="menu"
        accessibilityLabel={tr("Commands", "命令")}
      >
        <Each of={shownMatches() ?? []} key={(command) => command.name}>
          {(command, index) => (
            <View
              role="menuitem"
              focusable={false}
              onPress={() => props.menu.accept(command())}
              class={`h-8 flex-row items-center gap-2 rounded-md px-2 ${PRESS} hover:bg-accent`}
              classList={{ "bg-accent": index() === props.menu.selected() }}
            >
              <Text class="shrink-0 font-mono text-sm text-foreground">{`/${command().name}`}</Text>
              <Text class="min-w-0 flex-1 truncate text-sm text-muted-foreground">{command().description ?? ""}</Text>
              <Text class="shrink-0 text-xs text-subtle">{commandSourceLabel(command().source)}</Text>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

/** The messages waiting for the run: an icon says what each will do. */
function Queue() {
  const waiting = computed(() => [
    ...messageQueue().steering.map((text) => ({ text, kind: "steer" as const })),
    ...messageQueue().followUp.map((text) => ({ text, kind: "followUp" as const })),
  ]);
  const shown = keepLast(() => {
    const list = waiting();
    return list.length > 0 ? list : undefined;
  }, [] as { text: string; kind: "steer" | "followUp" }[]);
  return (
    <Reveal open={waiting().length > 0}>
      <View class="gap-1 border-b border-border px-2.5 py-2">
        <Each of={shown() ?? []} key="index">
          {(item, index) => (
            <View
              class="h-6 flex-row items-center gap-2 px-1.5"
              accessibilityLabel={item().kind === "steer" ? tr("Steering", "引导") : tr("Follow-up", "追问")}
              tooltip={tip(item().kind === "steer" ? tr("Steering", "引导") : tr("Follow-up", "追问"))}
            >
              <Icon name={item().kind === "steer" ? "steer" : "queue"} size={14} tone="subtle" />
              <Text class="flex-1 truncate text-sm text-muted-foreground">{item().text}</Text>
              <If when={index() === 0}>
                <IconButton icon="pencil" size="sm" label={tr("Edit queued messages", "编辑排队消息")} onPress={() => void recallQueue()} />
              </If>
            </View>
          )}
        </Each>
      </View>
    </Reveal>
  );
}

/**
 * Pasted images wait in a tray that rises from behind the composer's top edge:
 * a little narrower than the composer, its lower edge
 * tucked under it, so adding one never changes the input's own size. The
 * thumbnail is the card; its remove button shows on hover or focus.
 */
function AttachmentTray() {
  const shown = keepLast(() => {
    const list = composerAttachments();
    return list.length > 0 ? list : undefined;
  }, composerAttachments());
  return (
    <Reveal open={composerAttachments().length > 0} offset={6}>
      <View
        class="relative mx-4 -mb-2 overflow-hidden rounded-t-2xl border-[0.5px] border-b-0 border-hairline bg-card/85 pb-2 dark:bg-card/75"
        accessibilityLabel={tr("Attachments", "附件")}
      >
        <Scroll horizontal contentClass="flex-row gap-2 p-2">
          <Each of={shown() ?? []} key="index">
            {(image, index) => (
              <View class="group relative size-14 shrink-0 overflow-hidden rounded-lg bg-muted" style={enter("zoomIn")}>
                <Image
                  src={`data:${image().mimeType};base64,${image().data}`}
                  class="size-full"
                  style={{ objectFit: "cover" }}
                  accessibilityLabel={image().name}
                />
                {/* The edge is drawn over the pixels, so a white screenshot still has one. */}
                <View class="pointer-events-none absolute inset-0 rounded-lg border-[0.5px] border-hairline-hover" />
                <BaseButton
                  onPress={() => removeAttachment(index())}
                  accessibilityLabel={tr("Remove image", "移除图片")}
                  tooltip={tip(tr("Remove image", "移除图片"))}
                  class={`absolute right-1 top-1 size-5 items-center justify-center rounded-full border-[0.5px] border-hairline-hover bg-popover shadow-sm opacity-0 ${PRESS} ${FOCUS_RING} hover:bg-secondary group-hover:opacity-100 focus:opacity-100`}
                >
                  <Icon name="x" size={12} tone="foreground" />
                </BaseButton>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
    </Reveal>
  );
}

/** Lines an extension shows beside the editor (`setWidget`), and its statuses (`setStatus`). */
function ExtensionLines(props: { below: boolean }) {
  const lines = computed(() =>
    Object.values(extensionWidgets())
      .filter((widget) => widget.below === props.below)
      .flatMap((widget) => widget.lines),
  );
  const shown = keepLast(() => {
    const list = lines();
    return list.length > 0 ? list : undefined;
  }, [] as string[]);
  return (
    <Reveal open={lines().length > 0}>
      <View class="px-3 py-1">
        <Each of={shown() ?? []} key="index">
          {(line) => <Text class="font-mono text-xs text-muted-foreground">{line()}</Text>}
        </Each>
      </View>
    </Reveal>
  );
}

/** Where the user writes to Pi: the message, the model that answers, and send or stop. */
export function Composer() {
  let input: InputRef | undefined;
  let selection = { start: 0, end: 0 };
  let trackedDraft = untracked(composerDraft);
  const height = signal(MIN_HEIGHT);
  const slash = useSlashMenu();
  const ready = () => sidecarPhase().name === "ready";
  const working = () => isRunning() || isBashRunning() || inspectingTask()?.status === "running";
  const hasText = () => composerDraft().trim().length > 0 || composerAttachments().length > 0;
  const statusLine = () => Object.values(extensionStatuses()).join("  ·  ");
  const shownStatus = keepLast(() => statusLine() || undefined, "");
  const showStop = () => working() && !hasText();
  const actionScale = createAnimatedValue(1);
  const actionOpacity = createAnimatedValue(1);
  let lastShowStop = untracked(showStop);

  animateLayoutOn(() => height(), 180, () => !working());

  effect(() => {
    const stopNow = showStop();
    if (stopNow === lastShowStop) return;
    lastShowStop = stopNow;
    untracked(() => {
      void actionScale.stop();
      void actionOpacity.stop();
      if (reduceMotion()) {
        actionScale.set(1);
        actionOpacity.set(1);
        return;
      }
      actionScale.set(0.84);
      actionOpacity.set(0.55);
      void actionScale.spring(1, SPRING.snappy);
      void actionOpacity.timing(1, { duration: 140, easing: EASING.out });
    });
  });
  cleanup(() => {
    void actionScale.stop();
    void actionOpacity.stop();
  });

  effect(() => {
    const draft = composerDraft();
    if (draft !== trackedDraft) {
      trackedDraft = draft;
      selection = { start: draft.length, end: draft.length };
    }
  });

  effect(() => {
    composerFocusTick();
    input?.focus();
  });

  const submit = (mode: "steer" | "followUp" = "steer") => {
    if (slash.open()) return slash.accept();
    void send(mode);
  };
  keymap.bind("mod+enter", () => submit("followUp"), { when: "always" });

  /**
   * A paste is attachments first, text second (`pasteBehavior="report"`):
   * - `files` carry bytes (a screenshot, an image copied in an app) — they attach.
   * - `uris` are local files copied in a file manager — images attach; anything
   *   else goes in as its path, a reference the agent reads with its own tools.
   * - An image the paste could not hand over as usable bytes — a TIFF only (QQ,
   *   Preview), or a file in another app's sandbox container that macOS will
   *   not let us read (QQ's `Library/Containers/com.tencent.qq/…/tmp`) — is
   *   read once more off the clipboard as an image (`Clipboard.readImage`,
   *   which the platform encodes as PNG) instead of falling back to its path.
   * - `text` splices into the controlled draft at `selection` (`insertText` is
   *   not implemented on the macOS host yet), minus any file-copy path echo.
   */
  const paste = ({ text, files = [], uris = [] }: PasteEvent) => {
    const pending = (async () => {
      const vision = !!sessionState()?.model?.input?.includes("image");
      let rejected = false;
      let oversized = false;
      let attached = 0;
      const references: string[] = [];
      /** Image files the paste named but whose bytes we could not use. */
      const unreadImages: string[] = [];
      let unusableImage = false;
      const attach = (name: string, declared: string, bytes: Uint8Array, path?: string) => {
        const mimeType = sniffImageType(bytes) ?? (IMAGE_TYPES.has(declared) ? (declared === "image/jpg" ? "image/jpeg" : declared) : undefined);
        if (!mimeType || !vision || bytes.length > MAX_IMAGE_BYTES) {
          if (mimeType) (!vision ? (rejected = true) : (oversized = true));
          else if (declared.startsWith("image/") || !!IMAGE_EXTENSIONS[name.split(".").pop()?.toLowerCase() ?? ""]) unusableImage = true;
          if (path) references.push(path);
          return;
        }
        addAttachment({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType, name });
        attached++;
      };
      for (const file of files) {
        try {
          attach(file.name || tr("Pasted image", "粘贴的图片"), file.type, new Uint8Array(await file.arrayBuffer()));
        } catch {} // A file that won't read shouldn't sink the rest of the paste.
      }
      const paths = uris.map(fileUriPath).filter((path): path is string => !!path);
      for (const path of paths) {
        const name = path.split("/").pop() ?? path;
        const declared = IMAGE_EXTENSIONS[name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
        try {
          attach(name, declared, await readFile(path), path);
        } catch {
          // A folder, a file gone between copy and paste, or one we may not read.
          (declared ? unreadImages : references).push(path);
        }
      }
      if (!attached && vision && (unusableImage || unreadImages.length)) {
        try {
          const image = await Clipboard.readImage();
          if (image) {
            const bytes = new Uint8Array(await (await fetch(image.url)).arrayBuffer());
            const name = unreadImages[0]?.split("/").pop() ?? tr("Pasted image", "粘贴的图片");
            attach(name, "", bytes);
          }
        } catch {} // Falls back to the path below.
      }
      if (!attached) references.push(...unreadImages);
      if (rejected) toast("warning", tr("This model does not take images.", "当前模型不支持图片输入。"));
      if (oversized) toast("warning", tr("Images over 20 MB can't be attached.", "超过 20 MB 的图片无法作为附件。"));
      // Copying a file makes the paste's text its own path or `file:` URL:
      // drop the text when it is only that echo, keep it verbatim otherwise.
      const echo = new Set([...uris, ...paths, ...paths.map((path) => path.split("/").pop() ?? "")]);
      const isFileEcho = !!text.trim() && text.split(/\s+/).every((word) => echo.has(word));
      const insertion = [...references, ...(isFileEcho || !text.trim() ? [] : [text])].join(" ");
      if (insertion) {
        const current = composerDraft();
        const start = Math.max(0, Math.min(selection.start, current.length));
        const end = Math.max(start, Math.min(selection.end, current.length));
        const next = `${current.slice(0, start)}${insertion}${current.slice(end)}`;
        const caret = start + insertion.length;
        trackedDraft = next;
        selection = { start: caret, end: caret };
        setDraft(next);
        input?.setSelection(caret, caret);
      }
    })();
    trackAttachmentRead(pending);
  };

  const placeholder = () => {
    const name = activeAgent().name;
    // While the agent starts (a session switch), the field keeps its usual words rather than passing through others.
    if (sidecarPhase().name === "failed") return tr(`${name} is not running`, `${name} 未运行`);
    if (ready() && !hasModel()) return tr("Connect a model provider to start", "连接模型服务商以开始使用");
    if (isRunning()) return tr(`Steer ${name}…`, `引导 ${name}…`);
    return tr(`Ask ${name}…`, `问问 ${name}…`);
  };

  return (
    <View class="px-6 pb-5 pt-3">
      <View class="pointer-events-auto relative w-full max-w-190 self-center">
        <SubagentStrip />
        <ExtensionPrompt />
        <SlashMenu menu={slash} />
        <AttachmentTray />
        <View class={`rounded-[22px] ${COMPOSER_SURFACE}`} style={GLASS_REGULAR}>
          <Queue />
          <ExtensionLines below={false} />
          <Input
            ref={input}
            multiline
            autoFocus
            value={composerDraft()}
            onChange={({ value }) => {
              const before = trackedDraft.length;
              const start = Math.max(0, Math.min(selection.start, before));
              const end = Math.max(start, Math.min(selection.end, before));
              const inserted = value.length - before + (end - start);
              const caret = Math.max(0, Math.min(value.length, start + inserted));
              trackedDraft = value;
              selection = { start: caret, end: caret };
              setDraft(value);
            }}
            onSelectionChange={({ start, end }) => {
              selection = { start, end };
            }}
            onSubmit={() => submit()}
            onPaste={paste}
            pasteBehavior="report"
            onContentSizeChange={({ size }) => height.set(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(size.height))))}
            submitBehavior="submit"
            autoCapitalize="none"
            autoCorrect={false}
            disabled={!ready()}
            placeholder={placeholder()}
            accessibilityLabel={tr("Message", "消息")}
            class="mx-4 mt-4 text-md text-foreground caret-brand placeholder:text-subtle"
            style={{ height: height() }}
          />
          <ExtensionLines below />
          <View class="flex-row items-end justify-between gap-2 pb-2 pl-2.5 pr-2 pt-2">
            <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-0.5">
              <AgentPicker />
              <ModelPicker />
              <ThinkingPicker />
              <PermissionPicker />
            </View>
            <View class="shrink-0 flex-row items-center gap-1.5" style={{ opacity: actionOpacity, transform: [{ scale: actionScale }] }}>
              <If
                when={showStop()}
                else={
                  <BaseButton
                    onPress={() => submit()}
                    disabled={!ready() || !hasText()}
                    accessibilityLabel={isRunning() ? tr("Steer", "引导") : tr("Send", "发送")}
                    tooltip={tip(
                      isRunning() ? tr("Steer — ⌘↵ queues a follow-up", "引导 — ⌘↵ 排队追问") : tr("Send — ⌘↵ queues a follow-up", "发送 — ⌘↵ 排队追问"),
                      "enter",
                      "top",
                    )}
                    class={`size-7 shrink-0 items-center justify-center rounded-full bg-primary shadow-sm ${PRESS} ${FOCUS_RING} hover:bg-primary/90 active:scale-92 motion-reduce:active:scale-100 disabled:bg-muted disabled:shadow-none`}
                  >
                    <Icon name="arrowUp" tone={ready() && hasText() ? "brand-foreground" : "subtle"} />
                  </BaseButton>
                }
              >
                <BaseButton
                  onPress={() => void stop()}
                  accessibilityLabel={tr("Stop", "停止")}
                  tooltip={tip(tr("Stop", "停止"), "escape", "top")}
                  class={`size-7 shrink-0 items-center justify-center rounded-full bg-secondary shadow-sm ${PRESS} ${FOCUS_RING} hover:bg-secondary/80 active:scale-92 motion-reduce:active:scale-100`}
                >
                  <Icon name="stop" tone="foreground" />
                </BaseButton>
              </If>
            </View>
          </View>
        </View>
      </View>
      <Reveal open={Boolean(statusLine())}>
        <Text class="w-full max-w-190 self-center truncate px-3 pt-2 text-center text-xs text-subtle">{shownStatus()}</Text>
      </Reveal>
    </View>
  );
}
