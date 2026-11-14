# pipi design

pipi is a quiet, precise desktop tool with one expressive thing in it: Pip. The
interface is near-monochrome so that the conversation carries the screen; the
brand color appears only where the caret is, on links, on the primary action of
a surface, and on active indicators.

Sources of truth: `theme.json` (color, radius), `nsh.json` → `tailwind` (type
scale, shadows, easing), `ui/styles.ts` (shared class recipes),
`mascot/geometry.ts` (Pip). This document explains them; when they disagree,
the files win and this document is wrong.

## Principles

1. **Content first.** Replies are unboxed prose on the background. Only what
   the user said (a bubble) and what a machine printed (a sunken block) get a
   container.
2. **One accent, spent rarely.** Cobalt blue (`brand`) marks the caret, links,
   the primary button, and active focus or status indicators. Never a decoration.
3. **A turn is a unit.** Steps of one turn sit 4pt apart; turns sit 28pt apart.
   Spacing says what belongs together before any line or box does.
4. **State is visible, motion is short.** Every pressable has hover, pressed,
   focus and disabled looks. Nothing animates longer than 220ms except Pip
   and the composer's one trip to its dock.
5. **Symbols over words.** An unambiguous icon replaces a visible label; the
   word moves to the tooltip and accessibility label. Text that restates what
   is already on screen is deleted.
6. **Only what the active engine can do.** Every control maps to a documented
   capability of the harness driving the session — for Pi, an RPC command or
   file in `docs/pi/`; for the rest, whatever the bridge exposes. No invented
   capabilities.

## Pip, the mascot

Pip is a little ghost: a sheet with ears, a hem of two lobes, a tail drawn as
one line on its right, and a face with no mouth (dogs carry a nose and, for
some breeds, a smile or tongue). It is line art — a coat under one round
outline (`3.2` grid units wide).

Pip comes as a cat or a dog across **14 coats** (`COATS` in
`mascot/geometry.ts`, selectable in Settings → General, defaulting to `ghost`):

- **Cats** (slit eyes and whiskers; in `work` mode pupils widen on a hunt):
  `ghost`, `cow`, `calico`, `ginger`, `black`, `blue`, `siamese`.
- **Dogs** (round eyes and a nose; drop-ear breeds draw hanging flaps):
  `shiba`, `husky`, `border`, `shepherd`, `golden`, `rottweiler`, `dalmatian`.

### Construction

Drawn on a `64 × 64` grid (`GRID = 64`), cropped to `BOUNDS` (`x: 0, y: 7,
w: 64, h: 50`, aspect `64:50`). The body is symmetric about axis `x = 30` so
the right side leaves room for the tail.

Each coat defines:

- `build`: ear profile (`cat`, `tall`, `round`, `prick`, `big`, `tipped`, or
  `drop` for hanging ear flaps) and half-widths at the ear base (`h`), flanks
  (`m`), and hem (`w`).
- `tail`: one stroked path (`handle`, `stout`, `hook`, `kink`, `curl`,
  `sickle`, `plume`, `low`, `stub`, `whip`) swinging about `tailPivot`.
- `base` and `markings`: coat fill and markings clipped to the body silhouette,
  plus optional `ear` flaps, `eyes`, and `whiskers` or `muzzle`.

### Color

| Token / Paint | Value | Use |
|---|---|---|
| `pip-line` (`LINE_PAINT`) | `#16161D` (light) / `#F1F2F6` (dark) | The outline and tail stroke. Follows the appearance so Pip's edge always reads against the background. |
| Coat & features | Breed palette (`#FFFFFF`, `#26262E`, `#F0A04B`, `#F8F0DE`, …) + `#16161D` ink | Fixed across appearances; Pip is never recolored by theme or given a gradient. |

On the app icon (`icon.png`), the default `ghost` Pip stands in `idle` mood
(light outline) on a flat pure white (`#FFFFFF`) macOS squircle tile (`824 px`
superellipse in a `1024 px` canvas).

### Moods

