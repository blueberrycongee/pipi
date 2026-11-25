import {
  Animated,
  cleanup,
  type CompositeAnimation,
  createAnimatedValue,
  effect,
  type JSX,
  keymap,
  LayoutAnimation,
  platform,
  reduceMotion,
  signal,
  untracked,
  View,
} from "nsh";
import { AlertDialog } from "nsh/base";
import { Application, currentWindow, isAvailable, Menu, Window, type WindowRef } from "nsh/desktop";
import { tr } from "../lib/i18n";
import { bindWindow, titleBarArea } from "../lib/layout";
import { DYNAMIC_WALLPAPER_ENABLED } from "../lib/wallpaper";
import {
  activeDaemonSessionCount,
  canArchiveCurrentSession,
  cancelPendingDialog,
  cancelRenaming,
  chooseWorkspace,
  compactNow,
  currentView,
  exportHtml,
  focusComposer,
  isBashRunning,
  isCurrentSessionArchived,
  isCompareOpen,
  isPaletteOpen,
  isRenaming,
  isRunning,
  leaveSettings,
  pendingDialog,
  randomWallpaper,
  restartPi,
  setCompareOpen,
  setPaletteOpen,
  showChat,
  showSettings,
  stop,
  stopAllDaemonSessions,
  toggleArchiveCurrentSession,
  waitingCount,
  wallpaper,
} from "../store/app";
import {
  runInBackground,
  setRunInBackground,
  setSidebarOpen,
  setSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarOpen,
  sidebarWidth,
} from "../store/prefs";
import { flushDocs, refreshNotes, revealDoc, syncDocs } from "../store/docs";
import { activeTabId, closeTab, cycleTab, draftToDoc, newDocTab, openNewSessionTab, openTabs, pickDocTab, saveDocAs } from "../store/tabs";
import { EASING } from "../ui/motion";
import { SIDEBAR_GLASS, WALLPAPER_FROST } from "../ui/styles";
import { isZoomOpen, ZoomLayer } from "../ui/Zoom";
import { CompareDialog } from "./AgentPicker";
import { Chat } from "./Chat";
import { DocDeck, notifyDocPointerUp } from "./DocEditor";
import { ExtensionDialog, hasInlinePrompt } from "./ExtensionDialog";
import { Palette } from "./Palette";
import { Settings } from "./Settings";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { Toasts } from "./Toasts";
import { UpdateCard } from "./UpdateCard";
import {
  isWallpaperAdjustOpen,
  notifyWallpaperClick,
  notifyWallpaperPointerLeave,
  notifyWallpaperPointerMove,
  WallpaperAdjustDialog,
  WallpaperUnderlay,
} from "./Wallpaper";

/**
 * Minimum horizontal room to the right of `titleBar().left` (macOS traffic
 * lights): 14pt breathing space + 36pt draggable titlebar gap + 98pt for the
 * three top-right sidebar action buttons (`size-7` × 3 + gaps + `pr-2.5`).
 */
const SIDEBAR_HEADER_RIGHT_CLEARANCE = 148;
/** Continuing to drag left past `minWidth - SIDEBAR_COLLAPSE_PULL` folds the sidebar automatically (SaaS split-pane behavior). */
const SIDEBAR_COLLAPSE_PULL = 56;
/** Hysteresis when dragging back right within the same continuous gesture to re-open. */
const SIDEBAR_REOPEN_PULL = 18;
/** Deliberate hover pause before showing the subtle resize hairline, so crossing the border never flashes. */
const SASH_HOVER_DELAY_MS = 140;

/**
 * The sidebar is frosted glass — a backdrop blur under a theme tint — and
 * over a wallpaper that is the picture laid under the whole window, running
 * on under the sidebar from the pane beside it: light enough a blur that its
 * shapes survive, under a tint heavy enough that rows stay legible on any
 * picture (a bright one in dark, a dark one in light). Linux draws no backdrop
 * filter: there the sidebar keeps its solid fill.
 */
