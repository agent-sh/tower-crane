'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Plan', name: 'tests map refresh', usage: '(--from-run RUN_ID | --file FILE)', summary: "pin tests.map from a full CI run's coverage, preserving what the run did not measure", flags: { 'from-run': str('RUN_ID', 'workflow run whose tests-coverage-map artifact to download with gh run download'), file: str('FILE', 'read the coverage map from a local tests-coverage-map.json instead') }, description: "operational (orchestrator or owner): pin `tests.map` from `tests-coverage-map.json`, the map `node scripts/tests-coverage-map.js` or `test/run.js` with `TC_TEST_COVERAGE_DIR` builds from V8 coverage and non-JS file reads of a full run (each source file to the test files that ran its code or read it, CLI processes they started included, plus the commit it was built at). `--from-run RUN_ID` downloads the run's `tests-coverage-map` artifact with `gh run download`; `--file FILE` reads a local copy. Sources in the artifact replace previous suites for tests present in it; suites for absent tests, sources the run did not reach and globs survive. Preserved suites must still be tracked at the artifact commit: deleted or renamed test paths are pruned, and entries emptied by pruning are removed. Explicit empty declarations survive. New declarations live in checked-in `tests-map.declared.json`, read at task head and merged over the pinned map. The artifact commit must be available locally; an unreadable commit refuses without a write. A map that is not `{sha, tests, map}` with literal sources refuses without a write. The `tests map refresh` event records the run or file, the sha and the entry counts", run: run('./tests-map-refresh', 'refresh') },
];

module.exports = COMMANDS;
