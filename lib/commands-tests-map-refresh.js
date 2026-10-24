'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Plan', name: 'tests map refresh', usage: '(--from-run RUN_ID | --file FILE)', summary: "pin tests.map from the coverage map a full CI run built, keeping declared entries", flags: { 'from-run': str('RUN_ID', 'workflow run whose tests-coverage-map artifact to download with gh run download'), file: str('FILE', 'read the coverage map from a local tests-coverage-map.json instead') }, description: "operational (orchestrator or owner): pin `tests.map` from `tests-coverage-map.json`, the map `node scripts/tests-coverage-map.js` or `test/run.js` with `TC_TEST_COVERAGE_DIR` builds from V8 coverage of a full run (each source file to the test files that ran any of its code, CLI processes they started included, plus the commit it was built at). `--from-run RUN_ID` downloads the run's `tests-coverage-map` artifact with `gh run download`; `--file FILE` reads a local copy. Measured entries replace the pinned ones; entries coverage cannot measure, globs and files other than JavaScript or TypeScript, are kept as declared. A map that is not `{sha, tests, map}` with literal sources refuses without a write. The `tests map refresh` event records the run or file, the sha and the entry counts", run: run('./tests-map-refresh', 'refresh') },
];

module.exports = COMMANDS;
