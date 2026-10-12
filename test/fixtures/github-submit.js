'use strict';

// Keeps GitHub offline while `submit --pr` reads a PR's check runs and suites, its revuto inline
// comments and the logs of failing jobs. TEST_GITHUB names a JSON file with that data. `briefSet`
// names a brief the orchestrator writes while the check runs are read; TEST_OWNER_KEY is the owner
// key that write presents, since the CLI gives its children no key.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const original = cp.spawnSync;
const CLI = path.join(__dirname, '..', '..', 'bin', 'tower-crane.js');

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
    return { status: 0, stdout: JSON.stringify(data.pr || { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), stderr: '' };
  }
  if (args[0] === 'run' && args[1] === 'view') {
    const log = data.logs?.[args[args.indexOf('--job') + 1]];
    return log === undefined ? { status: 1, stdout: '', stderr: 'no log for this job' } : { status: 0, stdout: log, stderr: '' };
  }
  if (args[0] === 'api' && args.includes('--paginate')) {
    const endpoint = args[1];
    if (endpoint === `repos/acme/app/commits/${data.sha}/check-runs?per_page=100`) {
      if (data.briefSet) {
        const env = { ...process.env, TOWER_CRANE_AGENT: 'owner', TOWER_CRANE_OWNER_KEY: process.env.TEST_OWNER_KEY };
        const set = original.call(this, process.execPath, [CLI, 'brief', 'set', 'T1', '--file', data.briefSet], { env, encoding: 'utf8' });
        if (set.status !== 0) throw new Error(`brief set during the read failed: ${set.stderr}`);
      }
      return lines(data.runs);
    }
    if (endpoint === `repos/acme/app/commits/${data.sha}/check-suites?per_page=100`) return lines(data.suites);
    if (endpoint === `repos/acme/app/actions/runs?head_sha=${data.sha}&per_page=100`) return lines(data.workflows || []);
    if (endpoint === 'repos/acme/app/pulls/7/comments?per_page=100') return lines(data.comments || []);
  }
  throw new Error(`unexpected gh call: ${args.join(' ')}`);
};
