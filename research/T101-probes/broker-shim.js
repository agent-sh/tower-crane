'use strict';
// The state broker's authorization, its token, the git and gh shims, and git
// config that the orchestrator's own git reads.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const cp = require('node:child_process');
const { H, rec, save, out, lib } = require('./lib');
const broker = lib('broker');
const shim = lib('shim');

async function main() {
  const h = H.makeRepo();
  try {
    h.init(['--repo', 'acme/app']);
    for (const t of ['One', 'Two', 'Three']) h.ok(['task', 'add', '--title', t, '--acceptance', 'x']);
    const sha = h.git(['rev-parse', 'HEAD']);
    const job = { agent: 'worker-T2-1', role: 'worker', task: 'T2', state: h.state, cwd: h.repo };
    const auth = (argv, j = job) => {
      try { return `allowed: ${broker.authorize(j, argv).join(' ')}`; } catch (e) { return `refused: ${e.message}`; }
    };
    const cases = [
      ['B1', ['accept', 'T2'], true],
      ['B2', ['claim', 'T1'], true],
      ['B3', ['task', 'note', 'T2', 'x', '--agent=orchestrator'], true],
      ['B4', ['msg', '--to', 'orchestrator', '--task', 'T1', 'x'], true],
      ['B6', ['ask', '--question', 'q', '--option', 'a', '--blocks', 'T1'], true],
      ['B7', ['spend', 'T2', '--from-spawn', 'worker-T1-1'], true],
      ['B8', ['hook', 'stop', '--binding', path.join(h.state, 'homes', 'worker-T1-1', 'hook.json')], true],
      ['B9', ['submit', 'T1', '--sha', sha, '--', 'T2'], true],
    ];
    for (const [id, argv, refuse] of cases) {
      const o = auth(argv);
      rec(id, 'broker', `broker.authorize(worker-T2-1 on T2, ${JSON.stringify(argv)})`, refuse ? 'refused' : 'allowed', o,
        o.startsWith('refused') === refuse ? 'held' : 'CONFIRMED');
    }
    let o = auth(['submit', 'T2', '--sha', sha, '--state', '/elsewhere', '--agent', 'worker-T2-1']);
    rec('B10', 'broker', `broker.authorize(worker-T2-1, submit T2 --sha ${sha.slice(0, 7)} --state /elsewhere --agent worker-T2-1)`,
      "allowed, with the job's --agent and --state and the request's dropped", o,
      o.includes(`--state ${h.state}`) && !o.includes('/elsewhere') ? 'held' : 'CONFIRMED');
    o = auth(['evidence', 'T2', '--type', 'tests', '--ok'], { ...job, role: 'reviewer', agent: 'reviewer-T2-1' });
    rec('B11', 'broker', 'broker.authorize(reviewer-T2-1 on T2, evidence T2 --type tests --ok)', 'refused', o, o.startsWith('refused') ? 'held' : 'CONFIRMED');
    o = auth(['msg', '--to', 'worker-T1-1', 'note from T2']);
    rec('B12', 'broker/reactions', 'broker.authorize(worker-T2-1 on T2, msg --to worker-T1-1 "note from T2"), no --task',
      'refused: a worker reports to the orchestrator, not to another task\'s agent', o, o.startsWith('allowed') ? 'CONFIRMED' : 'held');

    // Delivery of B12: the message lands in worker-T1-1's inbox context.
    const brokered = h.run(['msg', '--to', 'worker-T1-1', 'note from T2'], { env: { ...h.env, TOWER_CRANE_AGENT: 'worker-T2-1', TOWER_CRANE_TASK: 'T2' } });
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const inbox = lib('harness-hooks').unread(events, 'worker-T1-1');
    rec('B13', 'reactions', 'TOWER_CRANE_AGENT=worker-T2-1 TOWER_CRANE_TASK=T2 tower-crane msg --to worker-T1-1 "note from T2"; then harness-hooks.unread(events, worker-T1-1)',
      'not delivered to another task\'s agent', `${out(brokered)}; inbox of worker-T1-1: ${JSON.stringify(inbox.map((e) => ({ from: e.agent, task: e.task, text: e.detail.text })))}`,
      inbox.length ? 'CONFIRMED' : 'held');

    // A live broker: the token gates it, and the token file is the only credential.
    const bdir = broker.dir(h.state, 'worker-T2-1');
    const live = await broker.start({ ...job, harness: 'claude', broker: path.join(bdir, 'broker.json'), broker_harnesses: ['claude', 'codex'] });
    const info = JSON.parse(fs.readFileSync(path.join(bdir, 'broker.json'), 'utf8'));
    const send = (payload) => new Promise((resolve) => {
      const s = net.connect(info.port, '127.0.0.1');
      let buf = '';
      s.on('data', (d) => (buf += d));
      s.on('end', () => resolve(buf));
      s.on('error', (e) => resolve(e.message));
      s.write(`${JSON.stringify(payload)}\n`);
    });
    o = await send({ token: 'f'.repeat(64), argv: ['task', 'note', 'T2', 'x'] });
    rec('B14', 'broker', 'TCP request to the live broker on 127.0.0.1 with a wrong token', 'refused', o, /without its token/.test(o) ? 'held' : 'CONFIRMED');
    const mode = (fs.statSync(path.join(bdir, 'broker.json')).mode & 0o777).toString(8);
    o = await send({ token: info.token, argv: ['task', 'note', 'T2', 'from a process that read broker.json'] });
    rec('B15', 'broker', `TCP request with the token read from brokers/worker-T2-1/broker.json (mode ${mode})`,
      'accepted: any unsandboxed same-uid process that reads the file acts as the worker', o, /"code":0/.test(o) ? 'by design' : 'held');
    live.close();

    // Shims.
    h.git(['remote', 'add', 'origin', 'https://example.invalid/acme/app.git']);
    const realGit = cp.execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const policy = { gitPush: 'branch', gh: ['pr view', 'pr create', 'pr edit'] };
    const gd = (args) => {
      const prev = process.cwd();
      const prevCfg = process.env.GIT_CONFIG_GLOBAL;
      process.chdir(h.repo);
      process.env.GIT_CONFIG_GLOBAL = h.env.GIT_CONFIG_GLOBAL;
      try { return shim.gitDenied(args, policy, realGit); } finally { process.chdir(prev); process.env.GIT_CONFIG_GLOBAL = prevCfg; }
    };
    const shims = [
      ['X1', ['push', 'origin', 'HEAD:main'], 'refused: a worker publishes its task branch, not the base'],
      ['X2', ['push', 'origin', 'HEAD:refs/tags/v9.9.9'], 'refused: a worker publishes no tags'],
      ['X3', ['-c', 'core.fsmonitor=true', 'status'], 'refused'],
      ['X4', ['push', '--force', 'origin', 'HEAD'], 'refused'],
      ['X5', ['push', 'origin', '+HEAD:feature'], 'refused'],
      ['X6', ['config', 'core.fsmonitor', 'cmd'], 'allowed by the shim (config is a git command); where it lands is the sandbox\'s call'],
    ];
    for (const [id, args, exp] of shims) {
      const why = gd(args);
      const held = exp.startsWith('refused') ? why !== null : why === null;
      rec(id, 'shim', `git shim gitDenied(${JSON.stringify(args)}), gitPush=branch, origin https://example.invalid/acme/app.git`, exp,
        why === null ? 'allowed' : `denied: ${why}`, held ? 'held' : 'CONFIRMED');
    }
    const g = shim.ghDenied(['pr', 'edit', '7', '--base', 'release'], policy);
    rec('X7', 'shim/merge', 'gh shim ghDenied(["pr","edit","7","--base","release"]) under the worker policy', 'allowed (pr edit is a worker write); M1 shows what follows',
      g === null ? 'allowed' : g, 'held');

    // X8: config in the shared git directory, which writeOutside: git lets a
    // worker write, is read by git the orchestrator runs outside any sandbox.
    h.git(['remote', 'remove', 'origin']);
    const marker = path.join(h.base, 'fsmonitor-marker');
    const hook = path.join(h.base, 'fsmonitor-hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\necho "$PPID $(pwd)" >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    h.git(['config', 'core.fsmonitor', hook]);
    const r = h.run(['worktree', 'T3', '--agent', 'orchestrator']);
    rec('X8', 'sandbox', 'git config core.fsmonitor <script> in the repository\'s shared .git/config (the worker sandbox may write it), then the orchestrator runs tower-crane worktree T3',
      'the orchestrator\'s git ignores repository-supplied commands', `${out(r)}; marker ${fs.existsSync(marker) ? `written: ${fs.readFileSync(marker, 'utf8').trim().split('\n').length} run(s) from ${fs.readFileSync(marker, 'utf8').trim().split('\n')[0]}` : 'absent'}`,
      fs.existsSync(marker) ? 'CONFIRMED' : 'held');
    h.git(['config', '--unset', 'core.fsmonitor']);
  } finally {
    save('broker-shim');
    fs.rmSync(h.base, { recursive: true, force: true });
  }
}
main();
