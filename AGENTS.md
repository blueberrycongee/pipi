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
- One agent process per session in flight: `switch_session` replaces the
  active session (and ends its run), so switching away from a working
  session parks its process and transcript (`parkActive` in
  `store/app.ts`) and starts a second process for the target. Coming back
  adopts the parked process; the sidebar dots the runs still working.
- Nothing is bundled: `agents/catalog.ts` lists the built-in harnesses
  and the user's custom ACP configs, `sidecar/probe-agents.mjs` finds
  them on PATH (never triggering OAuth popups or project hooks), and each
  launches as the user's own install — extensions, auth and session
  history included. Pi keeps its own launcher (`sidecar/launch-pi.mjs`,
  `stdio: "inherit"`) because its SDK needs a Node/Bun host this QuickJS
  app is not; driving it as a sidecar isolates the agent process the same
  way the external-agent bridge does.
- Orchestration: `sidecar/orchestrator-daemon.mjs` is a local HTTP
  daemon (ephemeral `127.0.0.1` port, random bearer token) that spawns
  and supervises delegated child tasks on ANY harness — role framing,
  non-escalating runtime modes (`resolveRuntimeMode` in
  `agents/catalog.ts`), optional git-worktree isolation
  (`sidecar/worktree.mjs`) — streaming progress back over JSONL stdout.
  `agents/handoff.ts` budgets the context handed between agents.
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
- `nsh test Shots.test.tsx --target macos` — screenshots of every state in
  `.nsh/shots/` (design review); `Gallery.test.tsx` does Pip and the icons
- `nsh test E2E.test.tsx --target macos` — a real run through the real
  sidecar; needs a model (see below)
- `nsh package .` — build an installable app package (targets the host OS;
  `npm run package:windows` / `package:linux` force a target)
- `npm run release:macos` — signed and notarized release build (Developer ID +
  `notarytool`; needs the release signing credentials)
- `npm install` — only regenerates the lockfile; there are no runtime
  dependencies. A working session needs `pi` (or another harness) on PATH.
- `node scripts/render-brand.mjs` — regenerate `icon.png` and `assets/brand/`

Developing without credentials: `node dev/mock-llm.mjs` serves a scripted
OpenAI-compatible provider, and `PI_CODING_AGENT_DIR=$PWD/dev/agent nsh dev .`
points the real Pi at it (prompts containing "tools", "error" or "slow"
exercise tool calls, failures and steering). If port 8790 is taken, pass
`--port`.

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
  DMG). The repo needs the `PIPI_RELEASE_*` / `APPLE_API_*` secrets
  configured for CI releases; `npm run release:macos` is the local
  fallback.

## Layout

- `App.tsx` — entry: window chrome, scrollbar theme, `boot()`, `mount(Shell)`
- `agents/` — the harness layer, no UI: `catalog.ts` (built-in and
  custom agents, the runtime-mode ceiling, role prompts), `types.ts`
  (drivers, protocols, delegation), `normalizer.ts`, `handoff.ts`
  (context carried between agents)
- `pi/` — the wire protocol, no UI (Pi is the reference driver):
  `protocol.ts` (RPC types), `jsonl.ts`, `client.ts` (commands ↔
  responses by id), `sidecar.ts` (spawns agent processes),
  `transcript.ts` (events → chat rows), `sessions.ts`, `credentials.ts`
  (`auth.json`), `providers.ts`
- `store/` — `app.ts` (all state and actions; signals are private),
  `backend.ts` (everything that touches the machine, swappable in tests),
  `prefs.ts`
- `views/` — screens; `ui/` — the component kit; `mascot/` — Pip
- `sidecar/` — Node helpers run as children: `probe-agents.mjs` (PATH
  discovery), `launch-pi.mjs`, `external-agent.mjs` (the universal
  bridge), `orchestrator-daemon.mjs` (delegated tasks), `worktree.mjs`,
  `env-paths.mjs`, `list-sessions.mjs` (Pi session `.jsonl` files under
  `<agent-dir>/sessions/`, documented format), `usage-stats.mjs`,
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
- No raw colors or palette classes in components: theme tokens only.
- Errors surface one way: `toast(tone, text)` in `store/app.ts`, rendered
  top-right by `views/Toasts.tsx`. User-triggered actions go through
  `attempt(what, action)`, which toasts the failure; background refresh
  failures toast as `warning`. A `phase: "failed"` blocking screen keeps
  its full-screen state AND fires an error toast. Transcript rows and
  `transcript.note` carry conversation/agent content only — app errors are
  never reported inline, in banners, or in dialogs.
- List rows are recycled: read `item()` where used; per-row state lives in a
  map by id (`views/Rows.tsx`).
- The message flow (`pi/turns.ts`): a turn is a header, its
  process (reasoning, prose between steps, consecutive tool calls as one
  activity row) and its answer. Rows never change place while a run goes on;
  the process folds once, when the answer is known (the message that called
  no tools ended), and only for a reader who is following.
- A reply is one list row per Markdown block (`proseRows` in
  `views/Prose.tsx`), never one row: a row taller than the viewport makes the
  list lay everything out again on each delta and paint a blank frame.
- Hand the list only what changed: rows that did not change must stay the
  same objects (`stableDisplayRows`, the block cache). A changed row that is
  not the last one sends the list through a pass on estimated sizes.
- Streamed text fades behind a veil (`lib/veil.ts`, `views/Prose.tsx`):
  in layout at once, alpha per appended chunk, recolored per frame from JS. A
  span nested in a `<Text>` takes no animated color (it renders black).
- Following the reply is the list's own (`maintainVisibleContentPosition`),
  on only while following; `views/Chat.tsx` says how the reader releases it
  and why the rows are handed over anew while released. Do not scroll per
  delta: `scrollToEnd` passes through offset 0 on its way.
- `LayoutAnimation.configureNext` (`animateLayoutOn`, `animateNextLayout`)
  animates the whole next layout pass, the chat's list included. Never key it
  to run state: a run that starts or settles re-lays the transcript in that
  same pass, and the list's cells cross-fade, jump, and are left shifted and
  clipped (`AcpClip.test.tsx --target macos` shows it).
- `nsh test Scroll.test.tsx --target macos` checks follow and release on the
  real list. To see a streaming glitch, take screenshots in a loop
  (`app.screenshot`) and compare frames: one-frame faults do not show in
  `texts()`.
