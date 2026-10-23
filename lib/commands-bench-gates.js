'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Views', name: 'bench gates', usage: '[--deslop-hits FILE] [--deslop-findings FILE] [--deslop-runs FILE] [--deslop-report FILE]', summary: 'label every software gate result from the event log and report precision and recall per gate, and per deslop check from its eval files', flags: { 'deslop-hits': str('FILE', 'JSONL of detector hits with hand verdicts'), 'deslop-findings': str('FILE', 'JSONL of reviewer-found defects with reviewed_commit and example'), 'deslop-runs': str('FILE', 'JSON of detector output keyed repo#pr@commit; needs --deslop-findings'), 'deslop-report': str('FILE', 'detector report JSON with confirmed findings and dismissed items') }, description: "label every tests, clean, sources, ci and merge gate run in the event log and report per gate: runs, distinct results (one per gate, sha and outcome), true and false positives and negatives, open results, noncode CI fails (no failed hosted check or confirmed local execution; scored as neither), precision, recall and recall against failed CI check runs only (`-` for ci and merge). Failed CI runs are split by reason and by failing check run, deduplicated per task, sha and check name across all polls. Local CI executions use their confirmed failure and exit receipts. The deslop flags add per-check precision and recall from the detector's eval files; `--deslop-runs` needs `--deslop-findings`. Tables normalize unambiguous SHA prefixes of at least seven characters to the longest recorded spelling for that task, ignoring case. JSON output includes every labeled run with its original SHA", run: run('./bench-gates', 'benchGates') },
];

module.exports = COMMANDS;
