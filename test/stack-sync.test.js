'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, stacked } = require('./stack-fixture');
const { BIN } = require('./helpers');

for (const mode of ['generated', 'mixed', 'unknown', 'unmerged-parent', 'worktree', 'spawn']) {
  const automaticEntry = ['worktree', 'spawn'].includes(mode);
  test(automaticEntry ? `automatic ${mode} refresh defers generated conflicts before synchronization`
    : `a lower stack merge handles upper ${mode} conflicts before synchronization`, (t) => {
    const f = stacked(t);
    const h = f.h;
    fs.mkdirSync(path.join(h.repo, 'docs'));
    const document = (rows) => `Hand-written intro.\n<!-- commands:Run:start -->\n${rows}\n<!-- commands:Run:end -->\n`;
    fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({
      scripts: { 'docs:generate': 'node generate.js' },
      'tower-crane': { generated: { 'docs/cli.md': { script: 'docs:generate', blocks: ['commands:Run'] } } },
    }));
    fs.writeFileSync(path.join(h.repo, 'generate.js'), `const fs=require('node:fs');
const rows=fs.readFileSync('upper-source.txt','utf8').trim()+'/'+fs.readFileSync('main-source.txt','utf8').trim();
const file='docs/cli.md';
fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/(<!-- commands:Run:start -->)[\\s\\S]*?(<!-- commands:Run:end -->)/,'$1\\n'+rows+'\\n$2'));
`);
    for (const file of ['upper-source.txt', 'main-source.txt']) fs.writeFileSync(path.join(h.repo, file), 'base\n');
    fs.writeFileSync(path.join(h.repo, 'hand.txt'), 'base\n');
    fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), document('base/base'));
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'declare generated command block']);
    h.git(['push', 'origin', 'main']);
    const declared = h.git(['rev-parse', 'HEAD']);
    const resubmit = (id, pr, wt) => {
      const sha = h.git(['rev-parse', 'HEAD'], wt.path);
      h.git(['push', 'origin', wt.branch], wt.path);
      f.write((d) => { d.prs[pr].headRefOid = sha; });
      h.ok(['rework', id, '--reason', 'prepare generated conflict fixture']);
      h.ok(['claim', id, '--agent', `worker-${id}`]);
      h.ok(['submit', id, '--sha', sha, '--branch', wt.branch, '--pr', String(pr), '--agent', `worker-${id}`]);
      return sha;
    };
    h.git(['merge', '--no-edit', declared], f.lower.path);
    const lower = resubmit('T1', 11, f.lower);
    h.git(['merge', '--no-edit', lower], f.upper.wt.path);
    if (mode !== 'unmerged-parent') {
      fs.writeFileSync(path.join(f.upper.wt.path, 'upper-source.txt'), 'upper\n');
      fs.writeFileSync(path.join(f.upper.wt.path, 'docs', 'cli.md'), document('upper/base'));
    }
    if (mode === 'mixed') fs.writeFileSync(path.join(f.upper.wt.path, 'hand.txt'), 'upper\n');
    h.git(['add', '.'], f.upper.wt.path);
    h.git(['commit', '--allow-empty', '-qm', 'upper command block'], f.upper.wt.path);
    let upper = resubmit('T2', 12, f.upper.wt);
    let id = 'T2';
    let pr = 12;
    let wt = f.upper.wt;
    if (mode === 'unmerged-parent') {
      id = f.add('top', 'T2');
      pr = 13;
      wt = h.json(['worktree', id]);
      fs.writeFileSync(path.join(wt.path, 'upper-source.txt'), 'upper\n');
      fs.writeFileSync(path.join(wt.path, 'docs', 'cli.md'), document('upper/base'));
      h.git(['add', '.'], wt.path);
      upper = f.submit(id, pr, wt);
      h.ok(['stack', 'link', id]);
    }
    fs.writeFileSync(path.join(h.repo, 'main-source.txt'), 'main\n');
    fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), document('base/main'));
    if (mode === 'mixed') fs.writeFileSync(path.join(h.repo, 'hand.txt'), 'main\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'main command block']);
    h.git(['push', 'origin', 'main']);
    f.write((d) => {
      d.conflict = true;
      d.calls = [];
      d.generatedProbe = { lower: 11, upper: pr, unmergedParent: mode === 'unmerged-parent',
        mergeable: ['unknown', 'unmerged-parent'].includes(mode) ? 'UNKNOWN' : 'CONFLICTING' };
    });
    if (automaticEntry) {
      if (mode === 'worktree') h.ok(['worktree', id]);
      else {
        h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort',
          '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}'])]);
        const result = h.run(['spawn', '--task', id, '--wait']);
        assert.equal(result.code, 1, 'a submitted task cannot start another worker');
        assert.match(result.stderr, /submitted|claim|ready/i);
      }
      const current = h.json(['task', 'show', id]);
      assert.equal(current.status, 'submitted');
      assert.equal(current.sha, upper);
      assert.equal(h.git(['status', '--porcelain'], wt.path), '');
      assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync'), false);
      const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(events.some((e) => e.task === id && e.cmd === 'spawn' && e.detail.role === 'worker'), false);
      return;
    }
    f.accept('T1');
    h.ok(['merge', 'T1']);
    const task = h.json(['task', 'show', id]);
    const events = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync'), false);
    if (mode === 'unmerged-parent') {
      assert.equal(task.status, 'submitted');
      assert.equal(task.sha, upper);
      assert.equal(h.json(['task', 'show', 'T2']).status, 'submitted');
      assert.equal(h.git(['status', '--porcelain'], wt.path), '');
      return;
    }
    if (mode === 'mixed') {
      assert.equal(task.status, 'rework');
      assert.equal(h.git(['diff', '--name-only', '--diff-filter=U'], f.upper.wt.path), 'hand.txt');
      assert.match(fs.readFileSync(path.join(f.upper.wt.path, 'docs', 'cli.md'), 'utf8'), /upper\/main/);
      const receipt = events().findLast((e) => e.task === 'T2' && e.cmd === 'generated merge' && e.detail.phase === 'mixed');
      assert.ok(receipt);
      assert.equal(receipt.detail.revision, task.revision);
    } else {
      assert.equal(task.status, 'submitted');
      assert.equal(events().some((e) => e.task === 'T2' && e.cmd === 'rework' && /stack sync|conflicts with/.test(e.detail.reason)), false);
      if (mode === 'unknown') {
        assert.equal(task.sha, upper);
        assert.equal(h.git(['status', '--porcelain'], f.upper.wt.path), '');
        f.write((d) => { d.generatedProbe.mergeable = 'CONFLICTING'; });
        h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      }
      const repaired = h.json(['task', 'show', 'T2']);
      assert.equal(repaired.status, 'submitted');
      assert.notEqual(repaired.sha, upper);
      assert.equal(h.git(['ls-remote', 'origin', `refs/heads/${f.upper.wt.branch}`]).split(/\s/)[0], repaired.sha);
      assert.match(fs.readFileSync(path.join(f.upper.wt.path, 'docs', 'cli.md'), 'utf8'), /upper\/main/);
    }
  });
}

