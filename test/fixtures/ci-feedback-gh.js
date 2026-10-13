'use strict';

// A gh that serves one repository's job, branch ref, job log and code-scanning alerts from
// CI_FEEDBACK_GH, printed the way gh api prints them: JSON, the raw log, and --jq arrays one element per line.
const fs = require('node:fs');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(process.env.CI_FEEDBACK_GH, 'utf8'));
const endpoint = args[1] || '';
const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};
const job = /^repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)(\/logs)?$/.exec(endpoint);
const ref = /^repos\/[^/]+\/[^/]+\/git\/ref\/(.+)$/.exec(endpoint);
if (args[0] !== 'api') fail(`unexpected gh call: ${args.join(' ')}`);
else if (job?.[2]) {
  if (data.logs[job[1]] === undefined) fail('gh: Not Found (HTTP 404)');
  else process.stdout.write(data.logs[job[1]]);
} else if (job) {
  if (!data.jobs[job[1]]) fail('gh: Not Found (HTTP 404)');
  else console.log(JSON.stringify(data.jobs[job[1]]));
} else if (ref) {
  if (!data.refs[ref[1]]) fail('gh: Not Found (HTTP 404)');
  else console.log(JSON.stringify(data.refs[ref[1]]));
} else if (/^repos\/[^/]+\/[^/]+\/code-scanning\/alerts\?/.test(endpoint)) {
  const alertRef = new URL(`https://api.github.com/${endpoint}`).searchParams.get('ref');
  for (const alert of data.alerts[alertRef] || []) console.log(JSON.stringify(alert));
} else fail(`unexpected gh call: ${args.join(' ')}`);
