# Bench

Two read-only commands measure Tower Crane on its own history. `bench gates` labels every software gate result as right or wrong from what happened later. `bench tokens` reports what an accepted task costs, by rung and by escalation path. Both read the state directory and change nothing.

```sh
tower-crane bench gates [--deslop-hits FILE] [--deslop-findings FILE] [--deslop-runs FILE] [--deslop-report FILE] [--json]
tower-crane bench tokens [--prices FILE] [--json]
```

## Gate bench

### Labels

A gate result is a run of `check tests`, `check clean`, `check sources`, `check ci` or `merge`, read from `events.jsonl`. Evidence an agent records by hand is not a gate run and is not labeled. A failing gate is a positive: it says the sha is not ready.

| Label | Rule |
|---|---|
| false positive | the gate failed, and the same gate later passed the same sha, so no code changed between the two |
| true positive | the gate failed, was never reversed at that sha, and the task later moved to a different sha |
| false negative | the gate passed, and later a review blocker, failed hosted CI check or confirmed local CI execution hit the same sha and was not reversed at that sha |
| true negative | the gate passed, nothing contradicted it, and a later passing review or merge confirmed that sha |
| open | none of the above yet: a fail with no later submit, a pass with no later review or merge |
| noncode | a CI fail without a failed hosted check or confirmed local execution: pending, mergeability, a moved head, a query error, missing evidence, or a local observation failure |

Precision is `tp / (tp + fp)`. Recall is `tp / (tp + fn)`. Open and noncode results count in neither. `recall(ci)` counts only CI contradictions, because review blockers include design and scope findings that no software gate is meant to catch. It is `-` for the ci and merge gates: both read CI themselves, so CI cannot contradict them and the figure would be 100% by construction.

Rules that keep the labels honest:

- A hosted CI failure is a verdict on the code when its summary names failed check runs (`failure`, `timed_out`, `startup_failure`). The reason comes from the evidence summary stored with the task. The gate stamps that entry and its event separately, a few milliseconds apart, so a fail event takes the latest unused failed ci entry of its task and sha stamped no later than the event. Hosted failures with no such entry count as `unknown` and are noncode.
- A local CI failure uses its event receipt: `confirmed_failure: true`, a positive exit other than command-unavailable exits 126, 127 or 9009, no signal, a command, and a matching head. It appears as `local CI (VARIANT)` in the check table and needs no hosted summary.
- A pending run, mergeability wait, moved head, GitHub query error or local observation failure says nothing about the code. Local refusals, timeouts, signals, unavailable commands and changed-tree observations remain noncode. One rule holds on both sides: such a failure contradicts no pass, and as a ci gate result is never a true or false positive.
- A failure that the same kind of check later reversed at that sha (a CI rerun, a second review) contradicts nothing.
- A pass contradicted by both a review blocker and a failed CI check run counts once as a false negative and once under each source, so `recall(ci)` does not depend on which came first.
- Gates often rerun on one sha. The score counts one result per gate, sha and outcome, labeled by its earliest run, which has the most later evidence. A noncode CI fail and a CI fail that names check runs are different outcomes, so a pending run cannot hide a later real failure at the same sha. `runs` shows the raw count, and `--json` lists every labeled run with the event that decided it.
- Both tables share commit identities: case is ignored, and an unambiguous SHA prefix of at least seven characters expands to the longest spelling recorded for that task. Distinct full SHAs stay distinct even when they share a prefix; ambiguous prefixes remain as recorded. Raw labels retain the original SHA. For example, a failed run recorded with seven characters and repeated with forty counts once. With one other overturned failure, precision is 50%.
- Per CI check run, a failure is a false positive when CI later passes the same sha. Check names are collected from every poll and deduplicated by task, sha and check name using that check's earliest failure; a name first reported in a later poll still counts.

### Deslop checks

The cleanup gate runs the deslop detector. Its own eval files label its checks three ways, each behind one flag:

