'use strict';

// Shared by the stack-parent*.test.js files: a parent task's newer head and its stacked child.

const fs = require('node:fs');
const path = require('node:path');
const { fakeAgentEnv } = require('./helpers');
const { upper, resubmit } = require('./stack-fixture');

const events = (f) => fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

// A worker that records the head and prompt it was dispatched with.
function inspector(f) {
  const script = path.join(f.h.base, 'inspect-worker.js');
  const receipt = path.join(f.h.base, 'dispatch.json');
  fs.writeFileSync(script, `const fs = require('node:fs'), cp = require('node:child_process');
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  prompt: process.argv[2]
}));
`);
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort',
    '--env', JSON.stringify(fakeAgentEnv({ NODE_OPTIONS: f.h.env.NODE_OPTIONS })),
    '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
  return () => JSON.parse(fs.readFileSync(receipt, 'utf8'));
}

function reviewProbe(f) {
  const script = path.join(f.h.base, 'review-probe.js');
  fs.writeFileSync(script, 'process.exit(0);\n');
  for (const rung of ['easy', 'medium', 'hard', 'research', 'review']) {
    f.h.ok(['ladder', 'set', rung, '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort',
      '--env', JSON.stringify(fakeAgentEnv({ NODE_OPTIONS: f.h.env.NODE_OPTIONS })),
      '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
  }
}

// The child's own commit on its branch, submitted or not, conflicting with the parent's file or not.
function child(f, submitted, conflict) {
  if (submitted) {
    const top = upper(f);
    if (!conflict) return top;
    f.h.ok(['rework', 'T2', '--reason', 'child edits']);
    fs.writeFileSync(path.join(top.wt.path, 'T1.txt'), 'child\n');
    f.h.git(['add', 'T1.txt'], top.wt.path);
    f.h.git(['commit', '-qm', 'child edits'], top.wt.path);
    f.h.git(['push', 'origin', top.wt.branch], top.wt.path);
    const sha = f.h.git(['rev-parse', 'HEAD'], top.wt.path);
    f.write((d) => { d.prs[12].headRefOid = sha; });
    f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
    f.h.ok(['submit', 'T2', '--sha', sha, '--pr', '12', '--agent', 'worker-T2']);
    return { wt: top.wt, sha };
  }
  const wt = f.h.json(['worktree', 'T2']);
  const file = conflict ? 'T1.txt' : 'child.txt';
  fs.writeFileSync(path.join(wt.path, file), 'child\n');
  f.h.git(['add', file], wt.path);
  f.h.git(['commit', '-qm', 'child edits'], wt.path);
  f.h.git(['push', 'origin', wt.branch], wt.path);
  return { wt, sha: f.h.git(['rev-parse', 'HEAD'], wt.path) };
}

function newerParent(f, conflict) {
  if (conflict) fs.writeFileSync(path.join(f.lower.path, 'T1.txt'), 'parent\n');
  if (conflict) f.h.git(['add', 'T1.txt'], f.lower.path);
  return resubmit(f, false);
}

module.exports = { events, inspector, reviewProbe, child, newerParent };