const sidebarSurface = () => (!WALLPAPER_FROST ? "bg-sidebar" : wallpaper() ? "bg-sidebar/50" : "bg-sidebar");

const effectiveSidebarMinWidth = () =>
  Math.max(SIDEBAR_MIN_WIDTH, Math.ceil((titleBarArea().left || 0) + SIDEBAR_HEADER_RIGHT_CLEARANCE));

const toggleSidebar = () => setSidebarOpen(!sidebarOpen());
const toggleSettings = () => (currentView().name === "settings" ? leaveSettings() : showSettings());

/** Escape leaves what is on top: a dialog or inline prompt closes itself; then settings or sub-agent inspection; then the run stops. */
function escape() {
  if (isPaletteOpen() || isCompareOpen() || isZoomOpen() || isWallpaperAdjustOpen()) return;
  if (pendingDialog()) {
    if (hasInlinePrompt()) cancelPendingDialog();
    return;
  }
  if (isRenaming()) return cancelRenaming();
  if (currentView().name === "settings") return leaveSettings();
  if (currentView().name === "chat" && (isRunning() || isBashRunning() || waitingCount() > 0)) void stop();
}

let mainWindow: WindowRef | null = null;
let exitPrompting = false;

const activeMainWindow = () => mainWindow ?? (isAvailable ? Window.get("main") : null);

function showMainWindow() {
  const win = activeMainWindow();
  if (!win) return;
  win.show();
  win.focus();
}

function ensureMainWindowVisible() {
  const win = activeMainWindow();
  if (win && win.state()?.visible === false) {
    win.show();
    win.focus();
  }
}

async function flushDocsSafely() {
  await flushDocs().catch(() => undefined);
}

/**
 * Closing the main window:
 * - On macOS, a single-window app hides its window instead of tearing down its
 *   content tree, so Dock/Finder `reopen` restores the live UI state instantly
 *   while active sessions continue uninterrupted.
 * - On Windows and Linux, closing the last window exits the app, so we run the
 *   same running-session confirmation as Quit before closing.
 */
async function handleWindowClose() {
  if (platform.os === "macos") {
    await flushDocsSafely();
    activeMainWindow()?.hide();
    return;
  }
  await confirmExit("close");
}

async function confirmExit(how: "quit" | "close") {
  if (exitPrompting) {
    showMainWindow();
    return;
  }
  const count = activeDaemonSessionCount();
  if (runInBackground() || count === 0) {
    await flushDocsSafely();
    if (how === "quit") Application.quit();
    else activeMainWindow()?.close();
    return;
  }
  exitPrompting = true;
  let approved = false;
  try {
    // Ensure the confirmation dialog is visible if Quit was triggered from the
    // Dock or menu bar while the main window was hidden or minimized.
    ensureMainWindowVisible();
    const { action } = await AlertDialog.show({
      title:
        count === 1
          ? tr("1 session is still running.", "仍有 1 个会话正在运行。")
          : tr(`${count} sessions are still running.`, `仍有 ${count} 个会话正在运行。`),
      description: tr(
        "Keep them running in the background so you can come back later, or stop them now.",
        "让它们在后台继续运行以便稍后回来查看，或立即全部停止。",
      ),
      actions: [
        { label: tr("Cancel", "取消"), role: "cancel", id: "cancel" },
        { label: tr("Stop All & Quit", "停止并退出"), role: "destructive", id: "stop" },
        { label: tr("Keep Running in Background", "保留后台运行"), id: "background" },
      ],
    });
    if (action === "background") {
      setRunInBackground(true);
    } else if (action === "stop") {
      await stopAllDaemonSessions();
    } else {
      return;
    }
    approved = true;
    await flushDocsSafely();
    if (how === "quit") Application.quit();
    else activeMainWindow()?.close();
  } finally {
    exitPrompting = false;
    if (how === "quit" && !approved) Application.cancelQuitRequest();
  }
}