- `--deslop-hits`: JSONL of detector hits with a hand verdict each (`true-slop`, `harmless`, `false-positive`). Precision is true slop over all hits; lenient precision also counts harmless hits.
- `--deslop-findings` with `--deslop-runs`: JSONL of reviewer-found defects (`source` is `repo#pr url`, plus `reviewed_commit` and `example` as `path:line`), and the detector's JSON output keyed `repo#pr@commit`. A detector item in the same file within 5 lines of a defect at the reviewed commit is a true positive, the eval's own matching rule. Other items are unconfirmed, so precision is a lower bound: reviewers do not report every real problem. Recall is defects caught over defects with a detector run. `--deslop-findings` alone reports the earlier detector's `deslop_caught` field.
- `--deslop-report`: a detector report after agent confirmation, with `findings` kept and `dismissed` rejected.

## Token bench

Tokens come from `spend.entries`. Every harness parser records input inclusive of cache reads, so fresh input is `input - cached`, and the bench reports fresh input, cache reads and output separately before any comparison. A task is complete when it has a positive recorded token total, no unknown or live token entries, and a spend record for every recorded spawned session, including workers and reviewers. Automatic records match their `spawn:<agent>` source IDs, including resumed-attempt, fallback-route and fresh-retry suffixes. A native manual token report matches its agent and dispatch time window; a report from before a resumed dispatch cannot cover that new session. Minute-only manual entries do not cover a session, while explicitly recorded zero tokens do. JSON lists unmatched source IDs in `missing_spawns`. Token and USD medians, including path and rung groups, use complete accepted tasks only.

An entry with a `live` marker is incomplete even when it has measured tokens and cost, or its latest reading is stale. Exit collection must remove that marker before the task can enter any median or mean. Each live or unknown token entry contributes once to the task row's `unknown` count. Its recorded tokens still contribute to `all_tasks_tokens` and `tokens_per_accepted`.

A known token total without a breakdown still contributes to token medians. If any entry lacks a category, that task's category total is `null` and is excluded from that category's median; fresh input needs both input and cached counts. A category with no measured totals has a `null` median. Explicit category zeros remain measured values.

- The escalation path is the task's worker rungs from its `spawn` events in order, repeats collapsed: `easy>medium` started on easy and moved once. Native work without spawn receipts uses the rungs its spend entries name. A path that goes down (`medium>easy`) is a re-tier, not a quality climb.
- By rung, each task contributes the tokens it spent on that rung, so `review` is the review cost per accepted task.
- `all recorded task tokens / accepted tasks` divides every task's spend, cancelled and unfinished ones included, by the accepted count: the full cost of getting work accepted.
- USD uses the entry's recorded `cost_usd`, else `--prices`, else the project `review.prices`, with the review pricing rules (inclusive input, conservative cache-write pricing). Rates match on the model id: a 1M-context id such as `global.anthropic.claude-opus-5-5[1m]` is its own row and does not fall back to base Opus. An entry whose model has no rate is unpriced, the output lists unpriced entries by model, and a task with any unpriced entry is left out of the USD median; the `priced` column counts the tasks that median covers.

## Results

Snapshot: both gate and token figures use this project's state frozen in memory at 2026-10-08 23:17:21 (Jerusalem), 35,889 events and 130 tasks. The state is live, so later runs give other counts as tasks add evidence and spend. Deslop inputs: the 2026-10-06 slop research set (3,367 hand-labeled hits from deslop 1.3.0, 106 reviewer-found defects across agent-sh and darklanes PRs), the eval run of the rewritten detector on the same PRs, and its one agent-confirmed report.

Prices, per million tokens (input / cache write / cache read / output), Bedrock global rates:

| Model id | Input | Cache write | Cache read | Output |
|---|---|---|---|---|
| `claude-opus-5-5` | 4 | 5 | 0.20 | 20 |
| `global.anthropic.claude-opus-5-5[1m]` | 4 | 5 | 0.20 | 20 |
| `openai.gpt-6.1-sol` | 2 | 2.50 | 0.10 | 10 |
| `openai.gpt-6-luna` | 0.10 | 0.125 | 0.01 | 0.50 |

