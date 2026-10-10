# The board

The board is what `render` writes to `sketch.html` and what `serve` shows live. This document is its design contract: the rooms, the design system and the behavior. The research, the owner's task model and the reason behind each choice are in [human-experience.md](human-experience.md); principles cited as P1 to P10 are its section 2.9. The bench that measures it is [human-bench.md](human-bench.md). Code follows this document; when they disagree, fix one of them in the same PR.

## What it is for

Tower Crane is a delegation tool, and the board is the owner's house in it. The owner is the commander of a run, an approver for decisions and an observer otherwise (human-experience.md 2.3, 2.6). So the board answers, in this order: does anything need me, is it moving, what changed, can I trust what was accepted, what is it costing, what is the shape of the plan. The orchestrator never reads the board: every fact on it comes from the state through the CLI's functions, and every write it makes is a CLI command through the same locked function and authority check (P10).

## Rooms

| Room | Path in serve | Fragment in the snapshot | Holds |
|---|---|---|---|
| Now | `/` | `#now` | the queue, the floor, what is next and what happened recently |
| Review | `/review` | `#review` | submitted work with the reviewer's verdict, gate receipts and send back; waivers behind accepted work |
| Plan | `/plan` | `#plan` | the dependency graph, and the same as layered lists on narrow screens |
| Spend | `/spend` | `#spend` | budgets, burn rate, projection, top spenders with their tier's median, and the usage tables |
| History | `/history` | `#history` | every event, newest first, by UTC day, with filters |
| Settings | `/settings` | (serve only) | the ladder and every task's tier |
| Task sheet | `#T7` over any room | `#T7` | everything about one task, with its controls |

The URL decides the room. A room fragment on a served page (`/#plan`) opens that room and becomes its path; nothing remembered in the browser overrides the URL. Only the routed room is displayed: after nav, a direct link, a sheet opened inside it, a cleared fragment and a live update. Without scripts the snapshot opens each room and sheet by its fragment.

Every page leads with the shell: the bar (mark, project, rooms with counts, how fresh the page is, the theme switch) and the lead (the status sentence and the spend line).

## The front room

- **Status sentence.** `6 need you (2 now) · 5 working · 46% budget`, in words from counts, each count a link to what it counts. Running agents whose usage is not known are counted aloud (`1 not counted`). The tab title repeats it.
- **Spend line.** Budget used as a length (tokens, and hours when set), the burn rate from running agents' own readings with its age, the projection, and the top spender with its tier's median.
- **The queue** (P1, P4). One list in two tiers, the tier in words at each item's left edge:
  - *Now* (alarm): a decision that blocks ready work, a runaway, a stuck claim (lease ran out, or the process exited without submitting), a budget at 90% or more.
  - *Your turn* (attention): other decisions, approvals, owner tasks, messages to the owner.

  Each item is self-contained: what it is, the question, the consequence ("Answering lets T15 Dashboard store start"), and the actions. Decision options are buttons with their own words, the recommended one marked in words, with a note field beside them. An approval reads as a sentence with the current and requested value ("orchestrator asks to change admin merges: off to on"), the change to make as a command, then I made the change and Decline; the recorded request is behind a disclosure. An empty queue is one calm line. Without the owner, items show the command for every option.
- **The floor** (P3). One row per claim, like a departure board: status glyph, task, claimant, rung and model, phase, lease as a length, usage, the latest word from the claimant with its age, and Message and Stop. Usage is in words when it is not a live number: `stale, 7 min old` with the last number dimmed, `usage unknown until exit`, `usage reported at exit`; never zero. A row whose rule trips keeps a marker and appears in the queue. Stop opens a confirmation in place that says what stops, how, what is kept and what follows; it sets the task's token budget to what it has spent, so the supervisor stops the agent at its next reading (`budget stop`), with no retry, and asks the owner to raise the budget. The row then says *stopping* and *stopped at its budget*, with the release command.
- **Next and recent.** Ready tasks (with what they unblock, and "ready once the expired claim is released" where that is true) and blocked tasks with their reasons; the digest of the newest events grouped by meaning (trouble, decisions, accepted, sent back, submitted, settings, messages, gates, started, plan), marked new since the browser last showed the board.

Layouts:

```
3840x1080   | Queue (2u)       | Floor (3u)                | Next | Recent (4u)   |
1920x1080   | Queue (1.5u)     | Floor (1.25u)             | Next, Recent (0.85u) |
1280x800    | Queue (1u)       | Floor (1u)                                      |
            |                  | Next and Recent as tabs                         |
            | a queue of four or more items spans both columns, in two columns   |
390x844     | sentence, spend line, queue, floor, then Next and Recent as tabs    |
```

The page scrolls as one; no band has a scroll area of its own.

## Runaway rules

Computed by `lib/runaway.js` on each read and never stored; `status` prints the same flags (`runaway: T1 agent: rule`). For each claim:

- **spend**: tokens above a multiple of the tier's median accepted-task spend. The multiple is the project's 90th percentile over its median once ten accepted tasks report tokens, and 5.5 (T70's window W) before. A tier median needs three accepted tasks; otherwise the project median is used.
- **rate**: tokens per minute over five minutes of live readings above the same multiple of the tier's median rate.
- **stale**: the live reading is older than T93's stale limit.
- **lease**: the lease ran out (with or without a live process).
- **progress**: the supervisor recorded `stall` and the claimant has written nothing since.
- **reworks**: sent back three or more times.

## Design system

Built for this board (human-experience.md 5.4); every value has a reason there.

**Type.** The platform UI face. Monospace only for what goes to a terminal: commands, SHAs, state keys in a command. Six steps: 12 (meta, the minimum), 13 (dense rows), 15 (body), 17 (item titles), 21 (room titles), 28 (the status sentence). Weights 400, 500 and 650. Line height 1.5 for text, 1.25 for titles; prose measure 64ch.

**Color.** A warm neutral ground and three hues with one meaning each: attention (amber, a person is needed), alarm (red, failed or must stop now), live (blue, an agent is working). No success green: a pass is ink with a check and a receipt (P5). Both themes are designed (P8); the theme follows `prefers-color-scheme`, and the switch in the bar stores light or dark in the browser.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ground` | `#f4f3ef` | `#111215` | page |
| `--surface` | `#ffffff` | `#191b1f` | rows, items, rooms |
| `--surface-2` | `#ecebe6` | `#212429` | sunken areas, table heads |
| `--line` | `#dcdad3` | `#2c3036` | dividers |
| `--line-strong` | `#8f8b82` | `#6a717b` | control borders, bars, graph edges |
| `--text` | `#1a1916` | `#eceae6` | primary text |
| `--text-2` | `#45423b` | `#bab8b1` | secondary text |
| `--text-3` | `#5f5b53` | `#96938c` | meta, times |
| `--attn` | `#f2b705` | `#f2b705` | Your-turn fill |
| `--on-attn` | `#1a1916` | `#1a1916` | text on the attention fill |
| `--attn-ink` | `#7a5100` | `#f4c64a` | attention as text or edge |
| `--attn-wash` | `#fdf3d6` | `#2f2712` | Your-turn item tint, waivers |
| `--alarm` | `#b0261c` | `#ff8b7b` | Now: text, edges, Stop |
| `--on-alarm` | `#ffffff` | `#1a1916` | text on the alarm fill |
| `--alarm-wash` | `#fbeae7` | `#351b18` | Now item tint, failed receipts |
| `--live` | `#0a5fae` | `#7cb5ff` | an agent at work: glyph, lease, spark |
| `--live-wash` | `#e7f0fa` | `#15263a` | the change wash |
| `--focus` | `#0a5fae` | `#7cb5ff` | focus ring, 2 px with a 2 px offset |

**Hierarchy.** Three levels per room: its sentence or title, item titles, everything else. Each kind has its own silhouette: queue items are full-width plates with the tier at the left edge, agent rows are lines with columns and a live edge, review rows are rooms of their own with a verdict line, gate receipts are two-column lines.

**Glyphs.** A shape and a word for every status, never color alone; the queue adds a filled triangle (Now), a filled square (Your turn), a gauge (runaway) and a stop square. Gate receipts: a check (passed), a cross (failed), a dashed circle (not yet run), an amber square (waived).

**Space and shape.** A 4 px grid (4, 8, 12, 16, 24, 32, 48). Radius 6 for items and controls, 10 for rooms. Buttons at least 32 px tall, other targets at least 24 px. Elevation only for the task sheet and the in-place panels of an agent row (Message, Stop).

**Motion.** Motion reports change and nothing else (P6): a new queue item slides in over 200 ms and its tier pulses once, a changed item washes from `--live-wash` over 1200 ms, the stop confirmation opens in 160 ms. No perpetual animation: liveness is the words `Live, updated 12 s ago`. `prefers-reduced-motion: reduce` removes all motion.

## Keyboard

`n`, `r`, `p`, `s`, `h` open the rooms; Tab reaches every action in reading order with a visible ring; arrow keys move between the Next and Recent tabs; Escape closes an open Message or Stop panel and returns to its button, and closes a task sheet and returns focus to the link that opened it. A sheet holds focus and makes the page behind it inert.

## Live behavior

serve pushes a `reload` event when the state changes; the page fetches itself and replaces only the parts that changed, marking them. A part holding a form with focus or typed text waits until the form is sent or cleared, and the page says so. Focus, disclosures and every scroll position survive through server-rendered `data-preserve` identities (docs/cli.md, Views). After an answer from the queue, focus moves to the next item. The status sentence, the Now count, the Needs you heading, the title and the icon share one count.

## What the board does not do

It never accepts, merges, waives, claims, releases, submits, records evidence or edits the plan; it shows the command where it helps. It never invents a second path to a change: each control posts to a route that runs one CLI command (docs/cli.md, Board writes). It never shows money: the state has no prices. It never shows a stale or unknown usage reading as zero.
