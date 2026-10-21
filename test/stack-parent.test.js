'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, upper, resubmit } = require('./stack-fixture');
const { fakeAgentEnv } = require('./helpers');
const Stack = require('../lib/stack');
const Check = require('../lib/check');

const events = (f) => fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('acceptance and review parent snapshots detect a newer submission at application', () => {
  for (const operation of ['accept', 'review']) {
    for (const change of ['unchanged', 'claim', 'sha', 'parent', 'missing sha']) {
      const dep = { id: 'T1', sha: 'a'.repeat(40), revision: 1, status: 'submitted', evidence: [] };
      const other = { ...dep, id: 'T3', sha: 'b'.repeat(40), evidence: [] };
      const child = { id: 'T2', stack: { parent: 'T1' } };
      const st = { tasks: { tasks: [dep, child, other] }, events: [] };
      const expected = Check.parentHeadInputs(st, child);
      if (change === 'claim') dep.status = 'in_progress';
      if (change === 'sha') dep.sha = 'c'.repeat(40);
      if (change === 'parent') child.stack.parent = 'T3';
      if (change === 'missing sha') dep.sha = null;
      if (['unchanged', 'claim'].includes(change)) Check.validateParentHead(st, child, expected, operation);
      else assert.throws(() => Check.validateParentHead(st, child, expected, operation), /parent head changed/);
    }
  }
});

test('parent refresh eligibility preserves lifecycle validation', () => {
  const old = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const landed = (st, task) => {
    const entry = { type: 'merge', source: 'merge', sha: task.sha, revision: task.revision, agent: 'orchestrator',
      ok: true, commands: [{ command: 'gh', args: ['pr', 'merge'], status: 0 }] };
    task.evidence.push(entry);
    st.events.push({ task: task.id, cmd: 'merge', agent: entry.agent, detail: entry });
  };
  const cases = [
    ['submitted', () => {}, true],
    ['accepted', (_, dep) => { dep.status = 'accepted'; }, true],
    ['unchanged head', (_, dep) => { dep.sha = old; }, false],
    ['no head', (_, dep) => { dep.sha = null; }, false],
    ['no branch', (_, dep) => { dep.branch = null; }, false],
    ...['todo', 'rework', 'in_progress', 'cancelled'].map((status) => [status, (_, dep) => { dep.status = status; }, false]),
    ['merged parent', (st, dep) => { dep.status = 'accepted'; landed(st, dep); }, false],
    ['retiring parent', (_, dep) => { dep.retiring = { pid: process.pid }; }, false],
    ['shared retirement reservation', (st, dep) => {
      st.tasks.tasks.push({ id: 'T3', retiring: { pid: process.pid, branch: dep.branch } });
    }, false],
    ['orphan retirement reservation', (st, dep) => {
      st.tasks.orphan_retirements = [{ pid: process.pid, branch: dep.branch }];
    }, false],
    ['disabled stack', (_, dep, child) => { dep.status = 'accepted'; child.stack_disabled = true; }, true],
    ['unstacked child', (_, dep, child) => { delete child.stack; }, false],
    ['cancelled child', (_, dep, child) => { child.status = 'cancelled'; }, false],
    ['merged child', (st, dep, child) => { child.status = 'accepted'; landed(st, child); }, false],
  ];
  for (const [name, change, expected] of cases) {
    const dep = { id: 'T1', status: 'submitted', sha: newer, branch: 'lower', revision: 1, evidence: [] };
    const child = { id: 'T2', status: 'rework', sha: old, revision: 1, evidence: [],
      stack: { parent: 'T1', parent_sha: old } };
    const st = { tasks: { tasks: [dep, child] }, events: [] };
    change(st, dep, child);
    assert.equal(Stack.parentRefreshNeeded(st, child), expected, name);
  }
});

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

