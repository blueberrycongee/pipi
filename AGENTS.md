# pipi

A native desktop control surface for coding agents, built with
[Native Shell (nsh)](https://nsh.dev). The UI is TSX on nsh's QuickJS
runtime; the agents are the user's own CLIs, each driven over its own
protocol and bridged into one internal wire format, so providers,
sign-ins, sessions, and engine-specific features all carry over.

Status: pre-alpha, aiming straight at a shippable app — the agent loop,
tools, and persistence live inside each harness, so this repo owns the
whole client: visual identity, UI, protocol wiring, session management,
multi-agent orchestration, and settings.

## Architecture

- UI: nsh TSX app (`App.tsx` entry), signals for state, Tailwind-style
  `class` props for styling, platform-native views under the hood.
- One internal protocol: Pi's JSONL RPC is the wire format for every
  harness. A [Pi](https://pi.dev) session spawns `pi --mode rpc` (nsh's
  `process.spawn`, `stdin: "pipe"`, `lines: true`); every other engine
  runs through `sidecar/external-agent.mjs`, a Node bridge that
  translates Claude Code, Codex, OpenCode, Cursor and every ACP harness
  (Devin, Gemini, Copilot, Grok, …) into that same protocol — so
  `pi/client.ts`, the transcript, approvals and session persistence are
  engine-agnostic. On the wire: one JSON object per LF-terminated line;
  correlate command responses by `id`; wait for `agent_settled`, not
  `agent_end`. Split records on LF only — never on U+2028/U+2029 (valid
  inside JSON strings).
- Sessions are first-class and daemon-owned: `sidecar/pipi-daemon.mjs`
  (started detached by `sidecar/daemon-client.mjs` when absent, reached
  through the `sidecar/daemon-link.mjs` stdio relay) owns every agent
  process, mints a token per session, persists a JSONL registry, and
  routes `<pipi-message>` answers back to whichever session asked. The UI
  is just a client: `pi/daemon.ts` multiplexes each attached session into a
  virtual `Transport` so `PiClient` speaks the same protocol while the
  daemon owns the processes — detach never kills, and a session blocked on
  an approval replays its dialog to whoever attaches next. Agents inside
  sessions get the same eight tools (`agents_list`, `workspaces_list`,
  `sessions_list`, `session_read`, `session_send`, `session_start`,
  `session_stop`, `present_files`) over a
  per-session-token HTTP MCP endpoint — Pi through
  `sidecar/pipi-orchestrator-extension.mjs` (which mirrors the daemon's
  tool list), Claude/Codex/ACP through the `sidecar/pipi-mcp-stdio.mjs`
  proxy — and the `pipi` CLI (`sidecar/pipi-cli.mjs`, with a blocking
  `wait`) is the same control channel for scripts and outside agents.
  Child sessions never exceed the parent's runtime mode.
- An agent process that goes away on its own is the app's to put back, on
  any engine: `routeExit` in `store/app.ts` starts it again under its
  session (`revive`) with the screen as it was — only a run cut short is
  said. The dead-agent screen is for a process that dies while starting,
  or will not stay up. An exit the store asked for is never routed: let go
  of a client (`closeActive`, `removeParked`) before closing it.
- The sidebar is the shelf and the strip is the desk. The shelf
  (`views/Sidebar.tsx`) lists every session and note there is, by project
  and by age. The strip (`views/TabBar.tsx`, state in `store/tabs.ts`) holds
  the surfaces in hand — chat sessions and Markdown documents, a press
  apart — following Obsidian's tab rule: the reader owns every tab. A plain
  click in the sidebar navigates inside the **current** tab (replacing what
  it shows, or switching to its existing tab if already open) without adding
  a new tab; `⌘`-click, middle-click, `"Open in New Tab"`, `+`, or `⌘T`
  opens a new tab. There is no italic preview seat. Closing a tab puts the
  thing back on the shelf; it deletes nothing and stops nothing. The pills
  size as a browser's tabs do (`lib/strip-width.ts`): they share the strip
  evenly down to a floor, past which it scrolls, and a close with the
  pointer in the strip holds their width until the pointer leaves, so a run
  of closes keeps its close button under it.
- Everything across the window's top — the traffic lights, the sidebar's
  hide button, the pills — centers on one line (`stripLine` in
  `lib/layout.ts`): half the 44pt strip, plus the sheet's `SHEET_INSET`
  when no wallpaper floats the sheet below the window's top. macOS keeps
  its traffic lights centered in the title bar height it reports, so
  dropping them onto the line (`controlsOffset` in nsh.json, re-aimed per
  wallpaper by `Shell`'s effect) inflates that report to twice their
  center — a number nothing may follow: the strips and `topBarHeight` are
  the fixed `TITLE_BAR_HEIGHT`, never `titleBarArea().height`.
- A chat needs no project. 闲聊 lives as a special built-in workspace inside
  工作区 (and in the welcome folder picker) — never crowding 新会话 at the
  sidebar's top — starting a session in `<dataDir>/chat/` (`chatFolder` in
  `store/app.ts`): an empty folder of the app's own, under no repository,
  so no project's `AGENTS.md`/`CLAUDE.md` rides along. It is never
  remembered in the user's persisted project list; its sessions appear under
  工作区 → 闲聊 and in 最近, and a 新会话 from a chat goes back to the last
  project.
- Documents are the strip's other surface (`store/docs.ts`,
  `views/DocEditor.tsx`): a page of the person's own words — an article or
  note the agents help polish, a long brief the composer is too small and too
  quick to send for — while keeping the shell's primary Coding Agent identity
  clean. A real Markdown file behind one live `RichEditorSession` per open
  tab, saved on a debounce and flushed on close. Notes live in a transparent,
  configurable local folder (default `<dataDir>/docs/`, configurable in
  Settings → General → Documents, with Finder/file-manager reveal and Save
  As). They sit in their own quiet collapsible `文档` (Documents) group in the
  sidebar — never crowding 新会话 at the top and never mixed into 最近's
  session stream — and user-named files in a custom folder are never deleted
  when emptied. The ways in are where the need is: `文档`'s `+` (⌘⇧N), the
  composer's own door once a draft passes its second line (⌘E moves the draft
  into a document — `draftToDoc` — and remembers which session it came from),
  or opening/dropping any `.md`. Taking a
  document to an agent is always explicit — there is no blind ⌘↵ send in a
  document: from a session's composer, `@` (`lib/doc-mention.ts`) pulls an
  open or saved document straight into the active
  session; from a document, the tab's or sidebar row's menu (or "Ask AI" on
  a selection) starts a clean New Session or adds to an open session by name
  (and a ⌘E draft offers one-click return to its exact origin session).
  Nothing is pasted and nothing is sent automatically: the words stay in the document,
  the card (`DocRef` in `store/app.ts`) rides on the composer's message, and
  a whole document is sent as it reads when sent. Sent without a word the
  message *is* the document's text; with one, the document rides behind the
  words in a block naming its file (`lib/doc-wire.ts`), so an agent with file
  tools changes it where it lives. No part of the app strips those blocks:
  the bubble reads them back as cards (`views/Rows.tsx`), and a title is the
  words (`titleWords`, twinned in `sidecar/session-index.mjs`). What goes to
  an agent is `plainMarkdown` — the serializer's escapes (`foo\_bar`,
  `\<tag>`) taken off.
