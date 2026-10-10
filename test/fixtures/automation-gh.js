'use strict';

const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const file = process.env.AUTOMATION_GITHUB;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls ||= [];
state.calls.push(args);
// Write through a rename so a test reading the file never sees it truncated.
const save = () => {
  fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify(state));
  fs.renameSync(`${file}.${process.pid}`, file);
};
let out = '';
if (args[0] === 'pr') {
  const pr = state.prs[args[2]];
  if (!pr) throw new Error(`unknown fixture PR ${args[2]}`);
  if (args[1] === 'view' && (state.failView || pr.failView)) {
    save();
    console.error(pr.failView ? `Could not resolve PullRequest number ${args[2]}` : 'GitHub transport unavailable');
    process.exit(1);
  }
  if (args[1] === 'merge') {
    if (state.refuseMerge) {
      save();
      console.error('merge refused by fixture policy');
      process.exit(1);
    }
    pr.state = 'MERGED';
    pr.mergeCommit = { oid: pr.headRefOid };
    if (state.advanceBase) cp.execFileSync('git', ['-C', state.root, 'update-ref', 'refs/heads/main', pr.headRefOid]);
    if (process.env.AUTOMATION_CRASH_AFTER_MERGE) {
      save();
      const events = fs.readFileSync(path.join(state.root, '.tower-crane', 'events.jsonl'), 'utf8')
        .trim().split('\n').map(JSON.parse);
      const executor = events.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running');
      process.kill(executor.detail.pid, 'SIGKILL');
      // The killed executor is the test's CLI call, so the test resumes now.
      // The test reads the file as soon as the executor dies; a second write
      // from this orphaned call could truncate it under that read.
      process.exit(0);
    }
  } else {
    if (state.remote) {
      const head = cp.execFileSync('git', ['--git-dir', state.remote, 'rev-parse', `refs/heads/${pr.headRefName}`], { encoding: 'utf8' }).trim();
      if (head !== pr.headRefOid) {
        pr.headRefOid = head;
        pr.mergeable = 'MERGEABLE';
        pr.mergeStateStatus = 'CLEAN';
        state.ci[head] = 'pending';
      }
    }
    // unknownViews answers UNKNOWN for that many reads, as GitHub does while it computes mergeability.
    const unknown = pr.unknownViews > 0;
    if (unknown) pr.unknownViews -= 1;
    const view = unknown ? { ...pr, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } : pr;
    const target = args[args.indexOf('-R') + 1];
    const destination = state.pushRepository && target !== 'acme/demo'
      ? { ...view, url: `https://github.com/${state.pushRepository}/pull/${args[2]}`,
        headRepository: { nameWithOwner: state.pushRepository } } : view;
    out = pr.invalidView ? '{' : JSON.stringify(destination);
    if (state.becomeMergeableAfterView) {
      pr.mergeable = 'MERGEABLE';
      pr.mergeStateStatus = 'CLEAN';
      state.becomeMergeableAfterView = false;
    }
  }
} else if (args[0] === 'api' && /\/pulls\/\d+\/comments$/.test(args[1])) {
  // Already in the shape the caller's --jq filter produces: one comment per line.
  out = (state.comments || []).map((c) => JSON.stringify(c)).join('\n');
} else if (args[0] === 'api') {
  const sha = /commits\/([a-f\d]+)/.exec(args[1])?.[1];
  const status = state.ci?.[sha] || 'success';
  const suite = args[1].includes('check-suites');
  out = JSON.stringify({
    ...(suite ? { id: 1, runs: 1 } : { name: 'test', suite: 1 }),
    app: 'fixture', status: status === 'pending' ? 'in_progress' : 'completed',
    conclusion: status === 'pending' ? null : status,
  });
}
save();
console.log(out);