function failReview(f, top, kind = 'code') {
  const ref = 'https://github.com/acme/app/pull/12#issuecomment-501';
  const file = kind === 'changelog' ? 'changelog.d/T2.md' : 'lib/child.js';
  const body = `Review (Tower Crane)\nSHA: ${top.sha}\nVerdict: FAIL\n${file}:1 - fix the finding`;
  f.write((data) => { data.comments = kind === 'missing' ? [] : [{ id: 501, body, html_url: ref }]; });
  f.h.ok(['evidence', 'T2', '--type', 'review', '--fail', '--sha', top.sha, '--revision', '1',
    '--summary', body, '--ref', ref, '--findings', JSON.stringify([
      { kind: kind === 'changelog' ? 'false-claim' : 'defect', path: file, claim: 'fix the finding' },
    ])]);
}

function reviewEntry(f, entry) {
  return f.h.run(entry === 'review spawn' ? ['spawn', '--task', 'T2', '--role', 'review', '--wait']
    : ['accept', 'T2', ...(entry === 'waived accept' ? ['--waive', 'review', '--reason', 'offline fixture'] : [])]);
}

for (const entry of ['accept', 'waived accept', 'review spawn']) {
  for (const parentStatus of ['submitted', 'accepted', 'rework', 'in_progress']) {
    test(`current FAIL takes precedence over parent ${parentStatus} in ${entry}`, (t) => {
      const f = setup(t);
      const top = upper(f);
      f.h.ok(['check', 'ci', 'T2']);
      failReview(f, top);
      resubmit(f, false);
      if (parentStatus === 'accepted') f.accept('T1');
      if (['rework', 'in_progress'].includes(parentStatus)) f.h.ok(['rework', 'T1', '--reason', 'parent continues']);
      if (parentStatus === 'in_progress') f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
      const result = reviewEntry(f, entry);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /current review FAIL/);
      const task = f.h.json(['task', 'show', 'T2']);
      assert.equal(task.status, 'rework');
      const rework = events(f).findLast((e) => e.task === 'T2' && e.cmd === 'rework');
      assert.equal(rework.detail.from_review, true);
      assert.equal(rework.detail.previous_revision, 1);
      assert.equal(task.stack.parent_sha, f.sha, 'failed review is recovered before parent synchronization');
      assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
    });
  }
}

for (const entry of ['accept', 'review spawn']) {
  for (const kind of ['changelog', 'missing']) {
    test(`current FAIL ${kind} findings are handled before refresh in ${entry}`, (t) => {
      const f = setup(t);
      const top = upper(f);
      f.h.ok(['check', 'ci', 'T2']);
      failReview(f, top, kind);
      resubmit(f, false);
      const result = reviewEntry(f, entry);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      const task = f.h.json(['task', 'show', 'T2']);
      if (kind === 'missing') {
        assert.equal(task.status, 'submitted');
        assert.match(result.stderr, /linked review comment/);
      } else {
        assert.equal(task.status, 'rework');
        assert.equal(events(f).findLast((e) => e.task === 'T2' && e.cmd === 'rework').detail.from_review, true);
      }
      assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
    });
  }
}

for (const status of ['todo', 'rework', 'in_progress']) {
  for (const newer of [false, true]) {
    test(`unsubmitted ${status} review preview ignores ${newer ? 'newer' : 'current'} parent ancestry`, (t) => {
      const f = setup(t);
      if (status === 'rework') {
        upper(f);
        f.h.ok(['rework', 'T2', '--reason', 'child continues']);
      } else f.h.ok(['worktree', 'T2']);
      if (status === 'in_progress') f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
      if (newer) resubmit(f, false);
      reviewProbe(f);
      const before = f.h.json(['task', 'show', 'T2']);
      const offset = events(f).length;
      const result = f.h.run(['spawn', '--task', 'T2', '--role', 'review', '--dry-run', '--json']);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.ok(JSON.parse(result.stdout).argv, 'fallback command is previewed');
      assert.deepEqual(f.h.json(['task', 'show', 'T2']), before);
      assert.equal(events(f).length, offset, 'preview publishes no state');
    });
  }
}