- A document's file is not the editor's alone, and the editor never writes
  over what it has not read (`reconcile` in `store/docs.ts`): what an
  agent or another editor wrote comes into the open document first, as one
  change undo takes back, said once with the way back; where the person
  typed meanwhile the two are merged by paragraph (`lib/merge3.ts`), theirs
  standing where both changed the same lines. It looks at the disk when a
  document comes forward, when the window does, and while agents work
  (`syncDocs`), and a document on its way to a session is on disk before
  the agent looks for it (`flushDoc`). A file from elsewhere keeps its
  front matter as written, outside the editor; one holding what the editor
  cannot keep (raw HTML, footnotes, link definitions, math) opens
  read-only — shown, never rewritten. The editor lays blocks out as a
  flow with no gap of its own: the page's rhythm is each block's margins
  (`editorClasses`).
- Nothing is bundled: `agents/catalog.ts` lists the built-in harnesses
  and the user's custom ACP configs, `sidecar/probe-agents.mjs` finds
  them on PATH (never triggering OAuth popups or project hooks), and each
  launches as the user's own install — extensions, auth and session
  history included. Pi keeps its own launcher (`sidecar/launch-pi.mjs`,
  `stdio: "inherit"`) because its SDK needs a Node/Bun host this QuickJS
  app is not; driving it as a sidecar isolates the agent process the same
  way the external-agent bridge does.
- Usage is what each engine reports, never an estimate.
  `sidecar/agent-usage.mjs` reads every engine's own figures (Claude
  Code's `result.modelUsage` and Codex's `turn.completed.usage` are the
  session's running total, so a turn is the growth since the last one
  — the baseline is kept in the session file; OpenCode's `step_finish`;
  Cursor's `result.usage`; ACP's `session/prompt` `usage`, Devin's
  per-request `usage_update._meta`, and `usage_update.cost`) into Pi's
  `usage` shape, stamped on the turn's last assistant message with two
  additions: `unpriced` (tokens the engine named no cost for) and
  `models` (the models the engine says did the work).
  `sidecar/usage-stats.mjs` adds the session files up for Settings →
  Usage. An agent that reports nothing (Kimi) gets no figures and
  no row; a cost is shown only where an engine named one. External
  session files older than header `version` 2 carried a running total
  per message and are not counted. Per-file parsing rides on
  `sidecar/session-index.mjs` — one pass per file, cached at
  `<agent-dir>/pipi-session-index.json` by (size, mtime), shared with
  `list-sessions.mjs`, so a rescan reads only sessions written since
  the last one.
