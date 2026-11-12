# pipi design

pipi is a quiet, precise desktop tool with one loud thing in it: Pip. The
interface is near-monochrome so that the conversation carries the screen; the
brand color appears only where Pip is, where the caret is, and on the one
primary action of a surface.

Sources of truth: `theme.json` (color, radius), `nsh.json` → `tailwind` (type
scale, shadows, easing), `ui/styles.ts` (shared class recipes),
`mascot/geometry.ts` (Pip). This document explains them; when they disagree,
the files win and this document is wrong.

## Principles

1. **Content first.** Replies are unboxed prose on the background. Only what
   the user said (a bubble) and what a machine printed (a sunken block) get a
   container.
2. **One accent, spent rarely.** Pitaya marks Pip, the caret, links, and the
   primary button. Never a decoration, never a status.
3. **A turn is a unit.** Steps of one turn sit 4pt apart; turns sit 28pt apart.
   Spacing says what belongs together before any line or box does.
4. **State is visible, motion is short.** Every pressable has hover, pressed,
   focus and disabled looks. Nothing animates longer than 220ms except Pip.
5. **Symbols over words.** An unambiguous icon replaces a visible label; the
   word moves to the tooltip and accessibility label. Text that restates what
   is already on screen is deleted.
6. **Only what the active engine can do.** Every control maps to a documented
   capability of the harness driving the session — for Pi, an RPC command or
   file in `docs/pi/`; for the rest, whatever the bridge exposes. No invented
   capabilities.

## Pip, the mascot