for (const linked of [false, true]) {
  for (const [dirty, timing] of [['unstaged', 'before'], ['staged', 'before'], ['untracked', 'before'], ['untracked', 'during merge']]) {
    test(`dirty ${dirty} ${linked ? 'linked' : 'prepared'} child defers its parent refresh and dispatches (${timing})`, (t) => {
      const f = setup(t);
      let top;
      if (linked) {
        top = upper(f);
        f.h.ok(['rework', 'T2', '--reason', 'child continues']);
      } else top = child(f, false, false);
      const parent = resubmit(f, false);
      const name = dirty === 'untracked' ? 'pending.txt' : linked ? 'T2.txt' : 'child.txt';
      if (timing === 'during merge') f.h.env.TEST_STACK_DIRTY_AFTER_MERGE = path.join(top.wt.path, name);
      else fs.writeFileSync(path.join(top.wt.path, name), 'pending edits\n');
      if (dirty === 'staged') f.h.git(['add', name], top.wt.path);
      const status = f.h.git(['status', '--porcelain'], top.wt.path);
      const inspect = inspector(f);
      const result = f.h.run(['spawn', '--task', 'T2', '--wait', '--json']);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(inspect().head, top.sha);
      assert.match(inspect().prompt, new RegExp(parent));
      assert.equal(f.h.git(['status', '--porcelain'], top.wt.path), timing === 'during merge' ? `?? ${name}` : status);
      assert.equal(fs.readFileSync(path.join(top.wt.path, name), 'utf8'), 'pending edits\n');
      assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, f.sha);
      const gate = f.h.run(['check', 'ci', 'T2']);
      assert.equal(gate.code, 1);
      assert.match(gate.stderr, new RegExp(`containing T1 at ${parent}`));
    });
  }
}

for (const busy of ['live', 'dirty']) {
  for (const linked of [false, true]) {
    test(`parent refresh records ${busy} ${linked ? 'linked' : 'prepared'} deferral once per parent head`, (t) => {
      const f = setup(t);
      const top = linked ? upper(f) : child(f, false, false);
      if (linked) f.h.ok(['rework', 'T2', '--reason', 'child continues']);
      if (busy === 'live') f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
      else fs.writeFileSync(path.join(top.wt.path, 'pending.txt'), 'pending edits\n');
      const count = (sha) => events(f).filter((e) => e.task === 'T2' && e.cmd === 'stack sync deferred' && e.detail.parent_sha === sha).length;
      const refresh = () => {
        f.h.run(['check', 'ci', 'T2']);
        if (linked) f.h.ok(['worktree', 'T1']);
      };
      const first = resubmit(f, false);
      refresh();
      refresh();
      assert.equal(count(first), 1);
      fs.writeFileSync(path.join(f.lower.path, 'T1c.txt'), 'another parent head\n');
      f.h.git(['add', 'T1c.txt'], f.lower.path);
      const second = resubmit(f, false);
      refresh();
      refresh();
      assert.equal(count(second), 1);
      assert.equal(events(f).filter((e) => e.task === 'T2' && e.cmd === 'stack sync deferred').length, 2);
      assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
    });
  }
}

