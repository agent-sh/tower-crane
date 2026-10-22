'use strict';

// A gh that serves one repository's job, branch ref, job log, code-scanning alerts and dispatched runs from
// CI_FEEDBACK_GH, printed the way gh api prints them: JSON, the raw log, and --jq arrays one element per line.
const { readPublished, updateJson } = require('../atomic-file');
const args = process.argv.slice(2);
const data = JSON.parse(readPublished(process.env.CI_FEEDBACK_GH, 'utf8'));
const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};
const job = /^repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)(\/logs)?$/.exec(endpoint);
const ref = /^repos\/[^/]+\/[^/]+\/git\/ref\/(.+)$/.exec(endpoint);
const checks = /^repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs\?/.exec(endpoint);
const suites = /^repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-suites\?/.exec(endpoint);
const annotations = /^repos\/[^/]+\/[^/]+\/check-runs\/(\d+)\/annotations\?/.exec(endpoint);
const pull = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(endpoint);
const commit = /^repos\/[^/]+\/[^/]+\/git\/commits\/([^/]+)$/.exec(endpoint);
const comments = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments(?:\?per_page=100)?$/.exec(endpoint);
const reply = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(endpoint);
const dispatches = /^repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/dispatches$/.exec(endpoint);
const actionRun = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/.exec(endpoint);
const runJobs = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs\?/.exec(endpoint);
const workflowRuns = /^repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/runs\?/.exec(endpoint);
if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify(data.pr));
else if (args[0] !== 'api') fail(`unexpected gh call: ${args.join(' ')}`);
else if (checks) {
  for (const run of data.checks[checks[1]] || []) console.log(JSON.stringify(run));
} else if (suites) {
  for (const suite of data.suites || []) console.log(JSON.stringify(suite));
} else if (/^repos\/[^/]+\/[^/]+\/actions\/runs\?/.test(endpoint)) {
  const query = new URL(`https://api.github.com/${endpoint}`).searchParams;
  const runs = query.get('event') === 'workflow_dispatch' ? Object.values(data.runs || {}) : data.workflows || [];
  for (const run of runs) {
    if (query.get('status') && run.status !== query.get('status')) continue;
    console.log(JSON.stringify(run));
  }
} else if (annotations) {
  for (const row of data.annotations[annotations[1]] || []) console.log(JSON.stringify(row));
} else if (comments) {
  if (data.commentsError) fail(data.commentsError);
  else for (const row of data.comments || []) console.log(JSON.stringify(row));
} else if (reply && args.includes('POST')) {
  const updated = updateJson(process.env.CI_FEEDBACK_GH, (current) => {
    current.comments.push({ id: 9000 + current.comments.length, in_reply_to_id: Number(reply[2]),
      user: 'worker', body: args.find((arg) => arg.startsWith('body=')).slice(5) });
    return current;
  });
  console.log(JSON.stringify(updated.comments.at(-1)));
} else if (dispatches && args.includes('POST')) {
  // A dispatch queues a run at the branch head. runDetails: false is an API that answers with no body,
  // 'refused' one that refuses the return_run_details key.
  const details = args.includes('return_run_details=true');
  if (data.dispatchError) fail(data.dispatchError);
  else if (details && data.runDetails === 'refused') fail('Invalid request.\n\n"return_run_details" is not a permitted key. (HTTP 422)');
  else {
    const ref = args.find((arg) => arg.startsWith('ref=')).slice(4);
    const updated = updateJson(process.env.CI_FEEDBACK_GH, (current) => {
      current.runs ||= {};
      const id = 500 + Object.keys(current.runs).length;
      current.runs[id] = { id, name: 'CI', path: '.github/workflows/ci.yml', event: 'workflow_dispatch', head_sha: current.refs[`heads/${ref}`].object.sha,
        head_branch: ref, status: 'queued', conclusion: null, created_at: new Date().toISOString(), html_url: `https://github.com/acme/app/actions/runs/${id}` };
      current.dispatched = [...(current.dispatched || []), { workflow: dispatches[1], ref, details }];
      return current;
    });
    if (details && data.runDetails !== false) console.log(JSON.stringify({ workflow_run_id: Math.max(...Object.keys(updated.runs).map(Number)) }));
  }
} else if (actionRun) {
  if (!data.runs?.[actionRun[1]]) fail('gh: Not Found (HTTP 404)');
  else console.log(JSON.stringify(data.runs[actionRun[1]]));
} else if (runJobs) {
  for (const row of data.runJobs?.[runJobs[1]] || []) console.log(JSON.stringify(row));
} else if (workflowRuns) {
  for (const run of Object.values(data.runs || {})) console.log(JSON.stringify(run));
} else if (pull) console.log(JSON.stringify(data.pull));
else if (commit) console.log(JSON.stringify(data.commits[commit[1]]));
else if (job?.[2]) {
  if (data.logs[job[1]] === undefined) fail('gh: Not Found (HTTP 404)');
  else if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(data.logs[job[1]]) && !args.includes('--allow-escape-sequences')) {
    fail('the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway');
  }
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
