'use strict';

const { fakeAgentEnv } = require('../agent-env');

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const bin = process.argv[2];
  const mode = process.argv[3];
  const task = process.env.TOWER_CRANE_TASK;
  process.env.STUB_OUT = path.join(process.env.AUTOMATION_CONTEXT_DIR, `${process.env.TOWER_CRANE_AGENT}.json`);
  require('./harness-stub')('command');
  const report = JSON.parse(fs.readFileSync(process.env.STUB_OUT, 'utf8'));
  const target = /## Task\s+```json\n([\s\S]*?)\n```/.exec(report.prompt || '');
  if (!report.prompt?.includes('## Goal') || !target || JSON.parse(target[1]).id !== task) {
    throw new Error('missing startup goal or task');
  }
  const state = JSON.parse(fs.readFileSync(process.env.AUTOMATION_GITHUB, 'utf8'));
  const pr = state.prs['7'];
  const run = (args) => cp.execFileSync(process.execPath, [bin, ...args], { env: fakeAgentEnv(process.env), stdio: 'pipe' });
  if (process.env.AUTOMATION_POLICY_PROBE) {
    const denials = [['api', 'repos/acme/demo'], ['pr', 'merge', '7']].map((args) => {
      const r = cp.spawnSync('gh', args, { encoding: 'utf8' });
      return { status: r.status, stderr: r.stderr };
    });
    fs.appendFileSync(process.env.AUTOMATION_POLICY_PROBE, JSON.stringify({ path: process.env.PATH || process.env.Path, denials }) + '\n');
  }
  const taskState = JSON.parse(fs.readFileSync(path.join(process.env.TOWER_CRANE_STATE, 'tasks.json'), 'utf8'))
    .tasks.find((t) => t.id === task);
  if (mode === 'worker' || mode === 'auto' && taskState.status !== 'submitted') {
    run(['claim', task]);
    run(['submit', task, '--sha', pr.headRefOid, '--pr', '7']);
    if (process.env.AUTOMATION_WORKER_HOLD) {
      const hold = process.env.AUTOMATION_WORKER_HOLD;
      fs.writeFileSync(hold, '');
      await require('../signals').fileWritten(`${hold}.go`, { check: () => true });
      if (!fs.existsSync(`${hold}.go`)) throw new Error('worker release was not delivered');
    }
  } else if (process.env.AUTOMATION_REVIEW_CRASH_ONCE && !fs.existsSync(process.env.AUTOMATION_REVIEW_CRASH_ONCE)) {
    // The first reviewer fails without a verdict; later ones record it.
    fs.writeFileSync(process.env.AUTOMATION_REVIEW_CRASH_ONCE, '');
    process.exit(1);
  } else if (process.env.AUTOMATION_REVIEW_NOTE) {
    // A reviewer whose ok is refused notes why and exits 0 without a verdict.
    try {
      run(['evidence', task, '--type', 'review', '--sha', pr.headRefOid, '--ok']);
    } catch (e) {
      run(['task', 'note', task, `Review passed; evidence refused: ${String(e.stderr).trim()}`]);
    }
  } else {
    run(['evidence', task, '--type', 'review', '--sha', pr.headRefOid, '--ok']);
  }
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
