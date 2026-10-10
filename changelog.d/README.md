# Changelog fragments

Add one `changelog.d/<task-or-pr>.md` file per change, for example `T86.md` or `123.md`. Use Markdown bullets. Leave existing fragments and `CHANGELOG.md` unchanged; CI rejects edits to them and requires a new fragment in each change.

`CHANGELOG.md` is the historical archive. At release, run `node scripts/changelog.js` from a Git checkout with full history. It assembles fragments newest first in the order they landed on the first-parent branch history, followed by that archive on stdout. Fragments added in the same commit use filename order; uncommitted fragments appear first for a local preview. Save that output as the release changelog artifact outside the checkout. Assembly keeps the source fragments, so the complete changelog can be regenerated for every release.

The CLI command rows in `docs/cli.md` come from `COMMANDS` in `bin/tower-crane.js`. Keep that table sorted by command name, with one entry per line and a blank line between entries. Change a command's usage and long `description` there, then run `npm run docs:generate`. Commands without `description` use their help `summary`. Generated rows have a stable empty table row (`| | |`) between them so independent command edits merge cleanly. Keep further contract details and examples outside the generated blocks. `npm run check:shared` checks the generated rows and table layout; pass `-- --base SHA` to also check the changelog changes against a base commit.

Git checks out `bin/tower-crane.js` and `docs/cli.md` with LF endings on every platform. Keep those attributes so independent command edits do not rewrite the whole file when docs are generated.
