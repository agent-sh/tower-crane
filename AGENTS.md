# Tower Crane

## Project

Tower Crane is a CLI and an agent plugin. The CLI (`bin/`, `lib/`) keeps a project's plan and progress in plain files in the project's Tower Crane state directory and runs the software gates; the plugin (`skills/`, `agents/`, `standards/`) is the methodology agents follow on top of it. Part of the [agentsys](https://github.com/agent-sh/agentsys) ecosystem.

## Rules

- Node 24 or newer, no npm dependencies, CommonJS.
- The CLI is the only writer of state. A feature that needs agents to change state adds a command, not an instruction to edit JSON.
- Software before models: if a check can be code, it is code.
- Tests are integration tests that run the real CLI on a temporary git repository; a feature or fix comes with one that fails without it. A variant table of pure logic (address ranges, file patterns, markup) runs in process against the module, with one CLI test for the wiring. `docs/testing.md` has the costs, the mutation sample and the node:test options in use.
- Run only the test files a change touches: `npm test -- test/claim.test.js test/gates/tests.test.js`. The tests gate runs the full suite once and CI runs it on every platform. `npm test` caps file workers at 4 and below the machine's cores; set `TOWER_CRANE_TEST_TMP` to keep temp files off `/tmp`.
- A fixture several tests share is built once per file with `cachedFixture` in `test/helpers.js` and copied, not rebuilt per test. `node scripts/mutants.js` must still catch every planted bug after a change to tests.
- Changes reach `main` through a PR with a clean-context review comment and green CI.
- No em dashes or assistant phrasing in code, comments, docs or commit messages. Comments say why, never record review history.
- `docs/state.md` and `docs/cli.md` are the contract. Change them in the same PR as the behavior.
- Add `changelog.d/<task-or-pr>.md` for each change; leave `CHANGELOG.md` and existing fragments unchanged. Releases assemble the changelog with `node scripts/changelog.js`.
- Keep command usage, help summaries and long descriptions in `COMMANDS`, sorted by name, one entry per line with a blank line between entries. `description` supplies the full command-table text; commands without it use `summary`. Generate `docs/cli.md` command rows with `npm run docs:generate`; its empty table rows separate independent edits. Keep further contract details and examples outside the generated blocks.
- Before submitting, run `npm run check:shared -- --base origin/BASE` after fetching the configured base branch. CI runs the same checks for changelog fragments, command layout and documentation drift.

## Layout

- `bin/tower-crane.js`: CLI entry.
- `lib/`: state, project, tasks, decisions, render, serve, worktree, spawn, check and util; `lib/gates/`: tests, clean, ci, merge and common.
- The three skills (`skills/tower-crane/`, `skills/tower-crane-work/`, `skills/tower-crane-review/`) and four agent files in `agents/` (worker, reviewer, small, orchestrator): the plugin. `lib/agents.js` renders the agent files for spawned agents and builds their homes.
- `standards/default.md`: the default standards profile.
- `docs/`: state, CLI and the model ladder.
