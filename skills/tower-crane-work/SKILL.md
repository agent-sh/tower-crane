---
name: tower-crane-work
description: "Use when Tower Crane hands you one task: implement its brief in its worktree, verify its acceptance, open the PR and submit it with the tower-crane CLI."
argument-hint: "<task id> [--agent NAME]"
---

# Tower Crane: work one task

You build one task. The brief is your context; the acceptance is your definition of done. Someone else reviews it, so make it easy to check.

Arguments: `$ARGUMENTS`. Use `TOWER_CRANE_TASK` and `TOWER_CRANE_AGENT` when set; otherwise use the task id and agent name passed by the orchestrator. Pass `--agent <name>` on every tower-crane call. If `TOWER_CRANE_STATE` is absent, also pass `--state <dir>` with the supplied state directory.

1. `tower-crane task show <id> --agent <name>`, `tower-crane brief get <id> --agent <name>` and `tower-crane project show --agent <name>`. If not claimed by you, `tower-crane claim <id> --agent <name> --lease MIN`, sized for expected work and waits using `limits.lease_minutes` as the default; if refused, stop and report why. If work needs longer, renew before expiry with `tower-crane renew <id> --agent <name> --lease MIN` when reporting progress.
   Your first message restates the project goal and this task's target in one or two sentences. Read the rule files the prompt's `## House rules` marks "read it" (the user's and the repository's AGENTS.md and CLAUDE.md files) before changing anything.
2. Work in the task's worktree (`tower-crane worktree <id> --agent <name>` prints it). Native workers use absolute paths under that worktree for every edit and command. Read only what the brief points to, plus what you discover you need.
3. Build the smallest change that meets every acceptance item. Follow the repository's `AGENTS.md` and the standards the brief names.
   Report progress through `tower-crane task note` or `tower-crane msg --to orchestrator --task <id> "<update>"`. Renew your lease with `tower-crane renew <id>` when the work needs longer.
4. For code changes, add or change a test that fails without the change and passes with it. Run only the test files the change touches, at the repository's capped concurrency; never the whole suite. The tests gate runs the full suite once at your submitted head, and CI runs it on every platform. Your sandbox has no root mapping: root-owned host files appear there as uid/gid 65534, so a test that asserts root ownership or needs other host state fails there. Gate commands run on the host, outside the sandbox. The tests named under `## Host-only tests` in your brief cannot run locally: skip them, and the tests gate runs them on the host. When that list is set, name the test files you run one by one: a runner refuses a directory or a glob, since it could reach a host-only file. For a research task on any tier, use the network to search for evidence and fetch at least `research.min_sources` distinct pages (default 10). Commit `research/<id>.json` with `sources: [{id, url}]` and `claims: [{claim, quote, source}]`. Every claim cites a source and quotes text found on its page; every source must be cited. The sources gate fetches them again at check time. For other work, verify the acceptance as the brief specifies.
   Waits: wait for CI or tests in the foreground with a bounded wait, `tower-crane wait --task <id> --agent <name> --timeout SEC` (exits 2 at the deadline). Do not start a background job to wait on: a headless run is not guaranteed to resume for its notification, and the Stop hook holds you once if a background job is still running.
5. Before submitting, run the configured cleanup tool if enabled and fix what it confirms; update docs and examples your change made untrue, and update the changelog the repository's way as its house rules specify.
6. Before publishing, use the `base` shown by `tower-crane project show` in step 1, or the `base` under `stack` in `tower-crane task show` when the task is stacked. Replace `BASE` in these commands with that literal branch name:

   ```sh
   git fetch origin +refs/heads/BASE:refs/remotes/origin/BASE
   git merge --no-ff origin/BASE
   ```

   Resolve conflicts and rerun affected tests. The PR's squash merge makes this merge commit harmless. Push normally with `git push`, or `git push -u origin HEAD` when the branch has no upstream. If a rebase would require a force push, leave that history rewrite to the orchestrator. Create or update the PR (`gh pr create` or `gh pr edit`) with what changed, why, how it was verified and the limits. When task show has `stack`, use its `base` as the PR base. Stack refresh runs through the orchestrator's `tower-crane stack sync` while the chain is idle; report a stale dependency instead of rebasing another task's branch.
7. `tower-crane submit <id> --agent <name> --sha <head> --branch <branch> --pr <number> --summary "<one line>"`, then `tower-crane spend <id> --agent <name> --minutes N` if you know them. Spawned CLI usage is recorded automatically on exit. For a native dispatch, the orchestrator records tokens once with `tower-crane spend <id> --tokens N [--input I] [--cached C] [--output O] --rung R --harness H --model M --agent <name>`.

Ask the orchestrator for scope and technical guidance with `tower-crane msg --to orchestrator --task <id> --agent <name> "<question>"`. When the answer blocks your task, `tower-crane ask --agent <name> --kind <kind> --question "<question>" --option "<A>" --option "<B>" --blocks <id>` opens a decision. Pick the kind honestly: `technical` is the orchestrator's to answer; `spend` (money), `credential` (secrets or access) and `setting` (an owner-required change) go to the owner, as does a question you mark with `--owner-required "<reason>"` because only the owner can decide it. Name an owner-required setting with `--setting KEY` (a setting in lib/authority.js). The reviewer checks the kind, so do not call a spend or credential question technical. Then `tower-crane task note <id> "<what you tried>" --agent <name>` and `tower-crane release <id> --agent <name> --reason "waiting on D<n>"`. If the question becomes moot before anyone answers it, `tower-crane decision withdraw <decision-id> --reason "<why>" --agent <name>` closes it. Note a wrong or incomplete brief, or a task harder than its tier (`tower-crane task show` prints it) so the orchestrator can re-tier it; do not guess at product decisions.

Do not review your own work, do not merge, and do not touch other tasks' branches. Your last message is a short report: PR link, what the test proves, anything the orchestrator should carry to dependent tasks.