- The compare flow (`views/AgentPicker.tsx` → `CompareDialog`, ⌘⇧O) starts
  the same task in several sibling sessions at once — answers land as
  unread marks for the user, not as deliveries to the parent. Delegation
  between sessions is the agents' own job (`session_start`); there is no
  task object any more. Optional git-worktree isolation rides on
  `sidecar/worktree.mjs`; `agents/handoff.ts` budgets context handed
  between agents.
- Dev sidecar command: `pi --mode rpc` (the user's `pi` on PATH; requires
  Node 22.19+ or Bun as Pi itself does — install:
  `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`).

## Commands

- `nsh dev .` or `nsh run .` — run the app with hot reload
- `nsh check .` — typecheck (TypeScript 7 native compiler)
- `nsh test App.test.tsx` / `nsh test pi/pi.test.ts` — headless UI and unit
  tests (the app runs on a scripted Pi, `dev/fake-pi.ts`, via `Harness.tsx`)
- `nsh test Sidebar.test.tsx` — the sidebar frame by frame through session
  switches, on a manual clock with slow agent starts (`harness.startDelay`);
  `open` and `press` run the clock ~400ms themselves, so delays must exceed that
- `nsh test Slash.test.tsx` — the composer's slash menu: what `/` lists on
  each agent, Enter and Tab confirm into the draft (a second Enter sends),
  Escape closes; `nsh test store/slash.test.ts` — what a command puts on
  the wire across engines
- `nsh test Recover.test.tsx` — an agent process lost at rest, under a run,
  or again and again (`harness.dies`, or a prompt containing "crash"): what
  stays on screen, what is said, and when the app stops starting it again
