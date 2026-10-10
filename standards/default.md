# Default standards

The way Tower Crane works unless the project names its own profile in `project.json`. The orchestrator plans by it, workers build by it, reviewers check against it. A repository's own `AGENTS.md` wins where it says something different.

## Scope and autonomy

- Once the owner hands over a goal, work through it without asking at each step. Ask only at a real safety boundary or a material change of scope, and ask through `tower-crane ask` so only the affected tasks wait.
- Do every item the owner asked for, or get an explicit answer to drop one. Offer a better idea next to the work, not instead of it.
- Do not invent limits, thresholds or defaults without a reason you can state. If no number can be justified, ask.
- A failing test or a bug in the repository is the project's to fix, not to label pre-existing and skip.

## Changes and pull requests

- Every change reaches the base branch through a pull request. Keep branches short-lived. Read the configured `base` from `tower-crane project show` and replace `BASE` in `git fetch origin +refs/heads/BASE:refs/remotes/origin/BASE` and `git merge --no-ff origin/BASE` with that branch name. The PR's squash merge makes this commit harmless; push normally. A rebase that would require a force push is the orchestrator's job.
- One task, one branch, one PR. A PR that depends on another open PR stays stacked; the orchestrator handles any history rewrite needed to update the stack.
- The PR body says what changed, why, how it was verified, and the limits. Keep it current when the change moves.
- Merge only when CI is green on the exact head, review passed, and the merge names that head (`--match-head-commit`). For GitHub stacks, check every lower accepted head first, then merge PRs bottom up through the asynchronous merge API, each pinned to its accepted head (`expected_head_sha`), and confirm each before retargeting and merging the next. Merge commits preserve accepted dependency heads as ancestors of the base. A moved head or unconfirmed merge stops the chain; record any confirmed accepted lower merges. A cancelled, timed-out or never-started check is a failure, not a pass.
- On repositories the project does not own, the PR stays clean: motivation, design, limits and measurements in the body; no self-review or status comments.

## Review

- Nobody reviews their own work. Review comes from an agent with a clean context that did not write the change. Its model follows the task tier, diff risk and measured review cost, and may match the builder's model.
- The review is posted where the repository keeps reviews (a PR comment by default) and recorded as evidence.
- An external review bot, when the repository has one, is addressed like any reviewer. When it is capped or down, the clean-context review is enough; say so in the PR body.

## Tests

- For code changes, a test proves something only if it fails before the change and passes after it. `tower-crane check tests` enforces this by default in `prove` mode. The owner can select `run-only` or `none` per task kind, or mark a suite expensive to run it once at head and retain proof through scoped changed-test runs, per `docs/state.md`. Other task kinds use the verification in their brief and independent review.
- Prefer one integration test that exercises the behavior over many unit tests. Keep a unit test only for pure logic nothing else reaches.
- Run the tests the change touches, not the whole suite, while working. CI stays thin: lint, build and the checks that guard a merge.
- When the same mistake shows up twice in review or CI, add a lint rule or check for it.

## Measurement

- Benchmarks and performance claims report the median of three runs, with min and max. For long runs, one run plus a validation run; if they disagree, three; if still unstable, five; if five do not settle, find out why before reporting.
- Never claim a win from a single run.
- Ship positive results; delete the code of negative ones unless there is a reason to keep it.
- Avoid feature flags. Use one only for a transition or a special case, and remove the off path afterwards.

## Writing

- Plain words, the fact first, short sentences, no hedging. No em dashes and no generic assistant phrasing in code, comments, docs, commit messages or PR text.
- Comments say why the code is the way it is. They never record review history; that belongs in the PR.
- Reports are short: what changed, what is next, what needs the owner.

## Resources

- Cap every wait with a deadline and a failure exit; a broken check should be noticed within minutes, not hours.
- Run no more workers than `limits.workers`. Check machine load before heavy work.
- Scratch files and worktrees are removed by the task that created them when it closes.
- Spend tokens on the work: give each agent its brief, not the whole history. Software checks run before any model reads the result.
