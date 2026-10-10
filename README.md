# Tower Crane

Hand an agent anything from one issue to a whole project. Tower Crane keeps the plan, the standard, the review and the merge gates in software, so the agents spend tokens on the work and you watch instead of steering.

- **State in plain files.** Tasks, dependencies, owner decisions, evidence and spend live in JSON under `.tower-crane/`. Only the `tower-crane` CLI writes them. `tower-crane render` turns them into a Markdown and HTML sketch you can open anywhere.
- **Any harness.** The orchestrator runs in Claude Code, Codex, OpenCode, Antigravity (`agy`) or pi and dispatches with what that harness has: its own subagents, or `tower-crane spawn` starting another CLI.
- **A model ladder.** Each task has a tier (easy, medium, hard, research), and a ladder in `project.json` names the harness, model and effort for each tier and for the orchestrator, review and small checks. One field moves every rung to another harness, or each rung picks its own. Edit it with `tower-crane ladder set`, or in the Settings view of `tower-crane serve`; `~/.config/tower-crane/config.json` holds your primary defaults for new projects and personal fallback routes that apply over every project's rungs.
- **Lean agents.** Each role has an agent file that says what it may and may not do. Claude and Codex rungs always run through `tower-crane spawn`, and each spawned agent gets a fresh config home of its own, so your memories, plugins, hooks, MCP servers and approved commands stay out of it: about 7k (Codex) to 12k (Claude) tokens at start instead of 24k to 42k, and its commands run sandboxed ([docs/ladder.md](docs/ladder.md#agent-files-and-homes)).
- **Review is never self-review.** Acceptance needs review evidence from the owner or from a reviewer `spawn` dispatched for that task, sha and revision, never the submitter.
- **Gates are software.** Tests must fail before the change and pass after it, the cleanup tool must report nothing HIGH, CI is read on the exact commit, and merges match the head.
- **Owner decisions do not block.** A question blocks only the tasks it names.

Status: under construction. See [docs/state.md](docs/state.md) and [docs/cli.md](docs/cli.md).