- `nsh test Flow.test.tsx` — a run as the conversation says it, every 16ms on a
  manual clock: said once (Pip's line never restates the row above it), each
  step said whole (no placeholder line a delta rewrites), and the turn ending on
  the seconds its timer counted
- `nsh test Fold.test.tsx` — what folds and who says so, on a manual clock: a
  turn that is over is folded however it ended (answered, stopped, failed, a
  message sent into the run) and however the reader came to it, and what they
  pressed holds through the run, the next message, and a session change and
  back (`harness.cut` opens saved sessions on turns that got no answer; the
  scripted run "in steps" takes a steering message mid-run)
- `nsh test Switch.test.tsx` — a session change from the press on: what is
  shown with the click, and that nothing passes through while the agent loads;
  `nsh test SwitchFilm.test.tsx --target macos` films the changes into
  `.nsh/shots/switch-*.png` (compare frames: the fades do not show in `texts()`)
- `nsh test Tabs.test.tsx` — the strip: sidebar clicks navigating in the
  current tab, `+`/⌘T/⌘-click/"Open in New Tab" opening new tabs, no preview
  seat, neighbours on a close, ⌘⇧]/⌘⇧[, the drag's reorder and its Escape, a
  dropped `.md`, a typed heading renaming its tab
- `nsh test Docs.test.tsx` — the document from end to end: `/` listing
  blocks and Enter picking (`、` under a Chinese input method opens it
  too), sidebar top keeping only 新会话 while documents live in their own
  collapsible `文档` group (not 最近), configurable documents folder in
  Settings and Save As with front matter intact, ⌘↵ doing nothing inside a
  document, explicit session destinations (a tab's menu → New Session or
  named open sessions; "Ask AI" on selection), a long draft expanded with ⌘E
  returning to its exact origin session, `@` in the composer pulling a
  document straight into the active session, what an agent writes to the file
  landing in the open document and merging with what was typed meanwhile (the
  scripted Pi rewrites a document handed to it when asked to "rewrite", and
  "recite <path>" prints a file), front matter kept, a lossy file read-only;
  `nsh test DocLook.test.tsx --target macos` shoots each of those into
  `.nsh/shots/doc-*.png`; `nsh test DocOrb.test.tsx` tests the document's
  floating Pip orb (`views/DocOrb.tsx`, `store/doc-assistant.ts`): circular
  orb at rest, hover bloom into a bottom-right mini-composer with independent
  engine/model/effort/permission pickers, skeleton shimmer into veiled streaming
  replies, live document update pill + surgical inline highlight + one-click
  undo, in-place replace/insert, and full-chat handoff (`nsh test
  DocOrbLook.test.tsx --target macos` shoots light/dark states into
  `.nsh/shots/doc-orb-*.png`); `nsh test
  lib/doc-wire.test.ts` / `lib/doc-mention.test.ts` / `lib/merge3.test.ts` —
  the message's wire form, `@` mention parsing, and the three-way merge
- `nsh test TabsFilm.test.tsx --target macos` — films a document coming
  forward over the chat and a tab closing (the pills flow to their new
  slots) into `.nsh/shots/tabs-*.png`, via `harness.then`'s `tab:` /
  `closetab:` steps; also the squeeze and the close-lag (`tabs-lag-*`):
  nine pills narrowed, two closes holding their width, the pointer leaving
  the strip handing the room back
- `nsh test Settings.test.tsx` — Settings switches sections and subpages
  without remounting visited panes or flashing `Usage`'s empty state;
  `--target macos` checks pixel stability right after section switches
- `nsh test SelectScroll.test.tsx --target macos` — a selection dragged to an
  edge of the conversation scrolls it on (and releases or follows as a scroll
  of the reader's does); `nsh test lib/edge-scroll.test.ts` — how fast
- `node --test sidecar/*.test.mjs` — the Node side: the daemon, what each
  engine's usage report reads as (`agent-usage.test.mjs`, on the engines' own
  payloads), and the bridge writing it through to the scanner
  (`external-usage.test.mjs`, on `dev/fake-acp.mjs` with `FAKE_ACP_USAGE=1`)
- `nsh test Shots.test.tsx --target macos` — screenshots of every state in
  `.nsh/shots/` (design review); `Gallery.test.tsx` does Pip and the icons
- `nsh test QueueLook.test.tsx --target macos` — the messages sent
  into a long streaming reply, in `.nsh/shots/queue-*.png`: each a waiting
  bubble in the conversation with its own edit and remove, none over the
  composer; one taken back (`takeQueued`) leaves the others waiting
- `nsh test UserFold.test.tsx` — a sent message laid out past six lines folds
  to a fading preview; the chevron at the bubble's foot opens and closes it
  (`--target macos` films `.nsh/shots/userfold-*.png`)
- `nsh test Zoom.test.tsx` — a table's hover expand button opens it in the
  zoom layer (`ui/Zoom.tsx`, the one preview surface — a `TextView` image
  press lands there too); Escape or its close button leaves it
  (`--target macos` films `.nsh/shots/zoom-*.png`)
- `nsh test ZoomImage.test.tsx` — the zoom layer's image viewer
  (`views/ZoomImage.tsx`, math in `lib/image-zoom.ts` with its own unit test)
  on its stage (`dev/ZoomStage.tsx`): the pill steps and snaps onto the
  picture's own pixels, a double press dives and returns at the point pressed,
  a drag pans pixel-exact, the keys play from the open — headless never types
  plain keys into views, so the key steps probe once and skip where silent
  (`--target macos` films `.nsh/shots/zoomimg-*.png`)
- `nsh test Media.test.tsx --target macos` — inline media in the message stream
  (`views/Media.tsx`, `lib/media.ts`): local images/galleries, video/audio
  players, PDF/deliverable cards, safe remote-URL cards, user `<attachment>`
  files (paperclip/drop/paste), and `present_files` + tool `ImageContent`
  surfacing outside collapsed turn folds (`--target macos` shoots
  `.nsh/shots/media-*.png`; `nsh test lib/media.test.ts` unit-tests parsing
  and resolution; `node --test sidecar/external-media.test.mjs` covers Claude,
  Codex, and ACP media/structuredContent forwarding)
- `nsh test WallpaperLook.test.tsx --target macos` — the app under a wallpaper,
  every surface it reaches, in `.nsh/shots/wallpaper-*.png` (`harness.wallpaper`
  lays one; name any image in the test's `PICTURE`)
- `nsh test PresetStage.test.tsx --target macos` — each built-in live wallpaper
  alone on a bare stage (`dev/WallpaperStage.tsx`), light and dark, in
  `.nsh/shots/stage-*.png`: a shot's `uniforms` set any member of the shader's
  `struct Uniforms` (`phase` adds seconds to its clock); `PresetLook.test.tsx`
  shoots the same presets under the welcome screen (`preset-*.png`)
- `nsh test Update.test.tsx --target macos` — the update card found,
  downloading and ready, in `.nsh/shots/update-*.png` (`harness.update`
  scripts the updater); `UpdateFilm.test.tsx` films it frame by frame into
  `.nsh/shots/film/` for a GIF
- `nsh test E2E.test.tsx --target macos` — a real run through the real
  sidecar; needs a model (see below)
- `nsh package .` — build an installable app package (targets the host OS;
  `npm run package:windows` / `package:linux` force a target). On macOS the
  binary keeps nsh's linked-SDK stamp, so the window draws an older chrome
  generation than the system's: `scripts/package-mac.sh` re-stamps it
  (`scripts/stamp-macos-sdk.sh`, also run by `release:macos`); the script
  takes the .app or a bare Mach-O, so `~/.nsh/runtime/macos/nsh-macos-*` can
  be stamped once to fix `nsh dev` and every later `nsh package` too
- `npm run release:macos` — signed and notarized release build (Developer ID +
  `notarytool`; needs the release signing credentials)
- `npm install` — only regenerates the lockfile; there are no runtime
  dependencies. A working session needs `pi` (or another harness) on PATH.
- `node scripts/render-brand.mjs` — regenerate `icon.png` and `assets/brand/`

Developing without credentials: `node dev/mock-llm.mjs` serves a scripted
OpenAI-compatible provider, and `PI_CODING_AGENT_DIR=$PWD/dev/agent nsh dev .`
points the real Pi at it (prompts containing "tools", "error" or "slow"
exercise tool calls, failures and steering). It listens on port 8787; if
that is taken, set `PORT`.

## Remotes and publishing

- Two remotes: `dev` → `blueberrycongee/pipi-dev` (private; the dev
  trunk — every branch and commit can be pushed there) and `public` →
  `blueberrycongee/pipi` (the release face — `main`, tags and releases
  only). Development never happens on the public repo: no feature
  branches, no pull requests there (external PRs are closed by the
  `close-prs` workflow; issues stay open).
- Publishing is a squash snapshot, not a merge: from `main`, update the
  local `public` branch with `git read-tree --reset -u main` and commit
  once per milestone, then `git push public public:main`. The public
  history is a curated sequence of snapshots; the full history stays in
  pipi-dev.
- Releases ride on tags pushed to `public` (`v*` triggers
  `.github/workflows/release.yml`, which ships the signed, notarized
  macOS DMG plus the Windows installer/zip and the Linux tar.gz, the
  signed `.nshpkg` of the app's code `nsh publish` writes, and the
  signed `latest.json` manifest `nsh update-manifest` writes from the
  archives and the package). The repo needs the `PIPI_RELEASE_*` /
  `APPLE_API_*` secrets configured for CI releases, and `PIPI_PACKAGE_*`
  / `PIPI_UPDATE_KEY` for the package and manifest signing;
  `npm run release:macos` is the local fallback. `build` in `nsh.json`
  is one counter for archives and packages — raise it every release.
- The app updates itself, incrementally when it can: `nsh.json`
  `updater` names the public repo, the key that signs its manifests and
  the roots its code packages verify against. `store/update.ts` asks for
  a package first (`checkForPackage` → `downloadPackage` →
  `restartToPackage` — the small `.nshpkg`, which the launcher tries at
  the next start and rolls back if it crashes) and falls back to the
  full archive (`checkForUpdate` → `downloadUpdate` →
  `installAndRestart`) when the shell is too old for the package or the
  release has none — `views/UpdateCard.tsx` shows them the same way,
  plus the package's size up front. Checks run on boot, then every 4h,
  and About → Check. In dev and tests the check finds nothing; the fake
  backend scripts it via `harness.update` (`package: true` for the
  package path).

## Layout

- `App.tsx` — entry: window chrome, scrollbar theme, `boot()`, `mount(Shell)`
- `agents/` — the harness layer, no UI: `catalog.ts` (built-in and
  custom agents, the runtime-mode ceiling, role prompts), `types.ts`
  (drivers, protocols, delegation), `normalizer.ts`, `handoff.ts`
  (context carried between agents)
- `pi/` — the wire protocol, no UI (Pi is the reference driver):
  `protocol.ts` (RPC types), `jsonl.ts`, `client.ts` (commands ↔
  responses by id), `stdin.ts` (writes sliced under the child's 1 MiB
  queue), `sidecar.ts` (spawns agent processes),
  `transcript.ts` (events → chat rows), `sessions.ts`, `credentials.ts`
  (`auth.json`), `providers.ts`
- `store/` — `app.ts` (all state and actions; signals are private),
  `backend.ts` (everything that touches the machine, swappable in tests),
  `prefs.ts`, `tabs.ts` (the strip: Obsidian-style tab navigation,
  doc⇄chat), `docs.ts` (open Markdown documents, their files kept
  in step with the disk, and the notes listed in 最近), `update.ts` (the app's own update checks and the card's state)
- `views/` — screens; `ui/` — the component kit; `mascot/` — Pip
- `sidecar/` — Node helpers run as children: `probe-agents.mjs` (PATH
  discovery), `launch-pi.mjs`, `external-agent.mjs` (the universal
  bridge), `agent-usage.mjs` (each engine's usage report, read into Pi's
  shape), `pipi-daemon.mjs` (the session daemon), `daemon-client.mjs`
  (discovers/starts it), `daemon-link.mjs` (the app's stdio relay),
  `pipi-cli.mjs` (the `pipi` command), `worktree.mjs`,
  `env-paths.mjs`, `list-sessions.mjs` (Pi session `.jsonl` files under
  `<agent-dir>/sessions/`, documented format), `usage-stats.mjs`,
  `session-index.mjs` (their shared per-file parse, disk-cached),
  `pipi-mcp-stdio.mjs`, `pipi-orchestrator-extension.mjs`
- `theme.json`, `nsh.json` — design tokens, capabilities; `DESIGN.md` — the
  design system and Pip's drawing rules. Read it before UI work.
- `docs/pi/` — vendored Pi documentation (dev checkout); treat it as the
  canonical reference. Most relevant for the client: `rpc.md`,
  `rpc-commands.md`, `json.md`, `message-types.md`, `session-format.md`,
  `sessions.md`

## Rules of the house

- The client exposes only what the active harness documents — for Pi, the
  vendored docs are canonical, and the two things its RPC lacks are done the
  way Pi's docs describe, not invented: listing sessions (the session
  `.jsonl` files under `<agent-dir>/sessions/` are parsed in the
  documented format by a short-lived Node helper) and API keys (written
  to `<agent-dir>/auth.json` in its documented shape; Pi restarts to read
  it). OAuth login is not available over RPC; Settings says so.
- Read env vars with `lib/env.ts`, not `process.env` from the `process`
  import (under hot reload the default import has no `env`).
- A child's environment is only what `nsh.json` `capabilities.process.env`
  lists: a new provider variable must be added there.
- The app starts only the commands `capabilities.process.execute` lists, by
  the bare names listed there. A path it does not list is refused with
  `ERR_ACCESS_DENIED` — the code a working folder outside `fs.write` gets
  too; `permission` (`"process"` or `"fs"`) tells them apart, and only
  `"fs"` is about the folder (`startError` in `pi/sidecar.ts`). A binary
  found by its path is started through the host shell
  (`spawnWithLauncher`), and the system-wide installs are looked for
  through it as well (`firstExecutable`). `fs` grants `/`: any folder the
  panel returns may run an agent (on Windows `/` is not absolute and
  grants nothing — `${homeDir}` stands). `nsh test pi/sidecar.test.ts`
  holds the names to the manifest.
- No raw colors or palette classes in components: theme tokens only.
- Errors surface one way: `toast(tone, text)` in `store/app.ts`, rendered
  top-right by `views/Toasts.tsx`. User-triggered actions go through
  `attempt(what, action)`, which toasts the failure; background refresh
  failures toast as `warning`. A `phase: "failed"` blocking screen keeps
  its full-screen state AND fires an error toast. Transcript rows and
  `transcript.note` carry conversation/agent content only — app errors are
  never reported inline, in banners, or in dialogs. A toast is one line:
  its whitespace collapses and its text never runs past 120 chars. The
  same toast again stays in place and its time starts over; it is never
  removed and re-added.
- A run's error is said once, and only when it stands (`#failure` in
  `pi/transcript.ts`): a failed assistant message is held back until the run
  settles or the conversation moves on, and a retry (`auto_retry_start`, an
  overflow compaction with `willRetry`, a later assistant message) takes its
  place unsaid — the status line counts the attempts meanwhile and keeps
  `retrying` until the attempt shows life. Live and reloaded history read
  the same. `nsh test Errors.test.tsx` plays these on the scripted Pi
  (prompts with "flaky", "outage", "refuse").
- Every painted frame is a settled state (`DESIGN.md` → Motion): what would
  be wrong frozen — an empty chat mid-switch, "waking", "No model", a blank
  or re-laying list, a fold half-flipped, a bubble at an unclamped height —
  is never painted. Hold the last settled state until the next is whole:
  the outgoing rows stay until the destination lands (clearing first is the
  blank flash), a collapsing row keeps its content to its last frame
  (`keepLast`), and a quick landing interrupts the dim-out rather than
  completing it — a dip, never a blank. A change is one motion between two
  settled states, and the frame a thing appears on is already its settled
  frame: a conversation lands at its end (`initialScrollAtEnd`), status
  lines land whole (`id:rolling-born` marks only a live line's growth), and
  mounted, recycled, or re-attached rows never replay an entrance
  (`markRowsSeen`, `markVeilsSeeded`, `displayRowIds`). Only what is new
  and live animates — once, opacity-led, never positional (streamed text is
  in layout as it arrives, veiled per appended chunk; `lib/veil.ts`) — and
  a wait shorter than `PATIENCE_MS` is not a state and never shows
  (`delayedFade`). What the reader set holds through whatever renders after
  it (folds, follow, scroll place), and a load that confirms what is shown
  changes nothing on screen (`sameRows`: nothing for the list to do).
  Verify frames, not states: probe every ~16ms on a manual clock
  (`frames()` in `Switch.test.tsx`) and pixel-diff on `--target macos`
  (`SwitchLand`, `SendFlashRepro`, `BubbleVanish`) — one-frame faults do
  not show in `texts()`.
- List rows are recycled: read `item()` where used; per-row state lives in a
  map by id (`views/Rows.tsx`).
- The message flow (`pi/turns.ts`): a turn is a header, its
  process (reasoning, prose between steps, consecutive tool calls as one
  activity row) and its answer. Rows never change place while a run goes on;
  the process folds once, when the turn is over: its answer is known (the
  message that called no tools ended), or it was cut short — stopped, failed,
  or a message sent into the run took the end from it. Only the turn the run
  is on is open by default (`running` in `buildDisplayRows`: the last one,
  unanswered, not closed — `turnMs`), so a turn that is over is folded
  however it ended and however the reader came to it. The fold is the turn's
  own end, made wherever the reader is then (`turnDefault` in
  `views/Rows.tsx`): it is not owed to a reader who scrolled away and made on
  their return — one reading elsewhere never got it back. And it leaves once
  the reply's last word is lit (`scheduleAutoFold` waits on
  `proseVeilUntil`): one that leaves sooner pulls the floor from under a word
  still arriving.
- A run is said once, where it happens (`activityLabel`, `liveRowShown` in
  `views/Chat.tsx`): the turn's header ("Working 12s"), the step under way
  ("Reading package.json"), the reply as it is written. Pip's line under them
  does not restate the row above it — once the run has rows of its own it
  keeps to Pip (`pipMood`), and speaks only for what no row says: a wait on
  the reader or on other sessions, a compaction, a retry, and the moment
  before the run's first row. A step is said whole or not yet: a call the
  model has only begun to write (`isUnnamedCall` in `pi/turns.ts`: its name
  known, no argument yet) gets no line — "Reading file" rewritten "Reading
  package.json" a frame later is a line that changes its mind — and the line
  before it stands meanwhile. What is counted is what is concluded: the
  header's timer turns over on the turn's own seconds and the figure it ends
  on is the same count (`elapsedSeconds`), never "12s" then "14 seconds".
  `nsh test Flow.test.tsx` films a run every 16ms and holds all three.
- Past that the folds are the reader's (`choices` in `views/Rows.tsx`): a press
  is the only thing that writes one, and it holds through the run and its end,
  the next message, a session change and back. A press on the working turn is
  also their say on the work (`turnSay`): folded, it stays folded as the run
  goes on past a message sent into it (`hushed`), until it is answered; a
  press on a turn that is over opens or closes that turn alone. Folds are
  kept by conversation and row id. The
  conversation is `conversationKey()` (`store/app.ts`), set in the same batch
  as the rows — never the agent's `sessionId`, which lags a session change
  (the conversation shown ahead would wear another's folds, then jump). The
  same conversation loaded again keeps its key and its rows' ids (`succeed`,
  `Transcript.adopt`: rows pair up by what they say), so a transcript that
  replaces one on screen must go through `succeed`, or every fold there is lost.
- A reply is one list row per Markdown block (`proseRows` in
  `views/Prose.tsx`), never one row: a row taller than the viewport makes the
  list lay everything out again on each delta and paint a blank frame.
- Hand the list only what changed: rows that did not change must stay the
  same objects (`stableDisplayRows`, the block cache). A changed row that is
  not the last one sends the list through a pass on estimated sizes.
- Streamed text paces and fades behind a veil (`lib/stream-pacer.ts`, `lib/veil.ts`,
  `views/Prose.tsx`): bursty deltas drain on 16ms ticks (`markPacersSeeded` on
  landing), alpha per appended chunk, recolored per frame from JS. A span nested
  in a `<Text>` takes no animated color (it renders black). The pacer's cut is
  the veil's fade boundary, so it lands on a word's edge (`snapToWord`: back
  first, then forward; CJK cuts freely) — a word cut in two fades in as two
  halves. Within a chunk the fade travels word by word (`waveOf`, the last
  word `VEIL_WAVE_MS` after the first): a chunk lit whole on one frame is a
  slab that pops. A chunk is done when its last word is (`peak` is the tail's
  progress), and a span is cut per word only while it is fading (`veilCuts`).
- Following the reply uses Natural Reading Physics (`ScrollMode`: `tail` /
  `horizon` / `horizon-held` / `free` in `views/Chat.tsx`): `maintainVisibleContentPosition`
  is active only in `tail`/`horizon` (`bottomFollowing`), while any upward scroll
  immediately enters `free` with zero tug-of-war or snap-back jitter; long replies
  pause cleanly once the sent prompt reaches `horizonInset()` (`horizon-held`)
  without injecting fake runway or yanking to the end on settle. Do not scroll
  per delta: `scrollToEnd` passes through offset 0 on its way.
- The conversation's foot is measured from the composer's figure (`footOf`,
  `figure` in `views/Chat.tsx`), never a constant: whatever stands on the
  composer — attachments, a long draft, an inline prompt —
  raises the end, the fade and "Jump to latest" together. When the foot
  rises under a following view, scroll to the end again (the effect beside
  `foot`): the list loses its place and paints blank otherwise. When it
  sinks, do not — the list clamps itself, and an offset asked for before the
  shorter content is laid out blanks it instead.
- `LayoutAnimation.configureNext` (`animateLayoutOn`, `animateNextLayout`)
  animates the whole next layout pass, the chat's list included. Never key it
  to run state: a run that starts or settles re-lays the transcript in that
  same pass, and the list's cells cross-fade, jump, and are left shifted and
  clipped (`AcpClip.test.tsx --target macos` shows it). Never call it in
  generic controls (`Segmented` and `SettingsNav` use `nsh/base` `Tabs` +
  `Tab` `indicatorClass`, whose native `spring_move` animates selection with
  zero layout pass), never arm it before an `await`, and always guard it with
  `!isRunning()` if a chat list may be active (`Reveal` and `Presence` in
  `ui/Reveal.tsx` are scoped alternatives).
- In-window sheets and multi-pane switchers use the shared anti-flicker
  primitives in `ui/Reveal.tsx` (re-exported from `ui/motion.ts`):
  `FloatingLayer` owns a sheet's open/close over `SCRIM` — batching its initial
  pose with `mounted.set(true)`, reversing mid-close re-opens smoothly from live
  UI-thread values instead of snapping opacity back to `0`, and using bounded
  `<= 180ms` timing rather than unbounded springs that keep `nsh` non-idle.
  Never nest `enter` / `enterStagger` inside an already-animating
  `FloatingLayer`, and never cold-unmount/remount section or subpage panes on
  tab switches (`opacity: 0` during `45ms` stagger lets the dimmed backdrop bleed
  through translucent `POPUP` glass and cold-allocates `<Canvas>` marks): use
  `ViewDeck` to keep visited panes mounted (`display: "none"` when inactive;
  active panes omit `display` so vertical column flex holds) and swap at
  steady `opacity: 1`. `FloatingLayer` registers a childless `<Overlay
  onCancel>` while open so `Escape` dismisses the sheet even when an input
  inside has focus, and `LayerActive` blurs `TextField`s when a `ViewDeck` pane
  goes `display: "none"` or a `FloatingLayer` closes so hidden panes never trap
  keyboard focus.
- Do not introduce state, input, or CSS transitions that blink on commit: gate
  async empty states on a `Ready` signal warmed ahead of view switches (or
  `delayedFade`) so fast background scans never flash a false `"No … yet"`
  screen; keep `TextField` placeholders as app-rendered `Text` overlays rather
  than host `Input` placeholders (which step at integer bounds under ancestor
  transforms); and use `transition-colors` instead of `transition-all` /
  `PRESS` whenever `font-weight` flips on selection.
- A session change answers the click, not the agent (`headFor` in
  `store/app.ts`, the pane in `views/Chat.tsx`; `DESIGN.md` → Motion). The
  destination goes on screen at once when there is one to show: a conversation
  left at rest comes back from `visited` (the agent's history then confirms it
  — the same rows, nothing for the list to do — or replaces it), a new
  session's empty chat is shown ahead of the agent (`isDraftAhead`). Otherwise
  the change is `leaving`: the rows on screen stay until the destination lands
  (never clear them first — that is the blank flash), the chat dims them and
  holds its screen, and `arrived` ticks once to settle the destination in. Do
  not add a second entrance on top (`landed` is not one), and do not gate the
  composer on the agent being ready: `send` waits for the change to end.
- A selection drag scrolls the conversation from the pane, not the platform
  (`lib/edge-scroll.ts`, the `selecting` block in `views/Chat.tsx`): nsh's own
  autoscroll looks for a scroll view *around* the selectable view, the list is
  inside it (`List` takes no `selectable`), and its frame goes on under the
  title bar and the composer. The edges are those of what can be read. The
  pane hears the mouse only while a selection is being made; a release outside
  it is never heard, so out there the scroll lasts only as the selection grows.
- `nsh test Scroll.test.tsx --target macos` checks follow and release on the
  real list. To see a streaming glitch, take screenshots in a loop
  (`app.screenshot`) and compare frames: one-frame faults do not show in
  `texts()`.