/** ⌘W's target: the front tab while there are several, the window when the strip holds only one. */
function closeTabOrWindow() {
  const win = activeMainWindow();
  if (win && win.state()?.visible === false) return;
  const id = activeTabId();
  if (id && openTabs().length > 1) void closeTab(id);
  else void handleWindowClose();
}

/** The application menu: every command has a place in it, and its shortcut lives here. */
function applicationMenu() {
  const severalTabs = openTabs().length > 1 && activeTabId() !== undefined;
  Menu.setApplicationMenu([
    {
      label: "pipi",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: tr("Settings…", "设置…"),
          shortcut: "mod+,",
          onSelect: () => {
            ensureMainWindowVisible();
            toggleSettings();
          },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: tr("File", "文件"),
      submenu: [
        {
          label: tr("New Tab", "新建标签页"),
          shortcut: "mod+t",
          onSelect: () => {
            ensureMainWindowVisible();
            void openNewSessionTab({ newTab: true });
          },
        },
        {
          label: tr("New Session", "新建会话"),
          shortcut: "mod+n",
          onSelect: () => {
            ensureMainWindowVisible();
            void openNewSessionTab({ newTab: false });
          },
        },
        {
          label: tr("New Document", "新建文档"),
          shortcut: "mod+shift+n",
          onSelect: () => {
            ensureMainWindowVisible();
            void newDocTab();
          },
        },
        {
          label: tr("Continue Draft in a Document", "在文档中继续写"),
          shortcut: "mod+e",
          disabled: currentView().name !== "chat",
          onSelect: () => {
            ensureMainWindowVisible();
            void draftToDoc();
          },
        },
        {
          label: tr("Open Markdown File…", "打开 Markdown 文件…"),
          onSelect: () => {
            ensureMainWindowVisible();
            void pickDocTab();
          },
        },
        {
          label: tr("Save Document As…", "文档另存为…"),
          disabled: currentView().name !== "doc",
          onSelect: () => {
            const v = currentView();
            if (v.name === "doc") void saveDocAs(v.docId);
          },
        },
        {
          label: platform.os === "macos" ? tr("Show Document in Finder", "在访达中显示文档") : tr("Show Document in File Manager", "在文件管理器中显示文档"),
          disabled: currentView().name !== "doc",
          onSelect: () => {
            const v = currentView();
            if (v.name === "doc") void revealDoc(v.docId);
          },
        },
        {
          label: tr("Add Project Folder…", "添加项目文件夹…"),
          shortcut: "mod+o",
          onSelect: () => {
            ensureMainWindowVisible();
            void chooseWorkspace();
          },
        },
        { type: "separator" },
        { label: tr("Export as HTML", "导出为 HTML"), onSelect: () => void exportHtml() },
        { type: "separator" },
        severalTabs
          ? { label: tr("Close Tab", "关闭标签页"), shortcut: "mod+w", onSelect: () => void closeTabOrWindow() }
          : { role: "close" },
      ],
    },
    {
      label: tr("Edit", "编辑"),
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    {
      label: tr("View", "视图"),
      submenu: [
        {
          label: tr("Command Palette…", "命令面板…"),
          shortcut: "mod+k",
          onSelect: () => {
            ensureMainWindowVisible();
            setPaletteOpen(!isPaletteOpen());
          },
        },
        { label: sidebarOpen() ? tr("Hide Sidebar", "隐藏侧边栏") : tr("Show Sidebar", "显示侧边栏"), shortcut: "mod+b", onSelect: toggleSidebar },
        { label: tr("Random Wallpaper", "随机壁纸"), shortcut: "mod+u", onSelect: () => void randomWallpaper() },
        { type: "separator" },
        { label: tr("Next Tab", "下一个标签页"), shortcut: "mod+shift+]", disabled: openTabs().length < 2, onSelect: () => cycleTab(1) },
        { label: tr("Previous Tab", "上一个标签页"), shortcut: "mod+shift+[", disabled: openTabs().length < 2, onSelect: () => cycleTab(-1) },
        { type: "separator" },
        { role: "toggleFullScreen" },
      ],
    },
    {
      label: tr("Session", "会话"),
      submenu: [
        {
          label: tr("Focus Message", "聚焦输入框"),
          shortcut: "mod+l",
          onSelect: () => {
            ensureMainWindowVisible();
            showChat();
            focusComposer();
          },
        },
        {
          label: tr("Compare Agents…", "智能体并行对比…"),
          shortcut: "mod+shift+o",
          onSelect: () => {
            ensureMainWindowVisible();
            setCompareOpen(!isCompareOpen());
          },
        },
        { label: tr("Stop", "停止"), shortcut: "mod+.", disabled: !isRunning() && !isBashRunning() && waitingCount() === 0, onSelect: () => void stop() },
        { type: "separator" },
        {
          label: isCurrentSessionArchived() ? tr("Unarchive Session", "取消归档会话") : tr("Archive Session", "归档会话"),
          disabled: !canArchiveCurrentSession(),
          onSelect: () => void toggleArchiveCurrentSession(),
        },
        { label: tr("Compact Context", "压缩上下文"), onSelect: () => void compactNow() },
        { label: tr("Restart Agent", "重启智能体"), onSelect: () => void restartPi() },
      ],
    },
    {
      label: tr("Window", "窗口"),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(platform.os === "macos"
          ? [{ type: "separator" as const }, { label: "pipi", onSelect: showMainWindow }]
          : []),
      ],
    },
  ]);
}

