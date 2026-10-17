# Changelog fragments

Add one `changelog.d/<task-or-pr>.md` file per change, for example `T86.md` or `123.md`. Use Markdown bullets. Fragments are draft release notes: when a change makes an existing fragment untrue, correct it in that change. CI rejects edits to `CHANGELOG.md` outside a release and deleted fragments, and requires a new fragment in each change.

`CHANGELOG.md` holds the release notes, one `## <version>` section per release, newest first. Fragments stay in `changelog.d/` after a release. The latest commit on the first-parent history that adds or changes a release heading in `CHANGELOG.md` is the release boundary: fragments in its tree are released, and the rest are unreleased.

To release:

1. Merge the base branch into the release branch, then run `node scripts/changelog.js` from a Git checkout with full history. It prints the unreleased fragments under `## Unreleased`, newest first in the order they landed on the first-parent history, followed by the released notes. Fragments added in the same commit use filename order; uncommitted fragments appear first for a local preview.
2. Write the `## <version> (<date>)` section at the top of `CHANGELOG.md` from those fragments: group them, drop test and CI internals, merge repeats, and keep short sentences with the fact first. The version matches `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
3. Before merging, merge the base branch again and rerun `npm run check:shared -- --base origin/BASE`. It accepts a `CHANGELOG.md` edit only when it adds one section for the `package.json` version above the earlier notes, which must stay unchanged, and it prints every fragment the release marks released. Check new names against the notes.
4. Squash-merge the release PR, so the section and every fragment it covers land in one commit. A rebase merge would leave fragments added after the heading commit under `## Unreleased`.

The CLI command rows in `docs/cli.md` come from `COMMANDS` in `bin/tower-crane.js`. Keep that table sorted by command name, with one entry per line and a blank line between entries. Change a command's usage and long `description` there, then run `npm run docs:generate`. Commands without `description` use their help `summary`. Generated rows have a stable empty table row (`| | |`) between them so independent command edits merge cleanly. Keep further contract details and examples outside the generated blocks. `npm run check:shared` checks the generated rows and table layout; pass `-- --base SHA` to also check the changelog changes against a base commit.

Git checks out `bin/tower-crane.js` and `docs/cli.md` with LF endings on every platform. Keep those attributes so independent command edits do not rewrite the whole file when docs are generated.
