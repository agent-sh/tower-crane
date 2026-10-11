# The human bench

Tower Crane benches what agents do. This page benches what the owner does on the board: the jobs of [human-experience.md](human-experience.md) section 3, as the timed scenarios and checks of its section 6, run on the board before and after T79's redesign. The code is `test/bench/`; the results below are generated from its output by `test/bench/report.js`.

## Method

**Builds.** *Before* is the board T79 started from: `76d484d`, T93's live-spend head with main merged (T70's research included), extracted with `git archive`. *After* is this branch with main merged (T89's approvals, `interrupt`, T91's Controls and `project set --paused`, T93 and the owner key all on main). The before build has no Controls page and no pause command, so Controls and H4p have no before result. Both serve the same fixtures; each build builds its own fixtures with its own CLI.

**Fixtures** (`test/bench/fixtures.js`). Scratch states built through the CLI, so they stay valid as the state format changes. Commands run on a moved clock (`test/fixtures/hooks.js`), which gives events, leases and decisions the ages a real run has. The owner presents a fixture owner key, as the tests do. Each review verdict follows a recorded reviewer dispatch that ran and exited, the one event the CLI cannot write (`h.reviewer` in the tests), so the verdict counts and `accept` dispatches no real reviewer; review evidence names the task's revision where the CLI takes `--revision`. No fixture touches a live state directory.

- *busy*: `webhooks v2`, 26 tasks. Twelve accepted tasks with recorded usage, shaped like T70's window W (the 90th percentile of tokens per task is about 5 times the median); two decisions, one blocking ready work; an owner-required `merge.admin` request the orchestrator made, which the engine turned into an approval; an owner task; five agents at work and one claim whose lease ran out; a submitted task whose review failed after one rework; an accepted task whose gates the owner waived; a message to the owner.
- *calm*: accepted history, two agents at work, nothing for the owner.
- *runaway*: the same history, then one easy task dispatched through `spawn` to T93's stub harness (`test/fixtures/live-usage-harness.js`), which writes 1M tokens a second to its own session file. Only the live collector puts spend into state. Variants: *stale* (the stub writes twice and the bench then stops the supervisor, so no new reading arrives while the agent runs) and *unavailable* (a command harness, which has no live usage).
- *budget*: the runaway history with a token budget sized so the project is at 92% once the stub has written its 2.4M tokens.

**Driver** (`test/bench/driver.js`). Headless Chrome from `test/browser.js`, with input through Chrome's own pipeline: `Input.dispatchMouseEvent` at the target's center and `Input.dispatchKeyEvent`, never page functions. A target outside the viewport is reached with the wheel over its scroll container, and the distance is recorded. Every input, the pointer travel, the target sizes and the wall time are recorded, and each scenario ends with a check of the state through the CLI files (`decisions.json`, `tasks.json`, `events.jsonl`). Page reads take their selectors and values as protocol arguments (`Runtime.callFunctionOn`), never as text spliced into page code. Screenshots are WebP. serve runs as the owner on the scratch states, with the same clean environment the board tests use.

**Timing.** Three numbers per scenario:

- the interaction count: clicks, keys and scrolls on the shortest path;
- the Keystroke-Level Model prediction, a floor for expert, error-free work, from Card, Moran and Newell's operators (s25 in [research/T70.json](../research/T70.json)): K 0.28 s ("average non-secretary typist"), P 1.1 s, B 0.1 s per press or release, H 0.4 s, M 1.35 s before each decision. A wheel notch counts as a K, with an M to find the place again after each scroll. Where a pass bar says "plus typing", it is held against the prediction without the typed characters;
- the owner's measured time, median of three cold runs. This bench is run by an agent, so that number is not in this report; it is the owner's run (see Limits).

**Checks** (`test/bench/checks.js`), from computed styles and Chrome's accessibility tree:

- *Contrast*: every visible text node against its effective background (ancestors' backgrounds blended), with the WCAG formula; 4.5:1, or 3:1 for 24 px or 18.66 px bold.
- *Color alone*: every status glyph has an accessible name or sits beside its status word.
- *Targets*: WCAG 2.5.8, 24 by 24 px or spaced so 24 px circles do not meet, inline links in a sentence exempt; buttons 32 px tall.
- *Names*: one `h1`, `main`, `nav` and a header, a polite live region, and no unnamed control in the accessibility tree.
- *Readability*: smallest text 12 px, at most six sizes, body text 15 px, a full line at most 80 characters (the text's own width against its line box), no clipped text, no sideways page scroll.
- *Motion*: running animations after load, with `prefers-reduced-motion: reduce`.
- *One room at a time*: for every room, by nav, direct link, a sheet opened inside it, a cleared fragment and a live update, exactly the routed room is displayed and its top is in the first viewport.
- *Density*: at 3840x1080, the share of a grid of points in the first viewport that lands on text, a control or a drawn item (not a band's own background).

## Results

<!-- results -->

| # | Scenario | Before | After |
|---|---|---|---|
| H1 | Find what needs me, 3840x1080 | 3/6 in view, title 5/6, KLM 7.59 s, fail | 6/6 in view, title 6/6, KLM 1.35 s, pass |
| H1 | Find what needs me, 1920x1080 | 3/6 in view, title 5/6, KLM 7.59 s, fail | 6/6 in view, title 6/6, KLM 1.35 s, pass |
| H1 | Find what needs me, 1280x800 | 1/6 in view, title 5/6, KLM 10.85 s, fail | 6/6 in view, title 6/6, KLM 1.35 s, pass |
| H1 | Find what needs me, 390x844 (count and first item) | 2/6 in view, title 5/6, KLM 1.35 s, fail | 1/6 in view, title 6/6, KLM 1.35 s, pass |
| H2 | Answer a decision with a note | 3 clicks, 0 scrolls, KLM 8.75 s without typing, focus after: BODY, fail | 1 click, 1 key, 0 scrolls, KLM 4.68 s without typing, focus after: stuck-T25-lease, pass |
| H2 | Decision controls in the first viewport, 3840x1080 | 2 of 2 themes without a scroll, pass | 2 of 2 themes without a scroll, pass |
| H2 | Decision controls in the first viewport, 1920x1080 | 2 of 2 themes without a scroll, pass | 2 of 2 themes without a scroll, pass |
| H2 | Decision controls in the first viewport, 1280x800 | 2 of 2 themes without a scroll, pass | 2 of 2 themes without a scroll, pass |
| H2a | Approve a change | sentence fail, raw JSON shown; approve: no path, fail | sentence pass, raw JSON behind a disclosure; 1 click, answer approve from the board; applied yes by the orchestrator's retry (setting event cli, approved_by D3), pass |
| H3 | Judge a review and send it back | 3 clicks, 3 scrolls, KLM 14.99 s without typing, 711 px scrolled, fail | 3 clicks, 0 scrolls, KLM 10.1 s without typing, 0 px scrolled, pass |
| H4 | Stop a runaway | spend rose before exit: yes; flagged: no; stop: no path, fail | spend rose before exit: yes; flagged: yes, 152 ms after the rule's threshold; stop: 1 click, 1 key, KLM 4.68 s, stopped with no retry; recorded 10000000 of the stub's 10000000, pass |
| H4s | Lost telemetry: stale | state in words: no; drawn as zero: no; Now item: no; sentence says not counted: no, fail | state in words: yes; drawn as zero: no; Now item: yes; sentence says not counted: yes, pass |
| H4s | Lost telemetry: unavailable | state in words: no; drawn as zero: no; Now item: no; sentence says not counted: no, fail | state in words: yes; drawn as zero: no; Now item: no; sentence says not counted: yes, pass |
| H4p | Pause dispatch | no path: the board has no pause control, fail | 1 click, 1 key, KLM 4.68 s without typing; sentence leads: yes; project show: yes; claim refused: yes; floor kept: yes; resumed: yes, pass |
| H5 | See spend, 3840x1080 | used shown, rate not shown, projection not shown, top not shown; freshness shown, fail | used shown, rate shown, projection shown, top shown; freshness shown, pass |
| H5 | See spend, 1920x1080 | used shown, rate not shown, projection not shown, top not shown; freshness shown, fail | used shown, rate shown, projection shown, top shown; freshness shown, pass |
| H5 | See spend, 1280x800 | used shown, rate not shown, projection not shown, top not shown; freshness shown, fail | used shown, rate shown, projection shown, top shown; freshness shown, pass |
| H5 | See spend, 390x844 (in the Now room) | used in the room, rate not shown, projection not shown, top not shown; freshness shown, fail | used shown, rate shown, projection shown, top shown; freshness shown, pass |
| H6 | Steer an agent | no path: the board reaches the orchestrator only (task comment); msg --to the agent is CLI-only, fail | 1 click, 1 key, 0 scrolls, KLM 4.68 s without typing, pass |
| H7 | Return after absence | named 6 of 6; grouped by meaning: no; heading contradicts: no, fail | named 6 of 6; grouped by meaning: yes; heading contradicts: no, pass |
| H8 | Calm run, light and dark | alarm or attention hue: 0/0; motion after load: 1/1 (breathe on conn); says nothing needs you: yes, fail | alarm or attention hue: 0/0; motion after load: 0/0; says nothing needs you: yes, pass |
| H9 | Mode parity (H2, H3, H4p, H6) | compared H2, H3; mismatches 0; no board path: H4p, H6, pass | compared H2, H3, H6, H4p; mismatches 0, pass |

Checks on the front room with the busy run, per size and theme (failures of checked):

| Build | Size, theme | Contrast | Color alone | Targets | Names | Readability | Density |
|---|---|---|---|---|---|---|---|
| before | 3840x1080 light | 0 of 296 | 7 of 20 | 0 of 67, 0 short buttons | 0 unnamed, 1 h1 | 6 sizes (11, 12, 13, 14, 16, 20), min 11, 7% under 12 px, 0 clipped, 1 long lines | 63.9% |
| before | 3840x1080 dark | 0 of 296 | 7 of 20 | 0 of 67, 0 short buttons | 0 unnamed, 1 h1 | 6 sizes (11, 12, 13, 14, 16, 20), min 11, 7% under 12 px, 0 clipped, 1 long lines | 63.9% |
| before | 1920x1080 light | 0 of 250 | 7 of 20 | 0 of 60, 0 short buttons | 0 unnamed, 1 h1 | 6 sizes (11, 12, 13, 14, 16, 20), min 11, 5.6% under 12 px, 0 clipped, 0 long lines | - |
| before | 1920x1080 dark | 0 of 250 | 7 of 20 | 0 of 60, 0 short buttons | 0 unnamed, 1 h1 | 6 sizes (11, 12, 13, 14, 16, 20), min 11, 5.6% under 12 px, 0 clipped, 0 long lines | - |
| before | 1280x800 light | 0 of 198 | 7 of 20 | 1 of 43, 0 short buttons | 0 unnamed, 1 h1 | 6 sizes (11, 12, 13, 14, 16, 20), min 11, 5% under 12 px, 0 clipped, 0 long lines | - |
| before | 1280x800 dark | 0 of 198 | 7 of 20 | 1 of 43, 0 short buttons | 0 unnamed, 1 h1 | 6 sizes (11, 12, 13, 14, 16, 20), min 11, 5% under 12 px, 0 clipped, 0 long lines | - |
| before | 390x844 light | 0 of 58 | 7 of 20 | 0 of 20, 0 short buttons | 0 unnamed, 1 h1 | 6 sizes (11, 12, 13, 14, 16, 20), min 11, 0.8% under 12 px, 0 clipped, 0 long lines | - |
| before | 390x844 dark | 0 of 58 | 7 of 20 | 0 of 20, 0 short buttons | 0 unnamed, 1 h1 | 6 sizes (11, 12, 13, 14, 16, 20), min 11, 0.8% under 12 px, 0 clipped, 0 long lines | - |
| after | 3840x1080 light | 0 of 200 | 0 of 20 | 0 of 78, 0 short buttons | 0 unnamed, 1 h1 | 5 sizes (12, 13, 15, 17, 28), min 12, 0% under 12 px, 0 clipped, 0 long lines | 77.1% |
| after | 3840x1080 dark | 0 of 200 | 0 of 20 | 0 of 78, 0 short buttons | 0 unnamed, 1 h1 | 5 sizes (12, 13, 15, 17, 28), min 12, 0% under 12 px, 0 clipped, 0 long lines | 77.1% |
| after | 1920x1080 light | 0 of 200 | 0 of 20 | 0 of 78, 0 short buttons | 0 unnamed, 1 h1 | 5 sizes (12, 13, 15, 17, 28), min 12, 0% under 12 px, 0 clipped, 0 long lines | - |
| after | 1920x1080 dark | 0 of 200 | 0 of 20 | 0 of 78, 0 short buttons | 0 unnamed, 1 h1 | 5 sizes (12, 13, 15, 17, 28), min 12, 0% under 12 px, 0 clipped, 0 long lines | - |
| after | 1280x800 light | 0 of 125 | 0 of 20 | 0 of 51, 0 short buttons | 0 unnamed, 1 h1 | 5 sizes (12, 13, 15, 17, 28), min 12, 0% under 12 px, 0 clipped, 0 long lines | - |
| after | 1280x800 dark | 0 of 125 | 0 of 20 | 0 of 51, 0 short buttons | 0 unnamed, 1 h1 | 5 sizes (12, 13, 15, 17, 28), min 12, 0% under 12 px, 0 clipped, 0 long lines | - |
| after | 390x844 light | 0 of 59 | 0 of 20 | 0 of 24, 0 short buttons | 0 unnamed, 1 h1 | 5 sizes (12, 13, 15, 17, 21), min 12, 0% under 12 px, 0 clipped, 0 long lines | - |
| after | 390x844 dark | 0 of 59 | 0 of 20 | 0 of 24, 0 short buttons | 0 unnamed, 1 h1 | 5 sizes (12, 13, 15, 17, 21), min 12, 0% under 12 px, 0 clipped, 0 long lines | - |

The other rooms, a task sheet, Settings and Controls, at all four sizes in both themes (checks passed of run):

| Room | Before | After |
|---|---|---|
| Plan | 32 of 40 (fails: readability) | 40 of 40 |
| Spend | 32 of 40 (fails: readability) | 40 of 40 |
| History | 32 of 40 (fails: readability) | 40 of 40 |
| Task sheet | 24 of 40 (fails: color alone, readability) | 40 of 40 |
| Settings | 32 of 40 (fails: readability) | 40 of 40 |
| Review | no such room | 40 of 40 |
| Controls | no such room | 40 of 40 |

| Check | Before | After |
|---|---|---|
| Keyboard: H2 and H6 actions reached by Tab with a ring; Escape closes a sheet and returns focus | 1 of 2 (missing: form[data-api='/api/decisions/D1/answer'] input[name='note']); sheet ok, fail | 3 of 3 in 48 tabs; sheet ok, pass |
| One room at a time, 1920x1080: nav, direct link, sheet inside, cleared fragment, live update | 20 of 20, pass | 25 of 25, pass |
| One room at a time, 390x844: nav, direct link, sheet inside, cleared fragment, live update | 20 of 20, pass | 25 of 25, pass |
| Reduced motion: running animations after load | 0, pass | 0, pass |

Runs: before 2026-10-11 21:49Z on `before-tree`, after 2026-10-11 22:18Z. Errors recorded: before 0, after 0.

<!-- /results -->

## What the numbers say

- **Find what needs me.** Before, the old board's needs column showed half of the six items in the first viewport at 1920 and 3840 and one at 1280x800, and its tab count left out the stuck claim. After, every item is in the first viewport at all three desktop sizes, the title carries the full count, and the prediction drops to one M. At mid widths a queue longer than three items takes the full width in two columns, ahead of the floor. On a phone the bar is the count and the first item: the first viewport holds the sentence, the spend line and one queue item (1 of 6, against 2 of 6 before, whose items were smaller and carried less); the prediction is the same one M.
- **Decide.** The note field is beside the option buttons instead of behind a disclosure, and Enter in it answers the recommended option: one click into the field, the note, then Enter (M P B B H, type, M K), 4.68 s without typing against the 6 s bar, and focus lands on the next queue item. The decision's controls are in the first viewport at all three desktop sizes in both themes, with no scroll. The mouse path, clicking the option after typing, is 6.1 s and still misses the bar; a decision with no recommendation has only that path, since Enter answers nothing there. The bench found two defects on the way: Enter in the note submitted the form with its first option (the browser's implicit submission, which would have answered `redis`), and a second submission while the first was sending posted an empty form, whose refusal dropped the focus move. Both are fixed and are assertions in `test/board.test.js`.
- **Judge a review.** The finding, the gate receipts and the send-back field are on one Review row: no scrolling, against 711 px and three scrolls before.
- **Approve a change.** Before, the request was raw JSON and approving it meant making the change at the terminal. After, it reads as a sentence, and Approve is one click: the owner's `approve` from the board, then the orchestrator's retry of its command applies the recorded change once, with a `setting` event that names the decision in `approved_by`. T70's bar asked for that setting event in `mode: board`; under main's authority model the orchestrator makes the change after the owner approves, so it is `mode: cli`. The owner can still make the change themselves from the item's command, which answers the request too.
- **Stop a runaway.** Before, the live spend rose on the card but nothing flagged it and the board had no way to stop it. After, the spend rule (`lib/runaway.js`, the same flags `status` prints) puts it in the queue as a Now item well under a second after the live total crosses the rule. Stop on its row opens the confirmation with the cursor in its reason field, and Enter there confirms: one click and one key (M P B B, M H K), 4.68 s against the 5 s bar, through `interrupt`, with no retry. The same write sets an owner ask, so dispatch does not restart the task; the row reads *stopped, waiting on you* with Resume (`owner-done`). After exit the recorded spend matches the stub's own total (10M of 10M).
- **Pause dispatch.** Before, the board had no pause. After, `Pause dispatch` sits beside the status sentence; opening it puts the cursor in its reason field and Enter pauses: one click and one key plus typing, 4.68 s without typing, against T70's bar of two actions plus typing. The sentence and the tab title then lead with `Paused: owner is inspecting the run`, `project show` reports the reason, a new `claim` is refused, every agent row stays on the floor, and `Resume dispatch` clears it. The same command from the CLI gives the same state and `setting` event, apart from `mode` (H9). Ready work stays listed as ready, held by the pause, so the pause is named once and not as every blocked task's reason.
- **Lost telemetry and spend.** A stale reading and an unavailable one are drawn in words, never as zero, and the status sentence counts the agents it cannot count. The bench found that an open page never aged a reading that stopped arriving, because nothing changed on disk; the page now ages live readings and asks for a fresh render once one passes its stale limit, which raises the Now item. Budget used, burn rate, projection and the top spender are on every page's spend line, with how fresh the live number is, in the first viewport at all four sizes; on a phone that is the Now room, where T70's bar allows one tab. Before, only the used total was on the primary screen, and on a phone it was below the first viewport.
- **Steer.** The agent row's Message reaches the claimant through `msg`; before there was no board path to an agent. Opening Message puts the cursor in its field, so the path is one click, the text, then Enter: two actions plus typing, the bar, at 4.68 s without typing.
- **Readability and calm.** Before, the front room used six sizes from 11 px, with 5 to 7% of its text under 12 px, and every other room failed a readability check. After, every room, the task sheet, Settings and Controls pass at all four sizes in both themes: five sizes from 12 px (12, 13, 15, 17 and 28, with 21 for room titles), body text 15 px, no line over 80 characters, no clipped text. The clipping check now also measures the text inside inputs and selects against their own box, which found Settings' effort, harness and placeholder values cut off and a decision note's placeholder cut off on a phone; both fit now. Status glyphs that relied on color alone went from 7 of 20 to none. The calm run shows no alarm or attention hue and no motion; the old breathing dot is gone.

## Limits

- **Controls keeps T91's groups.** Controls is drawn in the board's system, but its forms keep T91's grouping (project, agents, tasks) and Settings stays its own page; T70's grouping by intent (human-experience.md 5.1) is not built, so no scenario measures it.
- **No measured human time.** The owner runs each scenario on the after build, cold, three times; the bench does not stand in for that.
- **No large-plan fixture.** The 200-task, 20,000-event fixture of the plan was not run: every CLI write re-renders the board under the lock, so building it through the CLI takes most of an hour. Plan rendering at that size is not measured here.
- **Machine load.** Both runs shared the machine with other sessions (load 15 to 25). Wall times are not compared between builds; counts and predictions are.
- **One run per build.** Each scenario ran once per build at the sizes shown. The before build ran on 2026-10-11 between 19:52Z and 20:10Z, and its H4p, the one step whose code changed since, at 21:50Z. The after build ran in full at `ac0307a` between 22:16Z and 22:23Z, in three `--only` parts: the read-only steps on the busy run (H1, the checks, motion, keyboard, H7 and one room at a time), every room, then the steps that write (H2 with its reach check, H2a, H3, H4p, H6, H9, H4, H4s, H5 and H8). The deterministic bars are also assertions in `test/board.test.js` (contrast, targets, names, readability with control clipping and line length, the theme switch and no empty boxes, at the four sizes in both themes on every room; one room at a time; the queue order; routing; Enter and refused writes).

## Screenshots

Every room, a task sheet, Settings and Controls at every size and theme, and the end state of each scenario: [before/](human-bench/before/), [after/](human-bench/after/). File names are `ROOM-SIZE-THEME.webp`, with the front room as `front-`.

| Before, 1920x1080 light | After, 1920x1080 light |
|---|---|
| ![Before](human-bench/before/front-1920x1080-light.webp) | ![After](human-bench/after/front-1920x1080-light.webp) |

| Before, 390x844 dark | After, 390x844 dark |
|---|---|
| ![Before on a phone](human-bench/before/front-390x844-dark.webp) | ![After on a phone](human-bench/after/front-390x844-dark.webp) |

## Running it

```sh
git archive <before-commit> | tar -x -C ~/.cache/before
node test/bench/run.js --build before --tree ~/.cache/before --out ~/.cache/bench
node test/bench/run.js --build after --tree . --out ~/.cache/bench
node test/bench/report.js --results ~/.cache/bench --doc docs/human-bench.md --shots docs/human-bench
```

`--only H1,H4` reruns some steps and keeps the rest of an earlier results file. The scratch states go in a private directory made for the run and removed after it; `--scratch DIR` keeps them for inspection. Run it outside an agent task process; it needs Chrome. On a build that prints a one-time link, the driver opens it once per serve run, so the page holds the write token for the scenarios that write.