/**
 * SaaS-style split shell with:
 * - Traffic-light & header-action safe minimum width (`effectiveSidebarMinWidth`),
 * - Elastic clamp at minimum width + automatic collapse when dragging past it,
 * - Layered fixed-width drawer reveal with zero vertical hover-line artifacts.
 */
function SidebarSplit(props: { children: JSX.Element }) {
  const initialOpen = untracked(sidebarOpen);
  const liveWidth = signal<number | null>(null);
  const dragging = signal(false);
  const sashHover = signal(false);
  const transitioning = signal(false);
  const sidebarMounted = signal(initialOpen);

  const drawerOpacity = createAnimatedValue(initialOpen ? 1 : 0);
  const drawerSlideX = createAnimatedValue(0);
  const panX = createAnimatedValue(0);

  let drawerAnim: CompositeAnimation | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHoverTimer = () => {
    if (hoverTimer !== undefined) {
      clearTimeout(hoverTimer);
      hoverTimer = undefined;
    }
  };
  const clearSettleTimer = () => {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  };

  cleanup(() => {
    clearHoverTimer();
    clearSettleTimer();
    drawerAnim?.stop();
  });

  const minW = effectiveSidebarMinWidth;
  const clampedStoredWidth = () => Math.min(SIDEBAR_MAX_WIDTH, Math.max(minW(), sidebarWidth()));
  const currentWidth = () => {
    const live = liveWidth();
    return live !== null ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(minW(), live)) : clampedStoredWidth();
  };

  // Coordinated expand / collapse choreography: unmounts the resize sash for
  // the entire transition so no hover indicator line ever slides under the pointer.
  let initialized = false;
  let prevOpen = initialOpen;
  effect(() => {
    const open = sidebarOpen();
    const reduced = reduceMotion();
    untracked(() => {
      if (!initialized) {
        initialized = true;
        prevOpen = open;
        return;
      }
      if (open === prevOpen) return;
      prevOpen = open;

      clearHoverTimer();
      sashHover.set(false);
      clearSettleTimer();
      drawerAnim?.stop();
      drawerAnim = null;

      if (reduced) {
        transitioning.set(false);
        sidebarMounted.set(open);
        drawerOpacity.set(open ? 1 : 0);
        drawerSlideX.set(0);
        return;
      }

      transitioning.set(true);
      if (open) {
        sidebarMounted.set(true);
        if (!isRunning()) {
          LayoutAnimation.configureNext({
            duration: 260,
            update: { type: "spring", springDamping: 0.96 },
            create: { type: "easeOut", property: "opacity", duration: 180 },
            delete: { type: "easeIn", property: "opacity", duration: 140 },
          });
        }
        drawerOpacity.set(0.38);
        drawerSlideX.set(-16);
        drawerAnim = Animated.parallel([
          Animated.timing(drawerOpacity, { toValue: 1, duration: 220, easing: EASING.signature }),
          Animated.spring(drawerSlideX, { toValue: 0, stiffness: 340, damping: 34, mass: 1 }),
        ]);
        void drawerAnim.start();
        settleTimer = setTimeout(() => {
          settleTimer = undefined;
          transitioning.set(false);
        }, 275);
      } else {
        if (!isRunning()) {
          LayoutAnimation.configureNext({
            duration: 200,
            update: { type: "spring", springDamping: 0.98 },
            create: { type: "easeOut", property: "opacity", duration: 150 },
            delete: { type: "easeIn", property: "opacity", duration: 120 },
          });
        }
        drawerAnim = Animated.parallel([
          Animated.timing(drawerOpacity, { toValue: 0, duration: 165, easing: EASING.exit }),
          Animated.timing(drawerSlideX, { toValue: -12, duration: 185, easing: EASING.exit }),
        ]);
        void drawerAnim.start();
        settleTimer = setTimeout(() => {
          settleTimer = undefined;
          transitioning.set(false);
          if (!untracked(sidebarOpen)) sidebarMounted.set(false);
        }, 205);
      }
    });
  });

  // Drag-to-resize & SaaS drag-past-min-to-collapse state
  let startPageX = 0;
  let startWidth = SIDEBAR_DEFAULT_WIDTH;
  let preDragWidth = SIDEBAR_DEFAULT_WIDTH;
  let lastDeltaX = 0;
  let collapsedInDrag = false;
  // Once the pan recognizer takes the gesture it cancels the press, which the
  // runtime reports as an `onPressUp` (with a zeroed position on some
  // backends): the drag's release is `onPanEnd` from then on.
  let panActive = false;

  const updateDrag = (deltaX: number) => {
    if (!untracked(dragging)) return;
    lastDeltaX = deltaX;
    const floor = minW();
    const raw = startWidth + deltaX;

    if (!collapsedInDrag) {
      if (raw <= floor - SIDEBAR_COLLAPSE_PULL) {
        collapsedInDrag = true;
        liveWidth.set(floor);
        setSidebarOpen(false);
        return;
      }
      liveWidth.set(Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(floor, raw))));
    } else if (raw >= floor - SIDEBAR_REOPEN_PULL) {
      collapsedInDrag = false;
      liveWidth.set(Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(floor, raw))));
      setSidebarOpen(true);
    }
  };

  const finishDrag = (deltaX: number, velocityX: number) => {
    if (!untracked(dragging)) return;
    dragging.set(false);
    panActive = false;
    clearHoverTimer();
    sashHover.set(false);

    const floor = minW();
    const raw = startWidth + deltaX;
    liveWidth.set(null);
    panX.set(0);

    if (collapsedInDrag) {
      setSidebarWidth(preDragWidth);
      return;
    }
    if (raw < floor + 10 && velocityX < -420) {
      setSidebarWidth(preDragWidth);
      setSidebarOpen(false);
      return;
    }
    setSidebarWidth(Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(floor, raw))));
  };

  const resetToDefaultWidth = () => {
    const target = Math.max(minW(), SIDEBAR_DEFAULT_WIDTH);
    if (!reduceMotion() && !isRunning()) {
      LayoutAnimation.configureNext({
        duration: 220,
        update: { type: "spring", springDamping: 0.96 },
      });
    }
    setSidebarWidth(target);
  };

  return (
    <View class={`relative flex-1 flex-row ${wallpaper() ? "bg-background" : "bg-sidebar"}`}>
      <WallpaperUnderlay />
      <View
        class="shrink-0 overflow-hidden"
        style={{ width: sidebarOpen() ? currentWidth() : 0 }}
      >
        <View
          class={`h-full ${wallpaper() ? "border-r border-sidebar-border" : ""} ${sidebarSurface()}`}
          style={{
            width: currentWidth(),
            opacity: drawerOpacity,
            transform: [{ translateX: drawerSlideX }],
            ...(WALLPAPER_FROST && wallpaper() ? SIDEBAR_GLASS : undefined),
          }}
        >
          <If when={sidebarMounted()}>
            <Sidebar />
          </If>
        </View>
      </View>

      {/* Without a wallpaper the main pane sits as a floating paper sheet inside the
          sidebar tray; over a wallpaper the surface runs continuously edge-to-edge. */}
      <View class={`relative min-w-0 flex-1 ${wallpaper() ? "" : sidebarOpen() ? "py-[7px] pr-[7px]" : "p-[7px]"}`}>
        <View
          class={`relative min-w-0 flex-1 ${
            wallpaper()
              ? ""
              : "overflow-hidden rounded-[14px] corner-squircle border-[0.5px] border-hairline bg-background shadow-sheet dark:shadow-sheet-dark"
          }`}
        >
          {props.children}
        </View>
      </View>

      <If when={(sidebarOpen() && !transitioning()) || dragging()}>
        <View
          role="adjustable"
          focusable={false}
          desktop={{ windowDrag: false }}
          accessibilityLabel={tr("Sidebar width", "侧边栏宽度")}
          accessibilityValue={{ min: minW(), max: SIDEBAR_MAX_WIDTH, now: currentWidth() }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={({ actionName }) => {
            const floor = minW();
            if (actionName === "increment") {
              setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, currentWidth() + 24));
            } else if (actionName === "decrement") {
              const next = currentWidth() - 24;
              if (next < floor) setSidebarOpen(false);
              else setSidebarWidth(next);
            }
          }}
          style={
            dragging()
              ? { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 40, cursor: "col-resize" }
              : { position: "absolute", top: 0, bottom: 0, left: currentWidth() - 5, width: 9, zIndex: 30, cursor: "col-resize" }
          }
          onMouseEnter={() => {
            if (dragging() || transitioning()) return;
            clearHoverTimer();
            hoverTimer = setTimeout(() => {
              hoverTimer = undefined;
              if (untracked(sidebarOpen) && !untracked(transitioning)) {
                sashHover.set(true);
              }
            }, SASH_HOVER_DELAY_MS);
          }}
          onMouseLeave={() => {
            clearHoverTimer();
            if (!dragging()) sashHover.set(false);
          }}
          onMouseMove={(e) => {
            if (!dragging()) return;
            if (e.pressedButton === null) {
              if (!panActive) finishDrag(e.pagePosition.x - startPageX, 0);
              return;
            }
            updateDrag(e.pagePosition.x - startPageX);
          }}
          onPressDown={(e) => {
            if (e.clickCount >= 2) {
              resetToDefaultWidth();
              return;
            }
            clearHoverTimer();
            startPageX = e.pagePosition.x;
            startWidth = currentWidth();
            preDragWidth = clampedStoredWidth();
            lastDeltaX = 0;
            collapsedInDrag = false;
            panActive = false;
            panX.set(0);
            liveWidth.set(startWidth);
            dragging.set(true);
          }}
          onPressUp={(e) => {
            if (panActive) return;
            finishDrag(e.pagePosition.x - startPageX, 0);
          }}
          onTouchMove={(e) => updateDrag(e.pageX - startPageX)}
          onTouchEnd={(e) => {
            if (panActive) return;
            finishDrag(e.pageX - startPageX, 0);
          }}
          onTouchCancel={() => {
            if (!panActive) finishDrag(lastDeltaX, 0);
          }}
          pan={{ x: panX }}
          onPanStart={() => {
            panActive = true;
          }}
          onPanEnd={(e) => {
            panActive = false;
            finishDrag(e.translation.x, e.velocity.x);
          }}
        >
          <View
            class={`pointer-events-none absolute inset-y-0 w-[1.5px] transition-opacity duration-150 ${
              dragging() ? "bg-brand/50" : "bg-foreground/15"
            }`}
            style={{
              left: dragging() ? currentWidth() - 1 : 4,
              opacity: sidebarOpen() && (dragging() || sashHover()) ? 1 : 0,
            }}
          />
        </View>
      </If>
    </View>
  );
}