for (const entry of ['waived accept', 'accept review', 'review dry-run', 'review spawn', 'unlinked review', 'automatic accept', 'automatic review']) {
  for (const stale of [false, true]) {
    test(`${entry} ${stale ? 'refuses stale' : 'allows current'} stacked child after cached software gates`, (t) => {
      const f = setup(t);
      const top = upper(f);
      if (entry === 'unlinked review') f.h.ok(['stack', 'unstack', 'T2']);
      f.h.ok(['check', 'ci', 'T2']);
      reviewProbe(f);
      Object.assign(f.h.env, {
        USERPROFILE: f.h.env.HOME, CLAUDE_CONFIG_DIR: path.join(f.h.env.HOME, '.claude'),
        CODEX_HOME: path.join(f.h.env.HOME, '.codex'), GH_CONFIG_DIR: path.join(f.h.env.HOME, '.config', 'gh'),
        XDG_CONFIG_HOME: path.join(f.h.env.HOME, '.config'), XDG_DATA_HOME: path.join(f.h.env.HOME, '.local', 'share'),
      });
      if (entry === 'automatic accept') f.h.ok(['evidence', 'T2', '--type', 'review', '--ok', '--sha', top.sha, '--revision', '1']);
      if (entry === 'automatic review') {
        // A native submission needs an exited worker receipt for automatic review.
        const at = new Date().toISOString();
        const detail = { agent: 'worker-T2', role: 'worker', sha: top.sha, revision: 1, pid: 999999, attempt: 1 };
        fs.appendFileSync(path.join(f.h.state, 'events.jsonl'), [
          { at, agent: 'orchestrator', cmd: 'spawn', task: 'T2', detail },
          { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T2', detail: { agent: detail.agent, pid: detail.pid, attempt: 1, code: 0 } },
        ].map((e) => `${JSON.stringify(e)}\n`).join(''));
      }
      const parent = stale ? resubmit(f, false) : f.sha;
      const before = events(f).filter((e) => e.cmd === 'spawn' && e.task === 'T2' && e.detail.role === 'reviewer').length;
      let result;
      if (entry.startsWith('automatic')) {
        if (entry === 'automatic accept') f.h.ok(['project', 'set', '--paused', 'review acceptance probe']);
        result = f.h.run(['wait', '--task', 'T2', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      } else if (entry.startsWith('review') || entry === 'unlinked review') {
        result = f.h.run(['spawn', '--task', 'T2', '--role', 'review',
          ...(entry === 'review dry-run' ? ['--dry-run'] : ['--wait']), '--json']);
      } else {
        result = f.h.run(['accept', 'T2', '--json',
          ...(entry === 'waived accept' ? ['--waive', 'review', '--reason', 'offline fixture'] : [])]);
      }
      const task = f.h.json(['task', 'show', 'T2']);
      const reviewers = events(f).filter((e) => e.cmd === 'spawn' && e.task === 'T2' && e.detail.role === 'reviewer');
      if (stale) {
        assert.notEqual(task.status, 'accepted', result.stdout + result.stderr);
        assert.equal(reviewers.length, before, 'no reviewer starts at the old head');
        if (!entry.startsWith('automatic')) {
          assert.equal(result.code, 1, result.stdout + result.stderr);
          assert.match(result.stderr, new RegExp(`containing T1 at ${parent}`));
        }
        assert.equal(task.sha, top.sha, 'refresh still requires a new child submission');
      } else if (entry === 'waived accept' || entry === 'automatic accept') {
        assert.equal(task.status, 'accepted', result.stdout + result.stderr);
      } else if (entry === 'automatic review') {
        assert.equal(reviewers.length, before + 1, result.stdout + result.stderr);
      } else {
        assert.equal(result.code, 0, result.stdout + result.stderr);
      }
    });
  }
}

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

for (const status of ['submitted', 'accepted', 'rework', 'in_progress']) {
  for (const stale of [false, true]) {
    test(`a child gate ${stale ? 'waits for the newer head' : 'checks its current head'} while the parent is ${status}`, (t) => {
      const f = setup(t);
      const top = upper(f);
      const parent = stale ? resubmit(f, false) : f.sha;
      if (status === 'accepted') f.accept('T1');
      if (['rework', 'in_progress'].includes(status)) f.h.ok(['rework', 'T1', '--reason', 'parent continues work']);
      if (status === 'in_progress') f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
      const result = f.h.run(['check', 'ci', 'T2', '--json']);
      if (stale) {
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(`waits for a submitted head containing T1 at ${parent}`));
        assert.equal(events(f).some((e) => e.task === 'T2' && e.cmd === 'check ci'), false);
      } else {
        assert.equal(result.code, 0, result.stdout + result.stderr);
        const checked = JSON.parse(result.stdout);
        assert.equal(checked.ok, true);
        assert.equal(checked.sha, top.sha);
      }
    });
  }
}

test('a child gate waits when a replacement parent PR has no submitted head', (t) => {
  const f = setup(t);
  upper(f);
  f.h.ok(['rework', 'T1', '--reason', 'replace parent PR']);
  f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
  f.write((d) => {
    d.prs[21] = { ...d.prs[11], number: 21 };
    d.prs[11].state = 'CLOSED';
  });
  f.h.ok(['release', 'T1', '--agent', 'worker-T1', '--pr', '21', '--reason', 'new PR needs submission']);
  assert.equal(f.h.json(['task', 'show', 'T1']).sha, null);
  const result = f.h.run(['check', 'ci', 'T2']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /waits for a submitted head containing T1 at \(none\)/);
});

for (const rewrite of [false, true]) {
  for (const published of [false, true]) {
    for (const checkout of [false, true]) {
      test(`untouched child adopts ${rewrite ? 'rewritten' : 'descendant'} parent with ${published ? 'published' : 'unpublished'} branch and ${checkout ? 'present' : 'absent'} checkout`, (t) => {
        const f = setup(t);
        const wt = f.h.json(['worktree', 'T2']);
        if (published) f.h.git(['push', 'origin', wt.branch], wt.path);
        if (!checkout) f.h.git(['worktree', 'remove', wt.path]);
        const parent = resubmit(f, rewrite);
        const read = inspector(f);
        const result = f.h.run(['spawn', '--task', 'T2', '--wait']);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(read().head, parent);
        assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, parent);
        assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], path.join(f.h.base, 'remote.git')), parent);
        if (rewrite) assert.throws(() => f.h.git(['merge-base', '--is-ancestor', f.sha, read().head]));
      });
    }
  }
}