test('lower merge refreshes upper worktrees with gh stack sync and conflicts send upper work to rework', (t) => {
  const f = stacked(t);
  const { wt, sha } = f.upper;
  f.h.reviewer('T2', 'reviewer', sha);
  f.h.ok(['evidence', 'T2', '--type', 'review', '--fail', '--sha', sha, '--revision', f.h.revision('T2'), '--agent', 'reviewer',
    '--summary', 'Resolve the upper conflict', '--ref', 'stack-conflict-review']);
  const before = f.h.json(['task', 'show', 'T2']);
  f.accept('T1');
  f.write((d) => { d.conflict = true; });
  f.h.ok(['merge', 'T1']);
  const calls = f.read().calls;
  assert.ok(calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'checkout'));
  assert.ok(calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync' && c.cwd === wt.path));
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), sha);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'rework');
  assert.equal(task.revision, before.revision + 1);
  assert.deepEqual(task.evidence, before.evidence);
  const rework = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .findLast(e => e.cmd === 'rework' && e.task === 'T2');
  assert.equal(rework.detail.previous_revision, before.revision);
  assert.equal(rework.detail.revision, task.revision);
  assert.match(task.notes.at(-1).text, /Conflict detected rebasing/);
  assert.match(f.h.ok(['brief', 'get', 'T2']), /Rework notes/);
  assert.match(f.h.json(['spawn', '--task', 'T2', '--dry-run']).argv.join('\n'), /Resolve the upper conflict/);

  const prompt = path.join(f.h.base, 'worker-prompt');
  const script = `
require('node:child_process').execFileSync(process.execPath, ${JSON.stringify([BIN, 'claim', 'T2'])}, { env: process.env });
require('node:fs').writeFileSync(process.argv[1], process.argv[2]);
`;
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile',
    '--clear', 'provider', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, '-e', script, prompt, '{prompt}'])]);
  const spawned = f.h.json(['spawn', '--task', 'T2', '--wait']);
  const received = fs.readFileSync(prompt, 'utf8');
  assert.match(received, /Resolve the upper conflict/);
  assert.match(received, /stack-conflict-review/);
  const held = f.h.json(['task', 'show', 'T2']);
  assert.equal(held.claim.agent, spawned.agent);
  assert.equal(held.claim.from, 'rework');
  assert.ok(held.revision > task.revision, 'worker dispatch retried the unresolved stack refresh');
  assert.deepEqual(held.evidence, before.evidence);
  assert.equal(held.gates.ok, false);
  const retried = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.cmd === 'rework' && e.task === 'T2');
  assert.ok(retried.length > 1);
  assert.ok(retried.every(e => e.detail.previous_revision === before.revision));

  const clock = path.join(f.h.base, 'expired-claim-clock');
  fs.writeFileSync(clock, String(Date.parse(held.claim.until) + 1));
  assert.equal(f.h.run(['stack', 'sync', 'T2'], { hooks: { HOOK_CLOCK_FILE: clock } }).code, 1);
  const afterExpiry = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .findLast(e => e.cmd === 'rework' && e.task === 'T2');
  assert.equal(afterExpiry.detail.previous_revision, before.revision);
  f.h.ok(['claim', 'T2', '--agent', spawned.agent]);
  f.h.ok(['submit', 'T2', '--sha', sha, '--agent', spawned.agent]);
  f.h.reviewer('T2', 'reviewer-next', sha);
  f.h.ok(['evidence', 'T2', '--type', 'review', '--fail', '--sha', sha, '--revision', f.h.revision('T2'), '--agent', 'reviewer-next',
    '--summary', 'Resolve the next review']);
  assert.equal(f.h.run(['stack', 'sync', 'T2']).code, 1);
  f.h.json(['spawn', '--task', 'T2', '--wait']);
  const nextPrompt = fs.readFileSync(prompt, 'utf8');
  assert.match(nextPrompt, /Resolve the next review/);
  assert.doesNotMatch(nextPrompt, /Failed review by reviewer at/);
});

