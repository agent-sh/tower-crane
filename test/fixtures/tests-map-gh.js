'use strict';

const path = require('node:path');
const { updateJson, writeAtomic } = require('../atomic-file');
const args = process.argv.slice(2);
const file = process.env.TC_MAP_GITHUB;
const data = updateJson(file, (current) => {
  current.calls.push(args);
  return current;
});
if (data.fail) {
  if (data.supersedingPoll) {
    const { file: receiptFile, receipt } = data.supersedingPoll;
    writeAtomic(receiptFile, JSON.stringify(receipt));
    writeAtomic(process.env.HOOK_CLOCK_FILE, String(Date.parse(receipt.read_at)));
  }
  console.error('GitHub unavailable');
  process.exit(1);
}
const print = (value) => console.log(JSON.stringify(value));
if (args[0] === 'run' && args[1] === 'download') {
  writeAtomic(path.join(args[args.indexOf('-D') + 1], 'tests-coverage-map.json'), JSON.stringify(data.artifact));
} else if (args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/actions/runs?')) {
    if (args.includes('--jq')) for (const run of data.runs) print(run);
    else print({ workflow_runs: data.runs });
  } else if (endpoint.includes('/compare/')) print({ status: data.comparison });
  else if (endpoint.includes('/artifacts?')) print({ artifacts: data.artifacts });
  else if (endpoint.includes('/branches/')) print({ sha: data.artifact.sha });
  else if (endpoint.includes('/workflows?')) print({ id: 1, state: 'active' });
  else if (endpoint.includes('/jobs?')) { /* No failing jobs. */ }
  else process.exit(1);
} else process.exit(1);