for (const checkout of [false, true]) {
  test(`a gate-published untouched child dispatches after a later rewrite with ${checkout ? 'present' : 'absent'} checkout`, (t) => {
    const f = setup(t);
    const wt = f.h.json(['worktree', 'T2']);
    const published = resubmit(f, false);
    assert.equal(f.h.run(['check', 'ci', 'T2']).code, 1);
    assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], path.join(f.h.base, 'remote.git')), published);
    if (!checkout) f.h.git(['worktree', 'remove', wt.path]);
    const parent = resubmit(f, true);
    const read = inspector(f);
    f.h.ok(['spawn', '--task', 'T2', '--wait']);
    assert.equal(read().head, parent);
    assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, parent);
    assert.throws(() => f.h.git(['merge-base', '--is-ancestor', published, parent]));
  });
}

for (const checkout of [false, true]) {
  test(`a guarded rewrite lease preserves new remote child work with ${checkout ? 'present' : 'absent'} checkout`, (t) => {
    const f = setup(t);
    const wt = f.h.json(['worktree', 'T2']);
    f.h.git(['push', 'origin', wt.branch], wt.path);
    const peer = path.join(f.h.base, 'peer');
    f.h.git(['clone', '--branch', wt.branch, path.join(f.h.base, 'remote.git'), peer]);
    fs.writeFileSync(path.join(peer, 'remote-child.txt'), 'remote child\n');
    f.h.git(['add', 'remote-child.txt'], peer);
    f.h.git(['commit', '-qm', 'remote child work'], peer);
    f.h.git(['push', 'origin', wt.branch], peer);
    const remote = f.h.git(['rev-parse', 'HEAD'], peer);
    if (!checkout) f.h.git(['worktree', 'remove', wt.path]);
    resubmit(f, true);
    inspector(f);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.h.run(['spawn', '--task', 'T2', '--wait']);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /guarded lease expected/);
      assert.equal(f.h.git(['rev-parse', wt.branch]), f.sha);
      assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], path.join(f.h.base, 'remote.git')), remote);
      const task = f.h.json(['task', 'show', 'T2']);
      assert.equal(task.stack.parent_sha, f.sha);
      assert.equal(task.notes.filter((n) => n.text.includes('guarded lease expected')).length, 1);
    }
  });
}

