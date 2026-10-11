'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const original = cp.spawnSync;
const now = Date.now;
let skew = 0;
Date.now = () => now() + skew;
const BIN = path.join(__dirname, '..', '..', 'bin', 'tower-crane.js');
const { ownerKeyFile, ownerProject } = require('../../lib/authority');

// Holds a gh call open until the test releases it, so another command can run meanwhile.
function pause(ready, release) {
  fs.writeFileSync(ready, 'ready');
  const deadline = performance.now() + 20000;
  while (!fs.existsSync(release)) {
    if (performance.now() > deadline) throw new Error('paused gh fixture was not released');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

// Only GitHub is stubbed. Worktrees, commits, fetches and the bare remote are real.
cp.spawnSync = function stackGh(command, args, opts) {
  if (command !== 'gh' || !process.env.TEST_STACK_DATA) return original(command, args, opts);
  const file = process.env.TEST_STACK_DATA;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.calls.push({ args, cwd: opts.cwd });
  const finish = (value = '', status = 0, stderr = '') => {
    fs.writeFileSync(file, JSON.stringify(data));
    return { status, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr };
  };
  const response = (r, fallback = '') => {
    skew += r.advanceMs || 0;
    return finish(r.body ?? fallback, r.code || 0, r.error || '');
  };
  // data.during runs tower-crane commands once while this gh call is in flight.
  // The CLI drops TOWER_CRANE_OWNER_KEY before it runs gh, so these commands
  // present the owner's key from its file, as the owner would.
  const key = /\/merge-async$/.test(args[1] || '') ? 'merge-async' : args.slice(0, 2).join(' ');
  for (const cli of data.during?.[key] || []) {
    const project = ownerProject(path.join(data.repo, '.tower-crane'));
    const env = { ...process.env, TOWER_CRANE_OWNER_KEY: fs.readFileSync(ownerKeyFile(project), 'utf8').trim() };
    const r = original(process.execPath, [BIN, ...cli], { cwd: data.repo, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tower-crane ${cli.join(' ')} failed: ${r.stderr}`);
  }
  if (data.during) delete data.during[key];
  if (key === 'pr view' && args[2] === process.env.TEST_STACK_PAUSE_VIEW) {
    pause(process.env.TEST_STACK_PAUSE_READY, process.env.TEST_STACK_PAUSE_RELEASE);
  }
  const git = (gitArgs) => {
    const r = original('git', gitArgs, { ...opts, cwd: data.repo });
    if (r.status !== 0) throw new Error(String(r.stderr));
    return String(r.stdout).trim();
  };
  // A fast-forward when main has not moved, otherwise a squash commit on it.
  const landBranch = (branch) => {
    const head = git(['rev-parse', `refs/heads/${branch}`]);
    const main = git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
    if (git(['merge-base', head, main]) === main) return git(['push', 'origin', `${head}:refs/heads/main`]);
    const tree = git(['merge-tree', '--write-tree', main, head]).split('\n')[0];
    git(['push', 'origin', `${git(['commit-tree', tree, '-p', main, '-m', `squash ${branch}`])}:refs/heads/main`]);
  };
  const asyncPath = args[0] === 'api' ? /pulls\/(\d+)\/merge-async(?:\/(.+))?$/.exec(args[1]) : null;
  const posted = asyncPath && !asyncPath[2] && args[args.indexOf('--method') + 1] === 'POST';
  const mergeOf = args[0] === 'pr' && args[1] === 'merge' ? Number(args[2]) : posted ? Number(asyncPath[1]) : null;
  if (mergeOf && data.moveOnMerge && (!data.moveOnMerge.onPr || mergeOf === data.moveOnMerge.onPr)) {
    const { pr, head, base } = data.moveOnMerge;
    if (head !== undefined) data.prs[pr].headRefOid = head;
    if (base !== undefined) data.prs[pr].baseRefName = base;
    delete data.moveOnMerge;
  }
  const land = (pr, parents, subject, deleteBranch) => {
    const base = git(['rev-parse', `refs/remotes/origin/${pr.baseRefName}`]);
    const merged = original('git', ['merge-tree', '--write-tree', base, pr.headRefOid], { ...opts, cwd: data.repo });
    if (merged.status !== 0) return `PR has conflicts: ${merged.stdout}${merged.stderr}`;
    const tree = String(merged.stdout).trim().split(/\r?\n/)[0];
    const oid = git(['commit-tree', tree, '-p', base, ...(parents === 2 ? ['-p', pr.headRefOid] : []), '-m', subject]);
    git(['push', 'origin', `${oid}:${pr.baseRefName}`]);
    pr.state = 'MERGED';
    pr.mergeCommit = { oid };
    if (deleteBranch) git(['push', 'origin', `:${pr.headRefName}`]);
    // GitHub rebases the PRs above the merged one onto the new base.
    const end = data.order.indexOf(pr.number);
    for (const n of end === -1 ? [] : data.order.slice(end + 1)) {
      if (data.rebased?.[n]) data.prs[n].headRefOid = data.rebased[n];
    }
    return null;
  };
  if (args[0] === 'api') {
    if (data.apiFailure) {
      const failure = data.apiFailure;
      const result = finish(failure.stdout || '', failure.status === undefined ? 1 : failure.status, failure.stderr || '');
      if (failure.error) result.error = failure.error;
      return result;
    }
    if (data.unavailable) return finish('', 9, 'Stacked pull requests are not enabled');
    if (args[1].includes('/stacks')) return finish(data.linked ? [{ id: 5, pull_requests: data.order.map((number) => ({ number })) }] : []);
    // GitHub's asynchronous merge: the POST pins the head and returns at once; the merge
    // lands only when a later status poll finds it complete.
    if (posted) {
      const pr = data.prs[asyncPath[1]];
      const field = (name) => args.find((a, i) => args[i - 1] === '-f' && a.startsWith(`${name}=`))?.slice(name.length + 1);
      if (field('expected_head_sha') !== pr.headRefOid) return finish('', 1, 'gh: Head branch was modified. Review and try the merge again. (HTTP 409)');
      if (data.refuseMergePr === pr.number) return finish('', 1, 'gh: Base branch policy prohibits the merge (HTTP 405)');
      const replies = data.asyncResponses?.[pr.number];
      if (replies) {
        replies.started = true;
        if (replies.post) return response(replies.post);
      }
      data.asyncMerges = data.asyncMerges || {};
      const id = `m${Object.keys(data.asyncMerges).length + 1}`;
      data.asyncMerges[id] = { pr: pr.number, method: field('merge_method') };
      return finish({ id, status: 'pending' });
    }
    if (asyncPath) {
      const job = data.asyncMerges[asyncPath[2]];
      const pr = data.prs[job.pr];
      const reply = data.asyncResponses?.[pr.number]?.polls?.shift();
      if (reply) return response(reply);
      // data.pollFailures[pr] lists errors for successive polls. GitHub retires a finished
      // job, so a 404 comes after the merge lands; a 5xx leaves the merge pending.
      const failure = data.pollFailures?.[pr.number]?.shift();
      if (failure) {
        if (/404/.test(failure) && pr.state !== 'MERGED') land(pr, job.method === 'merge' ? 2 : 1, `Merge pull request #${pr.number}`, false);
        if (data.queued) skew += 24 * 60 * 60 * 1000;
        return finish('', 1, failure);
      }
      if (data.queued) {
        // Jump the merge process's clock past the poll deadline instead of waiting it out.
        skew += 24 * 60 * 60 * 1000;
        return finish({ id: asyncPath[2], status: 'queued' });
      }
      if (data.asyncFail === pr.number) return finish({ id: asyncPath[2], status: 'failed', error: 'Merge conflict in T2.txt' });
      if (pr.state !== 'MERGED') {
        const conflict = land(pr, job.method === 'merge' ? 2 : 1, `Merge pull request #${pr.number}`, false);
        if (conflict) return finish({ id: asyncPath[2], status: 'failed', error: conflict });
      }
      return finish({ id: asyncPath[2], status: 'completed' });
    }
    return finish({ name: 'build', app: 'ci', status: 'completed', conclusion: 'success', runs: 1 });
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    const pr = data.prs[args[2]];
    if (!pr) return finish('', 1, 'missing PR');
    if (data.generatedProbe) {
      pr.headRepository = { nameWithOwner: 'acme/app' };
      pr.url = `https://github.com/acme/app/pull/${pr.number}`;
      pr.mergeable ||= 'MERGEABLE';
      pr.mergeStateStatus ||= 'CLEAN';
      if (pr.number === data.generatedProbe.upper && data.prs[data.generatedProbe.lower].state === 'MERGED') {
        if (!data.generatedProbe.unmergedParent) pr.baseRefName = 'main';
        const head = git(['ls-remote', 'origin', `refs/heads/${pr.headRefName}`]).split(/\s/)[0];
        if (head !== pr.headRefOid) {
          pr.headRefOid = head;
          data.generatedProbe.repaired = true;
        }
        pr.mergeable = data.generatedProbe.repaired ? 'MERGEABLE' : data.generatedProbe.mergeable;
        pr.mergeStateStatus = pr.mergeable === 'CONFLICTING' ? 'DIRTY' : pr.mergeable === 'UNKNOWN' ? 'UNKNOWN' : 'CLEAN';
      }
    }
    const replies = data.asyncResponses?.[pr.number];
    const reply = replies?.started && replies.views?.shift();
    if (reply?.merge) land(pr, 2, `Merge pull request #${pr.number}`, false);
    if (reply) return response(reply, pr);
    return finish(pr);
  }
  if (args[0] === 'pr' && args[1] === 'edit') {
    data.prs[args[2]].baseRefName = args[args.indexOf('--base') + 1];
    return finish();
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const pr = data.prs[args[2]];
    if (data.linked && !data.unavailable && data.order.includes(pr.number)) {
      return finish('', 1, 'GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API (mergePullRequest)');
    }
    const match = args.indexOf('--match-head-commit');
    if (match !== -1 && args[match + 1] !== pr.headRefOid) return finish('', 1, 'PR head moved; head commit does not match');
    if (data.queued) return finish('queued');
    if (data.refuseMergePr === Number(args[2])) return finish('', 1, 'Base branch policy prohibits the merge');
    const subject = args.includes('--subject') ? args[args.indexOf('--subject') + 1] : `Merge PR #${pr.number}`;
    const conflict = land(pr, args.includes('--merge') ? 2 : 1, subject, args.includes('--delete-branch'));
    return conflict ? finish('', 1, conflict) : finish();
  }
  if (args[0] !== 'stack') throw new Error(`unexpected gh: ${args}`);
  if (data.missingExtension) return finish('', 1, 'gh stack is available as an official extension.\nTo install it, run: gh extension install github/gh-stack\n');
  if (args[1] === '--version') return finish(`gh-stack v${data.version || '0.2.0'}`);
  if (data.unavailable) return finish('', 9, 'Stacked pull requests are not enabled');
  if (args[1] === 'link') {
    if (process.env.TEST_STACK_LINK_READY) {
      fs.writeFileSync(process.env.TEST_STACK_LINK_READY, 'ready');
      const deadline = performance.now() + 20000;
      while (!fs.existsSync(process.env.TEST_STACK_LINK_RELEASE)) {
        if (performance.now() > deadline) throw new Error('slow link fixture was not released');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    data.linked = true;
    data.order = args.slice(2, args.indexOf('--base')).map(Number);
    return finish();
  }
  if (args[1] === 'checkout') {
    if (data.inspectWorktrees) {
      const adminRoot = path.join(data.repo, '.git', 'worktrees');
      for (const name of fs.readdirSync(adminRoot)) {
        if (!fs.existsSync(path.join(adminRoot, name, 'gitdir'))) {
          return finish('Sync aborted; no changes were made', 1, `listing worktrees: reading worktree administration directory "${name}"`);
        }
      }
    }
    if (data.checkoutError) return finish('', 1, data.checkoutError);
    return finish(opts.cwd);
  }
  if (args[1] === 'unstack') { data.linked = false; return finish(); }
  if (args[1] === 'merge') {
    if (data.queued) return finish('queued');
    if (data.mergeUnavailable) return finish('', 9, 'Stacked pull requests are not enabled');
    const end = data.order.indexOf(Number(args[2]));
    for (const n of data.order.slice(0, end + 1)) {
      data.prs[n].state = 'MERGED';
      data.prs[n].mergeCommit = { oid: data.prs[n].headRefOid };
    }
    landBranch(data.prs[args[2]].headRefName);
    return finish();
  }
  if (args[1] === 'sync') {
    if (process.env.TEST_STACK_SYNC_READY) {
      fs.writeFileSync(process.env.TEST_STACK_SYNC_READY, 'ready');
      const deadline = performance.now() + 20000;
      while (!fs.existsSync(process.env.TEST_STACK_SYNC_RELEASE)) {
        if (performance.now() > deadline) throw new Error('slow gh fixture was not released');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (data.conflict) return finish('\x1b[31mConflict detected rebasing upper onto main\x1b[0m\nAll branches restored', 1, 'Sync aborted; no changes were made');
    if (data.syncCommit) {
      const r = original('git', ['-C', opts.cwd, 'commit', '--allow-empty', '-qm', 'sync refresh'], opts);
      if (r.status !== 0) throw new Error(String(r.stderr));
      const head = original('git', ['-C', opts.cwd, 'rev-parse', 'HEAD'], opts).stdout.trim();
      const pr = Object.values(data.prs).find((p) => p.headRefName === git(['-C', opts.cwd, 'branch', '--show-current']));
      pr.headRefOid = head;
      git(['push', 'origin', pr.headRefName]);
    }
    if (data.syncError) return finish(data.syncOutput || '', 1, data.syncError);
    return finish();
  }
  throw new Error(`unexpected gh stack: ${args}`);
};