Only the eyes (and a dog's smile/tongue) and the motion change; the silhouette
never does.

| Mood | Eyes | Motion | When |
|---|---|---|---|
| `idle` | coat eyes (slit or round) | breathes (`scaleY`, 3.6s), tail wags (`0.12` rad, 3.6s), blinks every ~2.6–5.8s | Ready |
| `think` | round, up and toward the tail | floats and tilts (`-2.5°`, 2.2s), blinks every 2s | Model is reasoning |
| `work` | coat eyes (cats widen pupils) | bobs (`translateY`) and wags tail (`0.35` rad, 0.62s) | A tool runs |
| `write` | round, looking down | quick small bob and brisk tail wag (`0.18` rad, 0.3s) | Reply streams |
| `happy` | upward arcs | one squash-and-jump (0.62s) with two quick tail wags | A run ended well |
| `error` | crosses | one `headShake` (dogs hide smile/tongue) | A run failed |
| `sleep` | flat lines | slow breath (`scaleY`, 4.2s; dogs tuck tongue in) | Starting; empty lists |

`store/app.ts` → `pipMood` is the only place app state becomes a mood.

### Rules

- Minimum size 16px wide. Below 24px use `still` (no loops) unless Pip *is*
  the status indicator (activity line, running session row, update card).
- Clear space: leave breathing room around the 64-unit frame.
- One animated Pip per surface; the sidebar carries one per working session.
  Pip never overlaps text and never talks.
- With reduced motion Pip holds the mood's pose and does not move.

### Where Pip lives

| Place | Size | Mood |
|---|---|---|
| App icon (`icon.png`) | 620 of 1024 | idle (`ghost`) |
| Welcome / waking / failure stage (`views/Chat.tsx`) | 96 (welcome) / 80 (waking, failure) | from `pipMood` |
| Activity line under the transcript (`views/Chat.tsx`) | 22 | from `pipMood` |
| Running session, draft, child session, or collapsed running project in the sidebar (`views/Sidebar.tsx`) | 16 | work |
| Empty single-folder sidebar (`views/Sidebar.tsx`) | 40, still | sleep |
| Update card (`views/UpdateCard.tsx`) | 22 | `idle` / `work` / `happy` along the track |
| Settings → General coat picker (`views/Settings.tsx`) | 40 | `idle` (`still`); chosen coat `happy` |
| Settings → About (`views/Settings.tsx`) | 88 | idle |

### Files

- `mascot/geometry.ts`: the shapes and 14 coats as data. No imports; the single source.
- `mascot/Pip.tsx`: the in-app canvas. Everything that moves is an animated
  value read on the UI thread; no app code runs per frame.
- `scripts/render-brand.mjs`: `node scripts/render-brand.mjs` regenerates
  `icon.png`, `assets/brand/*.svg`, `assets/brand/dmg-background*.png` and
  proofs in `assets/brand/proof/`.

## Color

Semantic tokens only; no hex or palette classes in components. Neutrals carry
a faint cool slate-blue tint (hue `262`) so they sit cleanly with the cobalt
blue `brand` (`#4C6FFF`; `brand-soft`, `brand-text` and `ring` sit at hue
`268`).

| Token | Role |
|---|---|
| `background` / `foreground` | The main pane and its text |
| `sidebar*` | The left column: one step darker (dark) or greyer (light); frosted glass — `backdropFilter` under a `bg-sidebar` tint, heavier over a wallpaper (see Wallpaper) — and solid on Linux |
| `card` | Grouped surfaces: composer, settings groups, notices |
| `popover` | Anchored surfaces: menus, pickers, palette, toasts, tooltips |
| `sunken` | Machine output: code, tool results |
| `secondary` | The user's bubble; quiet buttons |
| `muted-foreground` → `subtle` | Secondary text → tertiary (captions, hints) |
| `accent` | Hover and keyboard highlight of rows |
| `border` / `input` / `hairline*` | Structural dividers / control outlines / glass and focus hairlines |
| `brand`, `brand-text`, `brand-soft` | Accent fill / accent as text / tint |
| `pip-line` | Pip's outline and tail stroke (`#16161D` light, `#F1F2F6` dark) |
| `success`, `warning`, `destructive` | Only for their meanings |
| `scrim` | Behind every floating layer: Settings, the palette, dialogs (`SCRIM`) |

## Typography

System UI font; monospace only for code, paths, commands and keys. Desktop
density: 13pt is the interface size, 14pt the reading size.

| Class | Size / line | Use |
|---|---|---|
| `text-2xs` | 10 / 14 | Keycaps |
| `text-xs` | 11 / 16 | Captions, metadata, mono output |
| `text-sm` | 12 / 18 | Secondary text, tool rows |
| `text-base` | 13 / 20 | Interface: rows, buttons, labels |
| `text-md` | 14 / 22 | Reading: messages, replies, leads |
| `text-lg` | 15 / 22 | Dialog titles, h2 in replies |
| `text-xl` | 17 / 24 | h1 in replies |
| `text-2xl` | 20 / 26 | Page and stage titles (semibold, tight) |

Weights: regular, `font-medium` for names and selected things,
`font-semibold` for titles. Numbers that change use `tabular-nums`.

## Space, size, radius

4pt grid. Gaps by relationship: 2 (optical), 4–6 (icon to label), 8 (items of
a group), 12–16 (inside a container), 24 (between groups), 28 (between turns).

The sidebar's vertical rhythm is a named ladder on that grid, smallest to
largest: rows of one parent touch (0, hover fills stack as one column), a
boundary between project folders gets 4, a caption hugs its list (6), the
footer pads the hairline (8, matched by the scroll's end pad), the primary
action and the first caption sit 12 apart, and functional groups split at
24. An empty tree centers its sleep Pip in the visible region, never a fixed
offset.

| Thing | Size |
|---|---|
| Title bar | 44 |
| Sidebar | 264 wide |
| Reading column | max 760 |
| Row, large button, text field | 32 |
| Session row in the sidebar | 28 |
| Button, icon button, disclosure | 28 |
| Chip, small button | 24 |
| Icon | 16 (14 inside chips and tool rows) |

Radius is concentric: `rounded-sm` (inline code) → `rounded-md` 6 (rows,
buttons) → `rounded-lg` 8 (fields, blocks) → `rounded-xl` 12 (cards, popups)
→ `rounded-2xl` 16 (user bubble) → 22 (composer: the send button's 14 plus
its 8pt inset) → `rounded-full` (send, switches).

The composer rests at 92pt: 16 above the text, a 32pt field that grows from
the second line, 8 to the toolbar, the 28pt toolbar, 8 below. Its text and
the first chip's content share a 16pt left edge.

With no conversation to read — the empty chat, and the wait for the agent
before it — the composer stands in the middle of the pane and the stage is
built around it (`HERO`, `views/Chat.tsx`): Pip and the title stand on its
top edge, the title 24 over its surface, and the project the session will run
in hangs 12 under it. The pane's free height is shared 9 to 11 over and under
that figure, so it sits just above the middle, where the eye puts the middle.
It is placed by layout, not by an offset: it re-centers as the composer grows
(a long draft, attachments) and as the window is resized, and popups open
where their triggers are. The first message docks the composer at the pane's
foot (see Motion). Connect and failure keep it docked: there the stage's own
button is the next step, not the composer.

What belongs to the composer but is not the draft stands on it as a tray
risen from behind its top edge: 16 in from either side, the top corners
`rounded-2xl`, a hairline on three sides, `bg-card` a step more see-through
than the composer, tucked 8 under it. Attachments have one, and so do the
messages sent during a run (`QueueTray`, `views/Composer.tsx`): a 28pt line
each in `text-sm` `muted-foreground`, in the order they go, an icon saying
what each will do (steer, follow up), three at most and the rest counted.
The queue is taken back as one, so its pencil stands beside the lines, not
on one. The composer itself keeps its size: only the draft grows it.

The conversation ends 16 above the composer's top edge (`footOf`,
`views/Chat.tsx`), and the activity line's 36pt slot is the last thing in it:
a reply at rest stands 52 clear of the composer, and Pip, working, about 20.
"Jump to latest" stands on the same line, and rows fade out under it. The
edge is measured, not assumed: a tray, a longer draft or an inline prompt
raises it and all three with it, so nothing the composer grows by covers the
end of a reply.

## Elevation

Flat by default: regions are separated by background steps and hairlines.
Three shadows exist: `shadow-composer` (the composer; `COMPOSER_SURFACE` in
`ui/styles.ts`), `shadow-popover` (every anchored surface, always with
`border` and `bg-popover`; the recipe is `POPUP`), and `shadow-toast`
(toasts; `POPUP_TOAST`). The composer's is a tight contact shadow under a
wide, soft ambient one, with a half-point top highlight; focus deepens
both, never adds color. The toast's is the same family drawn tight — toasts
stack, and a wide shadow would fall on the card below. Toasts alone drop
the translucent glass fill for an opaque `bg-popover`: they float over the
scrolling transcript, and translucency lets the rows behind ghost through.

A floating layer — Settings, the command palette, the orchestration sheet,
the wallpaper adjuster, an extension's dialog — stands over one backdrop,
`SCRIM` in `ui/styles.ts`: the `scrim` tint and nothing else. A layer floats
over the window, so the window stays in sight behind it, dimmed but with its
shapes and words intact; the layer's own glass panel is what blurs, and only
under itself. The backdrop is never blurred: macOS draws a `backdropFilter` as
a system material whatever its radius, and nothing of the window is left to
see. No layer picks a backdrop of its own; a new one takes `SCRIM`.

## Wallpaper

A wallpaper is one picture laid once under the whole window
(`WallpaperUnderlay`, `views/Shell.tsx`). No region draws a copy of its own,
so the picture runs on from the sidebar into the pane and up behind the title
bar to the window's edge. Each region is a depth of the same glass over it:

| Region | Over the wallpaper |
|---|---|
| Sidebar | Frost: `SIDEBAR_GLASS` under `bg-sidebar/50`. Shapes survive; rows stay legible on a bright picture in dark and a dark one in light |
| Composer in the middle (welcome, starting) | The picture itself, the whole height of the pane, under a wash the same from either edge: 58% of `background` at the top and at the foot, 42% between. Under the figure in the middle it gathers once more — a pool, densest behind the words and gone before the pane's edges — so the title reads on a bright picture in dark and a dark one in light |
| Composer docked, nothing to read (connect, failed) | Over that wash, the page: from where the wash is thinnest, gone into solid `background` by 72% of the pane, before the composer |
| Conversation | Over both, the sidebar's frost again along the top (`PAGE_GLASS`), gone into `background` within 240pt: the reading column stands on the page's own color |
| Title bar | No band and no hairline: it stands on the pane's veil while a single top-to-bottom scroll mask fades conversation rows to transparent before they reach the bar. Windows and Linux draw no mask to fade rows out under it, so Windows keeps its glass band and Linux its solid band over a conversation |
| Composer, popups, Settings | Their own glass, unchanged |

The washes are gradients of the `background` token (`PaneVeil`,
`views/Wallpaper.tsx`), so they follow the appearance and a theme tinted from
the picture. They are eased at both ends: a linear ramp shows the line where
it starts and the line where it lands. The veil is the pane's page and lies
under the content that dims and lands on a session change, so the picture
never blinks. The page and a conversation's frost fade in over the first wash
in 200ms, and that wash stays: two layers cross-fading are each half there
midway and let the picture through where both are solid. Only the pool leaves
as the page comes — it lies where the page ends up all but solid. Linux draws
no backdrop filter: the sidebar and a conversation keep their solid fills
there, and the picture shows on the empty chat.

Over a wallpaper the project switcher under the composer is a capsule of the
composer's glass, not underlined words: words do not stand on a picture.

## Motion

| What | Duration | Easing |
|---|---|---|
| Hover / press color | 100ms | default |
| Popup, tooltip in and out | 100–150ms | `ease-out-quint`, from 97% scale |
| Disclosure & flow row in / out | ~265ms spring + 150–240ms fade/glide | `Reveal` (`Collapsible reveal`, scoped) |
| Inline indicator in / out | 150–180ms | `Presence` (opacity + 78% scale) |
| Toast entrance | 220ms | fade up |
| Session change: the chat left / landing | 120ms out / 200ms in | opacity only, the pane as one |
| Wallpaper veil: composer in the middle ↔ docked ↔ conversation | 200ms | opacity only, under the pane |
| Composer: the middle of the pane ↔ its dock | ~550ms | a spring with no bounce (`DOCK_SPRING`), played as keyframes; the stage it leaves fades where it stood in 140ms |
| Waiting on a session change | after 600ms, 480ms in | `PATIENCE_MS`; a change that lands sooner never shows it |
| "Working", "Thinking" and activity labels | breathing opacity | `useBreathingOpacity` (honors reduced motion) |
| Streamed text veil | 120–400ms | opacity only, zero offset |

Motion explains a change; nothing loops except Pip, a spinner, the active
breathing label, and the input caret.
Dynamic rows, sections, and status marks never pop in or vanish in one frame:
vertical stack items use `Reveal` (`ui/Reveal.tsx`, scoped `Collapsible reveal`
spring + opacity/glide so virtualized `List`s elsewhere never reflow; pass
`instant` when a draft row graduates in-place into its saved row), and
fixed-slot inline marks use `Presence` (`ui/Reveal.tsx`, opacity + scale on
both enter and exit).
The composer's trip between the middle of the pane and its dock is the one
long motion (`views/Chat.tsx`): it crosses a third of the window, and a short
one would be a jump. It is a transform, never `LayoutAnimation`. The layout
changes at once — the spacers over and under the composer — and in the same
turn an animated offset draws the composer where it was, then runs to zero.
So the list that mounts with the first message is laid out once and left
alone, and at rest nothing is transformed. The curve is the spring's own,
sampled (`Animated.sampleSpring`) and played as keyframes cut where it has all
but landed: the driver's spring over so long a way goes on well after it has
stopped on screen, and the app is not idle until it has (a send kept it busy
for two seconds). The stage does not ride down with the composer; it fades
where it stood. A trip interrupted — a new session opened mid-way — starts
from where the composer is.

A session change is one motion (`views/Chat.tsx`), and it answers the click,
not the agent. The sidebar and the title bar name the destination at once. The
chat shows it at once when it can — a conversation seen before comes back from
memory, a new session's empty chat needs no agent — and settles it in over
200ms. When it cannot, what is on screen dims out in 120ms and the destination
settles in the same way as it lands: a quick landing interrupts the dim-out and
reads as a dip, never a blank; a slow one is waited for on the empty pane, and
only past patience (600ms) with Pip. No state in between passes through — no
"waking" flash, no "No model" in the composer — and the composer takes typing
throughout: a message sent during the change goes where it lands. In the
sidebar, rows that slide under a resting pointer (a draft row opening or
closing above them) do not light up until the pointer moves.
Streaming never animates layout: text is committed to layout as it arrives and
newly arrived characters dissolve in through an opacity veil of at most 400ms
(Cadence: duration = clamp(gap-EMA × 3, 120, 400) — no positional
offset, each chunk fades once, text already on screen when a row attaches never
fades. The list follows the end only while the reader is at it; a scroll up
releases follow until they return to within 8pt. All motion honors reduced
motion.

## Components

`ui/` is the kit; `views/` composes it. Add a variant only when two screens
need it.

- **Button** (`primary` | `secondary` | `ghost` | `danger`; `sm` | `md` |
  `lg`). One primary per surface.
- **IconButton**: always has `label` (accessibility) and a tooltip with its
  shortcut.
- **Chip**: shows a current choice and opens something to change it.
- **Switch**, **Segmented** (`Tabs` native spring pill indicator), **TextField**.
- **SettingGroup / SettingRow / Rule**: titled card of ruled rows; label and
  help left, control right.
- **Icon**: one family, drawn for pipi on a 16pt grid, 1.5pt round stroke,
  colored by a theme `tone`.
- **AgentLogo**: another company's mark, drawn from their own art in a square
  (`ui/AgentLogo.tsx`). It is the one place brand colour is allowed: a mark
  paints in its `agent-*` token (DeepSeek blue, Qwen purple, Claude clay, Amp
  red, Kiro purple, the Gemini spark and Antigravity arch washes) and only
  while that CLI is present — an unavailable agent drops to `tone`, so a
  greyed row stays quiet. Companies whose marks have no colour of their own
  (OpenAI, Copilot, Cursor, Grok, OpenCode, Devin, Goose, Kimi, Hermes, Droid)
  stay monochrome in `tone`; Pi keeps its fixed pixel colours (`pi-coral`,
  `pi-blue`, `pi-yellow`).
- **Session row**: single-line (`h-7`, 28pt), leading with the engine's
  `AgentLogo` at 14, then the session title, and a trailing status slot
  (working Pip at 16 — a run kept going off screen marks every row the session
  has, in the workspaces tree and Recent alike — blocked `clock`, failed
  `alert`, or unread `brand` dot). Hover tooltips carry the engine name and
  workspace/branch; a row whose engine is gone greys the mark.
- **tip()**: the tooltip.
- **Reveal / Presence / FloatingLayer / ViewDeck** (`ui/Reveal.tsx`, re-exported from
  `ui/motion.ts`): the standardized enter + exit primitives for flow
  rows/sections and inline marks, plus `FloatingLayer` (in-window glass sheet
  over `SCRIM` with smooth mid-close reversal) and `ViewDeck` (keeps visited
  panes mounted at steady `opacity: 1` so switching sections never flashes or
  cold-remounts canvases).
- **Slash menu** (`views/Composer.tsx`, `lib/slash.ts`): a `/` that starts the
  draft — or what that key types under a Chinese input method (`、`, `／`) —
  lists what can be run from here. pipi is a shell over many engines, so the
  list has two parts. pipi's own commands come first (`appCommands` in
  `store/app.ts`): the same names on every engine, only actions the app already
  has, and only where the engine can do them (compaction and HTML export are
  Pi's RPC, so Pi alone lists them). Then the engine's own, under its name:
  Pi's prompts, skills and extensions, what Claude Code and ACP agents report
  through the bridge, and nothing for an engine that reports none. The shell
  owns the session, its name and the model, so the names engines give those
  are aliases of pipi's commands (`/clear` is `/new`, `/rename` is `/name`) and
  an engine's command of such a name is not offered: it would change the
  engine behind the conversation on screen. A row says what the command takes
  and whose it is; a name nothing answers to gets one line saying so, since
  the line then goes to the engine as written. Choosing a row (Enter, a
  press) runs it; Tab fills it in so arguments can follow; a command whose name
  alone does nothing (`/delegate`) is filled in either way, and offers what its
  first argument may be. Escape closes the menu before it does anything else,
  and leaves the draft. There is one mark: it follows the arrow keys, and the
  pointer once it moves. What the menu lists is what `send` runs — a name pipi
  owns is pipi's, and an engine's plumbing (`pipi-*`) is never listed. An
  engine's command is sent as written, never behind a pending handoff: the
  engine only knows it by its leading slash.

### Transcript rows

| Row | Look |
|---|---|
| User | Right-aligned bubble, `secondary`, max 70%; a message laid out past six lines folds to a preview that fades into a chevron at the bubble's foot — the press opens it, the chevron folds it back |
| Reply | Unboxed Markdown, selectable; newly arrived text dissolves in through an opacity veil (`RowVeil`) |
| Thinking | One line ("Thought for 4s" / "Thinking…"), collapsed by default; opens to quiet prose on a hairline |
| Tool call | One line: status mark, **verb**, target (mono for paths/commands), meta, diff badge; opens to sunken output or a diff |
| Shell (`!cmd`) | `Running` / `Ran` + mono command, output open by default |
| Notice | Card with icon; red tint only for errors |
| Summary / Delivery | A rule across the column with an icon and label; opens to the summary or delivered `<pipi-message>` answer |

Status mark: `brand` spinner (running), quiet tool/step icon (done), red cross
(failed). Diff badges use `success` / `destructive` for `+N` / `-N`.

## Voice

Short, plain, sentence case; title case for buttons and menu items. Say what
happened and what to do next ("Claude Code is not installed. Run `npm
install -g @anthropic-ai/claude-code`…"). No exclamation marks. Name the
engine driving the session — never "Pi" as a generic word for the agent.
"pipi" is this app; "Pip" is the mascot.

## Review

`nsh test Shots.test.tsx --target macos` renders every state in both
appearances to `.nsh/shots/`; `nsh test Gallery.test.tsx --target macos`
renders Pip's moods and the icon family; `nsh test WallpaperLook.test.tsx
--target macos` renders every surface a wallpaper reaches. Look at them before
merging UI work.

## Settings

Settings is a `FloatingLayer` over the chat: a glass panel centered in the
window over the backdrop every floating layer has (`SCRIM`, see Elevation): the
chat stays in sight behind it, dimmed, never blurred. Its own nav column on the
left (caption, six sections — General, Agents, Sessions, Archive, Usage, About —
using `Tabs`'s native sliding indicator) sits inside the panel alongside a
`ViewDeck` that keeps visited sections and subpages mounted at `opacity: 1` so
switching never flashes; Escape or a backdrop press closes it. The sections are the same whichever
agent is active: no agent gets a section of its own. What is particular to
one agent (Pi's providers and run knobs) is a page inside Agents, opened from
that agent's row and led back by the page's back button. The page keeps a ~640pt measure: a
title plus at most one line of lead, then `SettingGroup`s — filled
`bg-muted/50` cards, hairline-ruled rows, one short clause of description at
most, none when the title already says it.
