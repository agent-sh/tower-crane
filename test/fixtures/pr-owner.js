'use strict';

// A worker that owns its PR: it submits the next head in OWNER_HEADS (one per
// submit the task already has), waits with wait --own, and on each handback
// submits the next one, until its ownership ends. Each wait's outcome is
// appended to OWNER_LOG. OWNER_CI_FAIL names a head whose CI fails once it is
// submitted. OWNER_NO_PR submits without a PR; OWNER_CRASH_ON_FIX
// exits 1 at the first handback, as a crashed session would. As a reviewer it
// fails the first review with a finding when OWNER_REVIEW_FAIL_ONCE names a
// marker file that does not exist yet, and passes every other one.

const { fakeAgentEnv } = require('../agent-env');
const { updateJson } = require('../atomic-file');
const cp = require('node:child_process');
const fs = require('node:fs');

const bin = process.argv[2];
const role = /^reviewer-/.test(process.env.TOWER_CRANE_AGENT) ? 'reviewer' : 'worker';
const task = process.env.TOWER_CRANE_TASK;
const env = fakeAgentEnv(process.env);
const run = (args) => cp.spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
const ok = (args) => {
  const r = run(args);
  if (r.status !== 0) throw new Error(`${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};
const github = () => JSON.parse(fs.readFileSync(process.env.AUTOMATION_GITHUB, 'utf8'));

if (role === 'reviewer') {
  const head = github().prs['7'].headRefOid;
  const marker = process.env.OWNER_REVIEW_FAIL_ONCE;
  if (marker && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, '');
    ok(['evidence', task, '--type', 'review', '--sha', head, '--fail', '--summary', 'value.js: the exported value must be 2, not 1',
      '--findings', JSON.stringify([{ kind: 'defect', path: 'value.js', claim: 'the exported value must be 2, not 1' }])]);
  } else {
    ok(['evidence', task, '--type', 'review', '--sha', head, '--ok']);
  }
} else {
  const heads = JSON.parse(process.env.OWNER_HEADS);
  const events = fs.readFileSync(`${process.env.TOWER_CRANE_STATE}/events.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  let next = events.filter((e) => e.cmd === 'submit' && e.task === task).length;
  ok(['claim', task]);
  for (;;) {
    const sha = heads[Math.min(next, heads.length - 1)];
    if (process.env.OWNER_NO_PR) ok(['submit', task, '--sha', sha]);
    else {
      // The PR head moves with the push, and its CI reads green there.
      updateJson(process.env.AUTOMATION_GITHUB, (state) => {
        state.prs['7'].headRefOid = sha;
        state.ci[sha] = 'success';
        return state;
      });
      ok(['submit', task, '--sha', sha, '--pr', '7']);
      if (sha === process.env.OWNER_CI_FAIL) {
        updateJson(process.env.AUTOMATION_GITHUB, (state) => {
          state.ci[sha] = 'failure';
          return state;
        });
      }
    }
    let outcome;
    do {
      const r = run(['wait', '--own', '--task', task, '--timeout', '60', '--json']); // wait-allow: a timed-out wait --own repeats, as the worker skill says; it is no deadline
      if (![0, 2].includes(r.status)) throw new Error(`wait --own exited ${r.status}: ${r.stderr}`);
      outcome = JSON.parse(r.stdout);
      fs.appendFileSync(process.env.OWNER_LOG, `${JSON.stringify({ agent: process.env.TOWER_CRANE_AGENT, ...outcome })}\n`);
    } while (outcome.outcome === 'wait');
    if (outcome.outcome !== 'fix') break;
    if (process.env.OWNER_CRASH_ON_FIX) process.exit(1);
    next += 1;
  }
}
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