for (const stage of ['checkout', 'sync']) {
  test(`${stage} worktree listing failure preserves submissions and gate evidence, then retries on the next pass`, (t) => {
    const f = stacked(t);
    const reason = 'listing worktrees: reading worktree administration directory ".git/worktrees/broken": open gitdir: no such file or directory';
    f.h.ok(['evidence', 'T2', '--type', 'review', '--sha', f.upper.sha, '--revision', f.h.revision('T2'), '--ok', '--summary', 'review passed']);
    f.h.git(['commit', '--allow-empty', '-qm', 'main moved']);
    f.h.git(['push', 'origin', 'main']);
    const before = f.h.json(['task', 'show', 'T2']);
    const brief = f.h.ok(['brief', 'get', 'T2']);
    f.write((d) => { d[`${stage}Error`] = `Sync aborted; no changes were made\n  Your current checkout is unchanged.\n${reason}`; });
    const failed = f.h.run(['stack', 'sync', 'T2']);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /retry/);
    assert.deepEqual(f.h.json(['task', 'show', 'T2']), before);
    assert.equal(f.h.json(['task', 'show', 'T1']).status, 'submitted');
    assert.equal(f.h.ok(['brief', 'get', 'T2']), brief);
    const events = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const event = events.findLast((e) => e.cmd === 'stack sync' && e.task === 'T2');
    assert.equal(event.detail.ok, false);
    assert.equal(event.detail.reason, reason);
    assert.equal(event.detail.failure, 'tool');
    assert.equal(events.some((e) => e.cmd === 'rework'), false);
    f.write((d) => { delete d[`${stage}Error`]; });
    f.h.ok(['worktree', 'T2']);
    assert.equal(f.h.json(['task', 'show', 'T2']).status, 'submitted');
    assert.notEqual(f.h.json(['task', 'show', 'T2']).stack.synced_base, before.stack.synced_base);
    assert.equal(f.read().calls.filter((c) => c.args[1] === stage).length, 2);
  });
}

