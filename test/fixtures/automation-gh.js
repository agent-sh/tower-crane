'use strict';

const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const { updateJson } = require('../atomic-file');
const { killPid } = require('../signals');
const args = process.argv.slice(2);
const file = process.env.AUTOMATION_GITHUB;
if (process.env.AUTOMATION_ENV_PROBE) {
  const { HOME, PATH, XDG_CACHE_HOME, TOWER_CRANE_SANDBOX, TOWER_CRANE_AGENT, TOWER_CRANE_TASK } = process.env;
  fs.appendFileSync(process.env.AUTOMATION_ENV_PROBE, JSON.stringify({ args, HOME, PATH, XDG_CACHE_HOME, TOWER_CRANE_SANDBOX, TOWER_CRANE_AGENT, TOWER_CRANE_TASK }) + '\n');
}
// Concurrent gh calls share the state file, so each one changes it under
// updateJson; a refusal or the crash leaves only after that write.
let out = '';
let refusal = null;
let crash = null;
updateJson(file, (state) => {
  state.calls ||= [];
  state.calls.push(args);
  answer(state);
  return state;
});
if (crash) {
  const events = require('../state-files').readEvents(path.join(crash, '.tower-crane'));
  const executor = events.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running');
  killPid(executor.detail.pid, 'SIGKILL');
  // The killed executor is the test's CLI call, so the test resumes now.
  process.exit(0);
}
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
console.log(out);

function answer(state) {
  if (args[0] === 'pr') {
    const pr = state.prs[args[2]];
    if (!pr) throw new Error(`unknown fixture PR ${args[2]}`);
    if (args[1] === 'view' && (state.failView || pr.failView)) {
      refusal = pr.failView ? `Could not resolve PullRequest number ${args[2]}` : 'GitHub transport unavailable';
      return;
    }
    if (args[1] === 'merge') {
      if (state.refuseMerge) {
        refusal = 'merge refused by fixture policy';
        return;
      }
      pr.state = 'MERGED';
      pr.mergeCommit = { oid: pr.headRefOid };
      if (state.advanceBase) cp.execFileSync('git', ['-C', state.root, 'update-ref', 'refs/heads/main', pr.headRefOid]);
      // The project root, for the events of the executor to kill.
      if (process.env.AUTOMATION_CRASH_AFTER_MERGE) crash = state.root;
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
  } else if (args[0] === 'api' && state.apiFailures > 0) {
    state.apiFailures -= 1;
    refusal = 'HTTP 502: Bad Gateway';
  } else if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
    // A reply on a review thread: pulls/N/comments/ID/replies with -f body=TEXT.
    const thread = Number(/\/pulls\/\d+\/comments\/(\d+)\/replies$/.exec(args[3])?.[1]);
    if (!thread) throw new Error(`unexpected fixture POST ${args[3]}`);
    const reply = { id: 900 + (state.comments || []).length, in_reply_to_id: thread, user: 'orchestrator-bot',
      body: args[args.indexOf('-f') + 1].replace(/^body=/, '') };
    (state.comments ||= []).push(reply);
    out = JSON.stringify({ id: reply.id, html_url: `https://github.com/acme/demo/pull/7#discussion_r${reply.id}` });
  } else if (args[0] === 'api' && /\/(?:pulls|issues)\/\d+\/comments(?:\?|$)/.test(args[1])) {
    // Already in the shape the caller's --jq filter produces: one comment per line.
    out = (state.comments || []).map((c) => JSON.stringify(c)).join('\n');
  } else if (args[0] === 'api') {
    const sha = /commits\/([a-f\d]+)/.exec(args[1])?.[1];
    const status = state.ci?.[sha] || 'success';
    const suite = args[1].includes('check-suites');
    // 'none' is CI that never started: no check runs or suites at the commit.
    out = status === 'none' ? '' : JSON.stringify({
      ...(suite ? { id: 1, runs: 1 } : { name: 'test', suite: 1 }),
      app: 'fixture', status: status === 'pending' ? 'in_progress' : 'completed',
      conclusion: status === 'pending' ? null : status,
    });
  }
}
