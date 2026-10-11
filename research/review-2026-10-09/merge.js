'use strict';

const { ROOT, repo, task, submit, load, replay, event } = require('./harness');
const Merge = require(`${ROOT}/lib/gates/merge`);
const Stack = require(`${ROOT}/lib/stack`);
const { fakeExec, result } = require(`${ROOT}/test/gates/helpers`);
const probes = [];

function probe(id, expected, fn) {
  probes.push({ id, expected, async run() {
    const h = repo();
    try {
      h.init(['--repo', 'acme/probe']);
      submit(h, task(h));
      const st = h.snapshot();
      const t = { ...st.tasks.tasks[0], status: 'accepted', pr: 1 };
      const pr = { state: 'OPEN', headRefOid: t.sha, baseRefName: 'main',
        isCrossRepository: false, autoMergeRequest: null, mergeCommit: { oid: t.sha } };
      const gh = fakeExec((args) => {
        if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
        if (args[0] === 'pr' && args[1] === 'merge') { pr.state = 'MERGED'; return result(); }
        if (args[0] === 'api') return result(JSON.stringify({ pull_requests: [{ number: 1 }] }));
        return null;
      });
      const ctx = { root: h.repo, task: t, project: st.project, args: {}, exec: gh.exec };
      return await fn({ h, st, t, pr, gh, ctx });
    } finally { await h.cleanup(); }
  } });
}

probe('M01', 'A stack member uses the asynchronous API that GitHub accepts (T120).', async ({ t, pr, ctx }) => {
  t.stack = { linked: true, repo: 'acme/probe', base: 'main' };
  const gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
    if (args[0] === 'api') return result(JSON.stringify({ pull_requests: [{ number: 1 }] }));
    if (args[0] === 'pr' && args[1] === 'merge') {
      return result('', 1, 'GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API (mergePullRequest)');
    }
    return null;
  });
  const r = await Merge.run({ ...ctx, exec: gh.exec, isStacked: true, stackTasks: [t], stackReports: { T1: { ok: true } } });
  return { held: r.ok, observed: { ok: r.ok, summary: r.summary, commands: gh.calls.map((c) => c.slice(1, 3).join(' ')) } };
});
probe('M02', 'A push between the final PR read and merge cannot land an unaccepted head.', async ({ pr, ctx }) => {
  let landed = false;
  const gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
    if (args[0] === 'pr' && args[1] === 'merge') {
      pr.headRefOid = 'f'.repeat(40);
      if (args[args.indexOf('--match-head-commit') + 1] !== pr.headRefOid) return result('', 1, 'head changed');
      landed = true; pr.state = 'MERGED'; return result();
    }
    return null;
  });
  const r = await Merge.run({ ...ctx, exec: gh.exec });
  return { held: !r.ok && !landed, observed: { ok: r.ok, landed, summary: r.summary } };
});
probe('M03', 'An ordinary PR targeting release instead of main is refused (T108).', async ({ pr, ctx }) => {
  pr.baseRefName = 'release';
  const r = await Merge.run(ctx);
  return { held: !r.ok && pr.state === 'OPEN', observed: { ok: r.ok, actualBase: pr.baseRefName, summary: r.summary } };
});
probe('M04', 'A successful merge followed by branch-deletion failure still confirms the matching head.', async ({ pr, ctx }) => {
  const gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
    if (args[0] === 'pr' && args[1] === 'merge') { pr.state = 'MERGED'; return result('', 1, 'cannot delete branch'); }
    return null;
  });
  const r = await Merge.run({ ...ctx, exec: gh.exec });
  return { held: r.ok && r.summary.includes('cannot delete branch'), observed: r };
});
probe('M05', 'A merge command exiting zero with the PR still OPEN records failure, not success.', async ({ pr, ctx }) => {
  const gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
    if (args[0] === 'pr' && args[1] === 'merge') return result();
    return null;
  });
  const r = await Merge.run({ ...ctx, exec: gh.exec });
  return { held: !r.ok && r.summary.includes('OPEN'), observed: r };
});
probe('M06', 'A remotely merged different head fails confirmation without a second merge.', async ({ pr, ctx, gh }) => {
  Object.assign(pr, { state: 'MERGED', headRefOid: 'f'.repeat(40) });
  const r = await Merge.run(ctx);
  return { held: !r.ok && gh.calls.length === 1, observed: { ...r, calls: gh.calls.length } };
});
probe('M07', 'Unrelated task events do not invalidate a merge snapshot (T135 control).', ({ st }) => {
  const snapshot = Stack.capture(st, ['T1']);
  st.events.push(event('task note', 'T999', { text: 'unrelated progress' }));
  const unchanged = Stack.unchanged(snapshot, st);
  return { held: unchanged, observed: { unchanged } };
});
probe('M08', 'A member hook progress event does not invalidate a merge snapshot (T135).', ({ st }) => {
  const snapshot = Stack.capture(st, ['T1']);
  st.events.push(event('hook progress', 'T1', { tool: 'read', agent: 'worker-T1' }));
  const unchanged = Stack.unchanged(snapshot, st);
  return { held: unchanged, observed: { unchanged } };
});
probe('M09', 'Changed member evidence still invalidates the snapshot.', ({ st }) => {
  const snapshot = Stack.capture(st, ['T1']);
  st.events.push(event('check ci', 'T1', { ok: false }));
  const unchanged = Stack.unchanged(snapshot, st);
  return { held: !unchanged, observed: { unchanged } };
});

for (const stacked of [false, true]) {
  probe(stacked ? 'M11' : 'M10',
    `Already-merged ${stacked ? 'stack member' : 'ordinary PR'} with matching head can be confirmed without current gates (T125).`,
    async ({ h, st, t, pr }) => {
      st.tasks.tasks[0] = t;
      if (stacked) {
        st.tasks.tasks.push({ ...structuredClone(t), id: 'T2', pr: 2,
          stack: { linked: true, repo: 'acme/probe', base: 'task-lower', parent: t.id } });
      }
      pr.state = 'MERGED';
      const r = replay(st);
      const calls = [];
      const commands = require(`${ROOT}/lib/commands`);
      const check = load('lib/check.js', [], { './state': r.state, './commands': {
        ...commands, spawnSync(command, args, opts) {
          if (command !== 'gh') return commands.spawnSync(command, args, opts);
          calls.push(args.slice(0, 3));
          return result(JSON.stringify(pr));
        },
      } });
      let answer;
      try { answer = await check.runGate(r.ctx, 'merge'); }
      catch (e) { answer = { data: { ok: false, summary: e.message } }; }
      return { held: answer.data.ok, observed: { ok: answer.data.ok, summary: answer.data.summary, ghCalls: calls } };
    });
}

probe('M12', 'A stack with an untracked lower PR refuses before any merge.', async ({ ctx, t, pr }) => {
  t.stack = { linked: true, repo: 'acme/probe', base: 'main' };
  let merges = 0;
  const gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
    if (args[0] === 'api') return result(JSON.stringify({ pull_requests: [{ number: 99 }, { number: 1 }] }));
    if (args[0] === 'pr' && args[1] === 'merge') { merges++; return result(); }
    return null;
  });
  const r = await Merge.run({ ...ctx, exec: gh.exec, isStacked: true, stackTasks: [t], stackReports: { T1: { ok: true } } });
  return { held: !r.ok && merges === 0, observed: { ...r, merges } };
});

module.exports = probes;