for (const linked of [false, true]) {
  test(`rewritten parents preserve own child commits for ${linked ? 'linked' : 'unlinked'} restacking`, (t) => {
    const f = setup(t);
    const top = upper(f);
    if (!linked) f.h.ok(['stack', 'unstack', 'T2']);
    f.h.git(['rm', 'T1.txt'], f.lower.path);
    const parent = resubmit(f, true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.h.run(['check', 'ci', 'T2']);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /child has its own commits.*Restack/);
      assert.equal(f.h.git(['rev-parse', top.wt.branch]), top.sha);
      assert.equal(f.h.git(['rev-parse', `refs/heads/${top.wt.branch}`], path.join(f.h.base, 'remote.git')), top.sha);
      assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, f.sha);
    }
    assert.equal(f.h.json(['task', 'show', 'T2']).notes.filter((n) => n.text.includes('child has its own commits')).length, 1);
    f.write((d) => { d.restack = { branch: top.wt.branch, oldParent: f.sha, parent }; });
    if (!linked) f.h.ok(['stack', 'link', 'T2']);
    f.h.json(['worktree', 'T2']);
    assert.ok(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync'),
      events(f).filter((e) => e.cmd === 'stack sync deferred').map((e) => e.detail.reason).join('\n'));
    const restacked = f.h.git(['rev-parse', top.wt.branch]);
    f.h.git(['merge-base', '--is-ancestor', parent, restacked]);
    assert.throws(() => f.h.git(['merge-base', '--is-ancestor', f.sha, restacked]));
    assert.throws(() => f.h.git(['cat-file', '-e', `${restacked}:T1.txt`]));
    assert.equal(f.h.git(['show', `${restacked}:T2.txt`]), 'T2');
    assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, parent);
  });
}