test('transport failure after moving a branch sends only that branch to rework', (t) => {
  const f = stacked(t);
  f.write((d) => { d.syncCommit = true; d.syncError = 'pushing stack: connection reset by peer'; });
  assert.equal(f.h.run(['stack', 'sync', 'T2']).code, 1);
  assert.equal(f.h.json(['task', 'show', 'T1']).status, 'submitted');
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
  assert.match(f.h.ok(['brief', 'get', 'T2']), /moved branch/);
});

test('transport failures mentioning conflicts are retried without rework', (t) => {
  const f = stacked(t);
  f.write((d) => { d.syncError = 'fetching branch conflicts: connection reset by peer'; });
  assert.equal(f.h.run(['stack', 'sync', 'T2']).code, 1);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'submitted');
  f.write((d) => { delete d.syncError; });
  f.h.ok(['stack', 'sync', 'T2']);
});

test('stack sync prunes orphan sandbox metadata before gh lists worktrees', (t) => {
  const f = stacked(t);
  const admin = path.join(f.h.repo, '.git', 'worktrees', 'orphan');
  fs.mkdirSync(admin);
  for (const file of ['commondir', 'config.worktree']) fs.writeFileSync(path.join(admin, file), '', { mode: 0o444 });
  f.write((d) => { d.inspectWorktrees = true; });
  f.h.ok(['stack', 'sync', 'T2']);
  assert.equal(fs.existsSync(admin), false);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'submitted');
});

test('an unavailable extension preserves the linked submission for a later retry', (t) => {
  const f = stacked(t);
  const before = f.h.json(['task', 'show', 'T2']);
  f.write((d) => { d.missingExtension = true; });
  assert.equal(f.h.run(['stack', 'sync', 'T2']).code, 1);
  assert.deepEqual(f.h.json(['task', 'show', 'T2']), before);
  f.write((d) => { delete d.missingExtension; });
  f.h.ok(['stack', 'sync', 'T2']);
});

test('sync rework preserves a brief deletion that races its append', (t) => {
  const f = stacked(t);
  f.write((d) => { d.conflict = true; });
  const brief = path.join(f.h.state, 'briefs', 'T2.md');
  const race = path.join(__dirname, 'fixtures', 'stack-brief-race.js');
  const r = f.h.run(['stack', 'sync', 'T2'], { env: {
    TEST_REMOVE_BRIEF: brief,
    NODE_OPTIONS: `${f.h.env.NODE_OPTIONS} --require=${JSON.stringify(race)}`,
  } });
  assert.equal(r.code, 1);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
  assert.equal(fs.existsSync(brief), false, 'a removed brief must not be recreated by appending rework notes');
});