Pip is the letter π that stood up: one slab (π's bar: head and body at once),
two legs, a toe that kicks right (π's hook, and the direction Pip walks), and
two ink eyes. Not a person, not an animal, not a robot.

### Construction

Drawn on a 64-unit grid; every key edge sits on a multiple of 4, so the
silhouette lands on whole pixels at 16px (4 units = 1px). The art fills the
grid's width and the band y 12–52: aspect 8:5.

| Part | Shape | x, y, w, h | Radius |
|---|---|---|---|
| Slab | rounded rect | 0, 12, 64, 24 | 10 |
| Left leg | rect, round bottom | 12, 30, 12, 22 | 0 0 5 5 |
| Right leg | rect, round bottom | 40, 30, 12, 22 | 0 0 5 5 |
| Toe | rounded rect | 44, 44, 16, 8 | 4 |
| Eyes (idle) | pills, centers (21, 24) and (43, 24) | 7 × 11 | full |

Legs overlap the slab by 6 units so joins never show a seam.

### Color

| Token | Value | Use |
|---|---|---|
| `brand` | `#F2348A` (pitaya) | The body. Same in light and dark. |
| `ink` | `#1B0F17` | The eyes. Same in light and dark. |

Pip is never recolored, outlined, given a gradient, or drawn in monochrome.
On the app icon Pip stands on an aubergine tile (`#2E2233` → `#130E16`).

### Moods

Only the eyes and the motion change; the silhouette never does.

| Mood | Eyes | Motion | When |
|---|---|---|---|
| `idle` | tall pills | breathes (3.6s), blinks every 3–6s | Ready |
| `think` | round, up and toward the toe | floats and tilts (2.2s) | Model is reasoning |
| `work` | tall pills | legs alternate, body bobs (0.62s) | A tool runs |
| `write` | looking down | quick small steps (0.3s) | Reply streams |
| `happy` | upward arcs | one squash-and-jump (0.62s) | A run ended well |
| `error` | crosses | one head shake | A run failed |
| `sleep` | flat lines | slow breath (4.2s) | Starting; empty lists |

`store/app.ts` → `pipMood` is the only place app state becomes a mood.

### Rules

- Minimum size 16px wide. Below 24px use `still` (no loops) unless Pip *is*
  the status indicator (activity line, running session row).
- Clear space: one leg-width (12 units) on every side.
- One animated Pip per surface; the sidebar carries one per working session.
  Pip never overlaps text and never talks.
- With reduced motion Pip holds the mood's pose and does not move.

### Where Pip lives

| Place | Size | Mood |
|---|---|---|
| App icon (`icon.png`) | 560 of 1024 | idle |
| Welcome / connect / failure stage | 80–96 | from `pipMood` |
| Activity line under the transcript | 22 | from `pipMood` |
| Running session in the sidebar — every row the run has, and a folded project row hiding one | 16 | work |
| Sub-agents bar | 16 | work |
| Empty session list, empty model list | 40–48, still | sleep |
| About | 88 | idle |

### Files

- `mascot/geometry.ts`: the shapes as data. No imports; the single source.
- `mascot/Pip.tsx`: the in-app canvas. Everything that moves is an animated
  value read on the UI thread; no app code runs per frame.
- `scripts/render-brand.mjs`: `node scripts/render-brand.mjs` regenerates
  `icon.png`, `assets/brand/*.svg` and size proofs in `assets/brand/proof/`.

## Color

Semantic tokens only; no hex or palette classes in components. Neutrals carry
a faint aubergine tint (hue 315–330) so they sit with the pitaya.

| Token | Role |
|---|---|
| `background` / `foreground` | The main pane and its text |
| `sidebar*` | The left column: one step darker (dark) or greyer (light) |
| `card` | Grouped surfaces: composer, settings groups, notices |
| `popover` | Anchored surfaces: menus, pickers, palette, toasts, tooltips |
| `sunken` | Machine output: code, tool results |
| `secondary` | The user's bubble; quiet buttons |
| `muted-foreground` → `subtle` | Secondary text → tertiary (captions, hints) |
| `accent` | Hover and keyboard highlight of rows |
| `border` / `input` | Hairlines / control outlines |
| `brand`, `brand-text`, `brand-soft` | Accent fill / accent as text / tint |
| `success`, `warning`, `destructive` | Only for their meanings |
| `scrim` | Behind modal dialogs |

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

| Thing | Size |
|---|---|
| Title bar | 44 |
| Sidebar | 264 wide |
| Reading column | max 760 |
| Row, large button, text field | 32 |
| Session row in the sidebar, two lines | 50 |
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

## Elevation

Flat by default: regions are separated by background steps and hairlines.
Two shadows exist: `shadow-composer` (the composer; `COMPOSER_SURFACE` in
`ui/styles.ts`) and `shadow-popover` (every anchored or floating surface,
always with `border` and `bg-popover`; the recipe is `POPUP`). The composer's
is a tight contact shadow under a wide, soft ambient one, with a half-point
top highlight; focus deepens both, never adds color.

## Motion

| What | Duration | Easing |
|---|---|---|
| Hover / press color | 100ms | default |
| Popup, tooltip in and out | 100–150ms | `ease-out-quint`, from 97% scale |
| Disclosure & flow row in / out | ~265ms spring + 150–240ms fade/glide | `Reveal` (`Collapsible reveal`, scoped) |
| Inline indicator in / out | 150–180ms | `Presence` (opacity + 78% scale) |
| Toast entrance | 220ms | fade up |
| Streaming caret, "Thinking" label | pulse | `motion-safe:` only |
| Streamed text veil | 120–400ms | opacity only, zero offset |

Motion explains a change; nothing loops except Pip, a spinner and the caret.
Dynamic rows, sections, and status marks never pop in or vanish in one frame:
vertical stack items use `Reveal` (`ui/Reveal.tsx`, scoped `Collapsible reveal`
spring + opacity/glide so virtualized `List`s elsewhere never reflow; pass
`instant` when a draft row graduates in-place into its saved row), and
fixed-slot inline marks use `Presence` (`ui/Reveal.tsx`, opacity + scale on
both enter and exit).
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
- **Switch**, **Segmented**, **TextField**.
- **SettingGroup / SettingRow / Rule**: titled card of ruled rows; label and
  help left, control right.
- **Icon**: one family, drawn for pipi on a 16pt grid, 1.5pt round stroke,
  colored by a theme `tone`.
- **AgentLogo**: another company's mark, drawn from their own art in a square
  (`ui/AgentLogo.tsx`). It is the one place brand colour is allowed: a mark
  paints in its `agent-*` token (DeepSeek blue, Qwen purple, Claude clay, the
  Gemini spark's wash, Kiro purple) and only while that CLI is present — an
  unavailable agent drops to `tone`, so a greyed row stays quiet. Companies
  whose marks have no colour of their own (OpenAI, Copilot, Cursor, Grok,
  OpenCode, Pi) stay monochrome in `tone`; Pi keeps its fixed pixel colours.
- **Session row**: two lines, because a transcript is worth knowing the origin
  of before you open it. The title takes the first line with the running mark
  (the working Pip — a run kept going off screen marks every row the session
  has, in the workspaces tree and Recent alike); the second is the engine —
  its `AgentLogo` at 14, its name in `2xs` `subtle` — with the relative time
  trailing. A row whose engine is gone keeps the name and greys the mark.
- **tip()**: the tooltip.
- **Reveal / Presence** (`ui/Reveal.tsx`, re-exported from `ui/motion.ts`): the
  standardized enter + exit primitives for flow rows/sections and inline marks.

### Transcript rows

| Row | Look |
|---|---|
| User | Right-aligned bubble, `secondary`, max 70% |
| Reply | Unboxed Markdown, selectable, streams with a brand caret |
| Thinking | One line: sparkle + "Thought for 4s"; collapsed by default, the reader opens it |
| Tool call | One line: status mark, tool icon, **name**, mono summary; opens to sunken output or a diff |
| Shell (`!cmd`) | `$ command`, output open by default |
| Notice | Card with icon; red tint only for errors |
| Summary | A rule across the column with a label; opens to the summary |

Status mark: spinner (running), check (done, quiet), red cross (failed).
Success is never green; only failure gets color.

## Voice

Short, plain, sentence case; title case for buttons and menu items. Say what
happened and what to do next ("Claude Code is not installed. Run `npm
install -g @anthropic-ai/claude-code`…"). No exclamation marks. Name the
engine driving the session — never "Pi" as a generic word for the agent.
"pipi" is this app; "Pip" is the mascot.

## Review

`nsh test Shots.test.tsx --target macos` renders every state in both
appearances to `.nsh/shots/`; `nsh test Gallery.test.tsx --target macos`
renders Pip's moods and the icon family. Look at them before merging UI work.

## Settings

Settings is a floating layer over the chat: a glass `Dialog` panel centered
in the window over a backdrop that blurs, never dims, what's behind it. Its own nav
column on the left (caption, five sections — General, Providers, Agents,
Session, About) sits inside the panel;
Escape or a backdrop press closes it. The page keeps a ~640pt measure: a
title plus at most one line of lead, then `SettingGroup`s — filled
`bg-muted/50` cards, hairline-ruled rows, one short clause of description at
most, none when the title already says it.