The 1M-context Opus id has its own row at the base Opus rates, since no long-context premium for it is recorded. The snapshot has 24 unpriced Haiku entries, 6 unpriced Astra entries and one entry whose model field combines two IDs. Eight otherwise complete tasks have unpriced usage and are excluded from the USD median.

Both benches read recorded data and are deterministic: three runs of each on the same frozen snapshot gave byte-identical output (text and `--json`), so each figure is the value of every run. The deslop eval run is a detector run over git history and is deterministic as well. Three gate runs after the SHA identity correction reproduced the same text and JSON; the published gate figures below are unchanged.

### Gates

| Gate | Runs | Results | TP | FP | FN | TN | Open | Noncode | Precision | Recall | Recall (CI) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tests | 542 | 483 | 70 | 14 | 199 | 100 | 100 | 0 | 83.3% | 26.0% | 45.8% |
| clean | 445 | 417 | 10 | 2 | 215 | 99 | 91 | 0 | 83.3% | 4.4% | 9.4% |
| sources | 3 | 3 | 0 | 0 | 2 | 1 | 0 | 0 | - | 0.0% | 0.0% |
| ci | 486 | 435 | 97 | 7 | 84 | 89 | 25 | 133 | 93.3% | 53.6% | - |
| merge | 117 | 102 | 5 | 5 | 1 | 11 | 80 | 0 | 50.0% | 83.3% | - |

False negatives by source: tests 119 review and 83 CI, clean 120 review and 96 CI, sources 1 review and 1 CI, ci 84 review and 0 CI, merge 1 review and 0 CI. A pass contradicted by both counts under each source, so the two counts can sum to more than FN.

The three sources-gate runs are now labeled: two false negatives and one true negative. T38's sources pass at `05e6744` was later contradicted by a blocking review.

Recorded false positives include gates refusing unpinned or mismatched commands, cleanup tooling being unavailable, stacked-PR merge refusals and CI checks passing on rerun. T8 and T51 also exposed test-file classification faults. These labels describe later reversals, not a claim that every reversal was caused by a code defect.

CI failures by reason (distinct results): checks 114, mergeability 92, pending 32, query 5, head-moved 2, other 1, unknown 1. The snapshot has no local CI execution failures; the integration fixture covers failed executions and local observation failures.

| CI check run | Fails | TP | FP | Open | Precision |
|---|---|---|---|---|---|
| revuto-review | 45 | 33 | 3 | 9 | 91.7% |
| test (windows-latest, node 26) | 32 | 30 | 1 | 1 | 96.8% |
| test (ubuntu-latest, node 24) | 30 | 29 | 0 | 1 | 100.0% |
| test (ubuntu-latest, node 26) | 26 | 25 | 0 | 1 | 100.0% |
| CodeQL | 14 | 13 | 0 | 1 | 100.0% |
| test (windows-latest, node 24) | 14 | 11 | 3 | 0 | 78.6% |
| test (ubuntu-latest, node 20) | 7 | 7 | 0 | 0 | 100.0% |

Each check counts once per task and sha across all polls. T123 at `e653e4b` contributes both its first Ubuntu test failure and the later `revuto-review` failure.

### Deslop checks

deslop 1.3.0, hand verdicts on 3,367 hits: 18 true slop (0.5%), 163 harmless. Only two checks found anything: `disabled_linter` 11 of 62 (17.7%) and `issue_pr_references` 7 of 105 (6.7%). The two largest, `rust_bare_unwrap` (1,377 hits) and `high_entropy_string` (1,238), found none. The same version caught 0 of the 106 reviewer-found defects.

The rewritten detector, against the reviewer-found defects at their reviewed commits (100 of 106 had a run):