/** The window: sidebar, title bar, and the pane the view names; overlays above them all. */
export function Shell() {
  if (isAvailable) {
    const win = currentWindow();
    mainWindow = win;
    const unbindWindow = bindWindow(win);
    // In an effect, the menu follows what it reads: the sidebar's label, whether Stop applies.
    effect(applicationMenu);
    // The close button always routes through `handleWindowClose` — on macOS it
    // flushes documents and hides the window so Dock reopen brings the same
    // session state straight back; elsewhere it confirms active runs before closing.
    win.set({ closeOnPress: false });
    win.on("closePress", () => void handleWindowClose());
    // Back from another app: a document open here may have been written there, and the notes folder too.
    win.on("focusChange", ({ focused }) => {
      if (!focused) return;
      void syncDocs();
      void refreshNotes();
    });
    const offReopen = Application.on("reopen", showMainWindow);
    const offQuitRequest = Application.on("quitRequest", () => void confirmExit("quit"));
    const offQuit = Application.on("quit", () => flushDocsSafely());
    cleanup(() => {
      offReopen();
      offQuitRequest();
      offQuit();
      unbindWindow();
      if (mainWindow === win) mainWindow = null;
    });
  } else {
    keymap.bind({
      "mod+t": () => void openNewSessionTab({ newTab: true }),
      "mod+n": () => void openNewSessionTab({ newTab: false }),
      "mod+shift+n": () => void newDocTab(),
      "mod+e": () => {
        if (currentView().name === "chat") void draftToDoc();
      },
      "mod+w": () => void closeTabOrWindow(),
      "mod+shift+]": () => cycleTab(1),
      "mod+shift+[": () => cycleTab(-1),
      "mod+o": () => void chooseWorkspace(),
      "mod+,": toggleSettings,
      "mod+k": () => setPaletteOpen(!isPaletteOpen()),
      "mod+shift+o": () => setCompareOpen(!isCompareOpen()),
      "mod+b": toggleSidebar,
      "mod+u": () => void randomWallpaper(),
      "mod+l": () => (showChat(), focusComposer()),
    });
  }
  keymap.bind("escape", escape);

  return (
    <View
      class="flex-1 flex-row bg-background"
      onMouseMove={
        DYNAMIC_WALLPAPER_ENABLED
          ? (e) => {
              if (e.pressedButton !== null && currentView().name === "doc") return;
              notifyWallpaperPointerMove(e.pagePosition.x, e.pagePosition.y);
            }
          : undefined
      }
      onMouseLeave={
        DYNAMIC_WALLPAPER_ENABLED
          ? () => {
              notifyWallpaperPointerLeave();
            }
          : undefined
      }
      onMouseUp={(e) => {
        notifyDocPointerUp();
        if (
          DYNAMIC_WALLPAPER_ENABLED &&
          currentView().name === "chat" &&
          !isPaletteOpen() &&
          !isCompareOpen() &&
          !pendingDialog() &&
          !isWallpaperAdjustOpen()
        ) {
          notifyWallpaperClick(e.pagePosition.x, e.pagePosition.y);
        }
      }}
    >
      <SidebarSplit>
        <Chat />
        <DocDeck />
        <TabBar />
      </SidebarSplit>
      <Palette />
      <CompareDialog />
      <Settings />
      <WallpaperAdjustDialog />
      <ZoomLayer />
      <ExtensionDialog />
      <UpdateCard />
      <Toasts />
    </View>
  );
}