for (const status of ['rework', 'in_progress']) {
  test(`linked base refresh proceeds after parent refresh is a no-op for ${status}`, (t) => {
    const f = setup(t);
    upper(f);
    resubmit(f, false);
    f.h.ok(['rework', 'T1', '--reason', 'parent continues work']);
    if (status === 'in_progress') f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
    fs.writeFileSync(path.join(f.h.repo, 'main.txt'), 'main\n');
    f.h.git(['add', 'main.txt']);
    f.h.git(['commit', '-qm', 'main advances']);
    f.h.git(['push', 'origin', 'main']);
    if (status === 'in_progress') {
      f.h.json(['worktree', 'T2']);
      assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync'), false);
      f.h.ok(['release', 'T1', '--agent', 'worker-T1', '--reason', 'parent worker finished']);
    }
    f.h.json(['worktree', 'T2']);
    assert.ok(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync'));
    assert.equal(f.h.json(['task', 'show', 'T2']).stack.synced_base, f.h.git(['rev-parse', 'origin/main']));
  });
}

for (const submitted of [false, true]) {
  for (const conflict of [false, true]) {
    test(`parent resubmission ${conflict ? 'conflicts without moving' : 'merges and pushes'} the ${submitted ? 'submitted' : 'prepared'} child before dispatch`, (t) => {
      const f = setup(t);
      const top = child(f, submitted, conflict);
      const parent = newerParent(f, conflict);
      const read = inspector(f);
      f.h.ok(['spawn', '--task', 'T2', '--wait']);
      const task = f.h.json(['task', 'show', 'T2']);
      const dispatched = read();
      const log = events(f);
      const sync = log.findLast((e) => e.task === 'T2' && e.cmd === 'stack sync');
      assert.ok(sync);
      assert.equal(sync.detail.parent_sha, parent);
      if (conflict) {
        assert.equal(dispatched.head, top.sha);
        assert.equal(task.stack.parent_sha, f.sha);
        assert.equal(f.h.git(['rev-parse', `refs/heads/${top.wt.branch}`], path.join(f.h.base, 'remote.git')), top.sha);
        assert.match(dispatched.prompt, new RegExp(parent));
        assert.match(dispatched.prompt, /resolve conflicts in: T1\.txt/);
        assert.equal(sync.detail.failure, 'conflict');
        assert.equal(f.h.git(['status', '--porcelain'], top.wt.path), '');
      } else {
        assert.equal(f.h.git(['rev-parse', `${dispatched.head}^1`]), top.sha);
        assert.equal(f.h.git(['rev-parse', `${dispatched.head}^2`]), parent);
        assert.equal(f.h.git(['show', '-s', '--format=%s', dispatched.head]), "Merge T1's resubmitted head into T2");
        assert.equal(task.stack.parent_sha, parent);
        assert.equal(f.h.git(['rev-parse', `refs/heads/${top.wt.branch}`], path.join(f.h.base, 'remote.git')), dispatched.head);
        assert.equal(sync.detail.ok, true);
      }
      assert.ok(log.indexOf(sync) < log.findIndex((e) => e.cmd === 'spawn' && e.task === 'T2'));
      assert.doesNotMatch(f.h.git(['worktree', 'list', '--porcelain']), /stack-parent-/);
    });
  }
}

for (const conflict of [false, true]) {
  test(`parent refresh ${conflict ? 'conflicts' : 'merges'} after recovering the child from its remote`, (t) => {
    const f = setup(t);
    const top = child(f, false, conflict);
    const parent = newerParent(f, conflict);
    f.h.git(['worktree', 'remove', top.wt.path]);
    f.h.git(['branch', '-D', top.wt.branch]);
    const read = inspector(f);
    f.h.ok(['spawn', '--task', 'T2', '--wait']);
    if (conflict) {
      assert.equal(read().head, top.sha);
      assert.match(read().prompt, new RegExp(parent));
      assert.match(read().prompt, /T1\.txt/);
    } else {
      assert.equal(f.h.git(['rev-parse', `${read().head}^2`]), parent);
    }
  });
}

test('a failed refresh push leaves the child branch and stack metadata for retry', (t) => {
  const f = setup(t);
  const top = child(f, false, false);
  newerParent(f, false);
  inspector(f);
  // A receive hook exercises the real Git push failure against the bare remote.
  const hook = path.join(f.h.base, 'remote.git', 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = f.h.run(['spawn', '--task', 'T2', '--wait']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /git push failed/);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, f.sha);
  assert.doesNotMatch(f.h.git(['worktree', 'list', '--porcelain']), /stack-parent-/);
  fs.unlinkSync(hook);
  f.h.ok(['spawn', '--task', 'T2', '--wait']);
});

for (const conflict of [false, true]) {
  test(`a gate ${conflict ? 'defers the conflicting' : 'syncs then waits for resubmission of the'} child instead of running its old head`, (t) => {
    const f = setup(t);
    const top = child(f, true, conflict);
    const parent = newerParent(f, conflict);
    const before = events(f).filter((e) => e.task === 'T2' && e.cmd.startsWith('check ')).length;
    const result = f.h.run(['check', 'clean', 'T2']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp(`waits for a submitted head containing T1 at ${parent}`));
    const task = f.h.json(['task', 'show', 'T2']);
    assert.equal(task.status, 'rework');
    assert.equal(task.sha, top.sha);
    assert.equal(events(f).filter((e) => e.task === 'T2' && e.cmd.startsWith('check ')).length, before);
    const head = f.h.git(['rev-parse', 'HEAD'], top.wt.path);
    if (conflict) assert.equal(head, top.sha);
    else assert.equal(f.h.git(['rev-parse', `${head}^2`]), parent);
    // The conflict note and revision remain stable across retries.
    f.h.run(['check', 'clean', 'T2']);
    assert.equal(f.h.json(['task', 'show', 'T2']).revision, task.revision);
    assert.equal(events(f).filter((e) => e.task === 'T2' && e.cmd === 'stack sync').length, 1);
  });
}