| Check | Items | TP | Unconfirmed | Precision (lower bound) | Defects caught | Recall |
|---|---|---|---|---|---|---|
| stale-mention | 33 | 0 | 33 | 0% | 0 | 0% |
| missing-path | 20 | 1 | 19 | 5.0% | 1 | 1.0% |
| dropped-rule | 11 | 0 | 11 | 0% | 0 | 0% |
| complexity | 5 | 2 | 3 | 40.0% | 2 | 2.0% |
| lint | 5 | 1 | 4 | 20.0% | 2 | 2.0% |
| changelog-missing | 3 | 0 | 3 | 0% | 0 | 0% |
| review-provenance | 3 | 1 | 2 | 33.3% | 1 | 1.0% |
| em-dash | 2 | 0 | 2 | 0% | 0 | 0% |
| broken-anchor | 1 | 1 | 0 | 100% | 1 | 1.0% |

7 of 100 defects caught (7%). The match is by location, so a catch can be a nearby item about something else: the one `missing-path` catch sits next to a stale model name. The earlier eval run of the same rewrite caught 6. On the one agent-confirmed report, the agent kept 1 of 11 findings and dismissed all 8 `missing-path` items.

### Tokens per accepted task

92 accepted tasks, 68 with complete token records. All recorded task tokens over accepted tasks: 42.85M. `Priced` is the number of tasks in the USD median.

20 accepted tasks have 73 spawned sessions with no matching usage entry. T26 is missing its first worker, T36 is missing two workers and its first reviewer, and T48 is missing its first worker and reviewer. They remain in the recorded-spend total but are excluded from all medians. Other incomplete tasks have unknown or absent token totals.

| Group | Tasks | Median tokens | Mean tokens | Median USD | Priced |
|---|---|---|---|---|---|
| all | 68 | 16.16M | 35.63M | $3.55 | 60 |

By escalation path:

| Path | Tasks | Median tokens | Mean tokens | Median USD | Priced |
|---|---|---|---|---|---|
| easy | 14 | 16.23M | 61.07M | $0.68 | 9 |
| easy>medium | 2 | 63.77M | 63.77M | $2.21 | 2 |
| easy>medium>easy | 1 | 83.72M | 83.72M | - | 0 |
| hard | 14 | 14.44M | 17.55M | $6.26 | 13 |
| medium | 28 | 15.73M | 26.01M | $3.22 | 28 |
| medium>easy | 2 | 12.07M | 12.07M | $1.20 | 2 |
| medium>easy>medium | 3 | 43.52M | 42.87M | $7.45 | 3 |
| medium>hard | 1 | 103.92M | 103.92M | $23.63 | 1 |
| research | 2 | 25.28M | 25.28M | $12.48 | 1 |
| research>medium | 1 | 75.51M | 75.51M | $21.37 | 1 |

By rung (tokens each task spent on that rung):

| Rung | Tasks | Median tokens | Mean tokens | Median USD | Priced |
|---|---|---|---|---|---|
| easy | 22 | 13.94M | 47.56M | $0.23 | 16 |
| hard | 15 | 13.76M | 16.26M | $5.75 | 14 |
| medium | 38 | 15.05M | 24.15M | $2.81 | 38 |
| research | 3 | 23.51M | 33.19M | $13.79 | 2 |
| review | 68 | 951k | 1.70M | $0.58 | 66 |

Cache reads are 97.5% of the complete tasks' tokens, fresh input 2.1% and output 0.4%. Comparisons between rungs therefore need both token categories and USD. The path groups differ in task difficulty and sample size; their medians do not establish that one escalation policy causes lower cost.

## Limits

- Labels need later evidence. Results still in flight are open and do not count, and merge passes stay open because nothing is recorded after a merge.
- A review blocker counts against every gate that passed that sha, whether or not the blocker is the kind of fault the gate checks. `recall(ci)` is the narrower view.
- Hosted failures need matching evidence summaries; an event without one is `unknown` and noncode. Local failures instead use their execution receipts and confirmed-failure flag, even without a summary.
- Spend entries come from harness telemetry. Claude thinking tokens that the API usage does not report are missing, and long-context surcharges per request cannot be rebuilt from totals.
- The deslop precision against reviewer findings is a lower bound, and its location match can credit an unrelated item.
- The bench reads the live state. Results are reproducible only on the same snapshot; the gate and token figures above use the frozen snapshot named under Results. Missing telemetry means the recorded-spend total is a lower bound on actual cost.
