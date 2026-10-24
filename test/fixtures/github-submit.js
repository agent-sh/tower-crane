'use strict';

// Keeps GitHub offline while `submit --pr` and `check ci` read a PR's head, check runs and suites,
// its revuto inline comments and the logs of failing jobs. TEST_GITHUB names a JSON file with that data.
const fs = require('node:fs');
const cp = require('node:child_process');
const original = cp.spawnSync;

function lines(items) {
  return { status: 0, stdout: items.map((item) => JSON.stringify(item)).join('\n'), stderr: '' };
}

cp.spawnSync = function github(file, args, ...rest) {
  if (file !== 'gh') return original.call(this, file, args, ...rest);
  const data = JSON.parse(fs.readFileSync(process.env.TEST_GITHUB, 'utf8'));
  // The gh shim of a harness without an OS sandbox refuses gh api (lib/shim.js).
  if (data.refuseApi && args[0] === 'api') {
    return { status: 126, stdout: '', stderr: `tower-crane: gh ${args.join(' ')} is not allowed by this agent's agent file\n` };
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const pr = { state: 'OPEN', headRefName: 'task/change', headRefOid: data.sha, ...(data.pr || { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }) };
    return { status: 0, stdout: JSON.stringify(pr), stderr: '' };
  }
  if (args[0] === 'run' && args[1] === 'view') {
    const log = data.logs?.[args[args.indexOf('--job') + 1]];
    return log === undefined ? { status: 1, stdout: '', stderr: 'no log for this job' } : { status: 0, stdout: log, stderr: '' };
  }
  if (args[0] === 'api' && args.includes('--paginate')) {
    const endpoint = args[1];
    if (endpoint === `repos/acme/app/commits/${data.sha}/check-runs?per_page=100`) return lines(data.runs);
    if (endpoint === `repos/acme/app/commits/${data.sha}/check-suites?per_page=100`) return lines(data.suites);
    if (endpoint === `repos/acme/app/actions/runs?head_sha=${data.sha}&per_page=100`) return lines(data.workflows || []);
    if (endpoint === 'repos/acme/app/pulls/7/comments?per_page=100') return lines(data.comments || []);
    if (endpoint.startsWith('repos/acme/app/actions/runs?branch=')) {
      if (data.historyError) return { status: 1, stdout: '', stderr: data.historyError };
      if (data.historyInvalid) return { status: 0, stdout: '{invalid', stderr: '' };
      return lines(data.heads || []);
    }
  }
  throw new Error(`unexpected gh call: ${args.join(' ')}`);
};