for (const related of [false, true]) {
  test(`slow stack sync preserves a concurrent ${related ? 'stack member' : 'unrelated task'} claim after the lock lease expires`, async (t) => {
    const f = stacked(t);
    const id = related ? 'T2' : f.add('independent');
    if (related) f.h.ok(['rework', id, '--reason', 'prepare for another worker']);
    f.write((d) => { d.syncCommit = true; });
    const ready = path.join(f.h.base, 'sync-ready');
    const release = path.join(f.h.base, 'sync-release');
    const clock = path.join(f.h.base, 'clock');
    const now = Date.now();
    fs.writeFileSync(clock, String(now));
    const synced = f.h.runAsync(['stack', 'sync', 'T2'], {
      env: { TEST_STACK_SYNC_READY: ready, TEST_STACK_SYNC_RELEASE: release },
      hooks: { HOOK_CLOCK_FILE: clock },
    });
    try {
      const deadline = performance.now() + 15000;
      while (!fs.existsSync(ready)) {
        if (performance.now() > deadline) throw new Error('gh sync never started');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      fs.writeFileSync(clock, String(now + 120000));
      const claimed = f.h.json(['claim', id, '--agent', 'worker-concurrent'], { hooks: { HOOK_CLOCK_FILE: clock } });
      fs.writeFileSync(release, 'release');
      const result = await synced;
      const task = f.h.json(['task', 'show', id]);
      assert.equal(task.status, 'in_progress');
      assert.deepEqual(task.claim, claimed.claim, 'sync must preserve the new worker and its lease');
      if (related) {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /changed during stack sync/);
        assert.deepEqual(task.stack, claimed.stack);
        const events = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(events.some((e) => e.cmd === 'stack sync'), false, 'a stale sync result must not be recorded');
      } else {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
      }
    } finally {
      fs.writeFileSync(release, 'release');
      await synced;
    }
  });
}

for (const related of [false, true]) {
  test(`slow PR linking preserves a concurrent ${related ? 'member' : 'unrelated'} claim after lock expiry`, async (t) => {
    const f = setup(t);
    const wt = f.h.json(['worktree', 'T2']);
    f.submit('T2', 12, wt);
    const id = related ? 'T2' : f.add('independent');
    const ready = path.join(f.h.base, 'link-ready');
    const release = path.join(f.h.base, 'link-release');
    const clock = path.join(f.h.base, 'clock');
    const now = Date.now();
    fs.writeFileSync(clock, String(now));
    const linked = f.h.runAsync(['stack', 'link', 'T2'], {
      env: { TEST_STACK_LINK_READY: ready, TEST_STACK_LINK_RELEASE: release },
      hooks: { HOOK_CLOCK_FILE: clock },
    });
    try {
      const deadline = performance.now() + 15000;
      while (!fs.existsSync(ready)) {
        if (performance.now() > deadline) throw new Error('gh link never started');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      fs.writeFileSync(clock, String(now + 120000));
      const opts = { hooks: { HOOK_CLOCK_FILE: clock } };
      if (related) f.h.ok(['rework', id, '--reason', 'another worker takes over'], opts);
      const claimed = f.h.json(['claim', id, '--agent', 'worker-concurrent'], opts);
      fs.writeFileSync(release, 'release');
      const result = await linked;
      const task = f.h.json(['task', 'show', id]);
      assert.equal(task.status, 'in_progress');
      assert.deepEqual(task.claim, claimed.claim);
      if (related) {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /changed during stack link/);
        assert.deepEqual(task.stack, claimed.stack);
      } else {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(f.h.json(['task', 'show', 'T2']).stack.linked, true);
      }
    } finally {
      fs.writeFileSync(release, 'release');
      await linked;
    }
  });
}

test('main movement refreshes an idle stack and changed heads require fresh submissions', (t) => {
  const f = stacked(t);
  f.h.git(['commit', '--allow-empty', '-qm', 'main moved']);
  f.h.git(['push', 'origin', 'main']);
  f.write((d) => { d.syncCommit = true; });
  f.h.ok(['worktree', 'T2']);
  assert.ok(f.read().calls.some((c) => c.args[1] === 'sync'));
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /submit it and rerun gates/);
});

test('stack sync refuses live workers and dirty worktrees without invoking gh sync', (t) => {
  const f = stacked(t);
  const { wt } = f.upper;
  fs.writeFileSync(path.join(wt.path, 'untracked.txt'), 'work in progress\n');
  assert.match(f.h.run(['stack', 'sync', 'T2']).stderr, /clean worktree/);
  fs.unlinkSync(path.join(wt.path, 'untracked.txt'));
  f.h.ok(['rework', 'T2', '--reason', 'more work']);
  f.h.ok(['claim', 'T2', '--agent', 'worker-live']);
  assert.match(f.h.run(['stack', 'sync', 'T2']).stderr, /live worker/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'sync'), false);
});
