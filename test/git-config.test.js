'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

// A sandboxed worker may write the repository's git directory, so every
// command its config or hooks name is planted here and none may run in git
// the CLI starts.
function plant(h) {
  const marker = path.join(h.base, 'planted');
  const script = path.join(h.base, 'planted.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\nprocess.stdin.pipe(process.stdout);\n`);
  const cmd = (name) => `${shellQuote(process.execPath)} ${shellQuote(script)} ${name}`;
  const hooks = path.join(h.base, 'hooks');
  fs.mkdirSync(hooks);
  for (const hook of ['post-checkout', 'reference-transaction', 'post-index-change']) {
    fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\n${cmd(`hook-${hook}`)}\n`, { mode: 0o755 });
  }
  const gitDir = path.join(h.repo, '.git');
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* filter=tc diff=tc merge=tc\nvalue.js filter=tp\n');
  const settings = {
    'core.fsmonitor': cmd('fsmonitor'),
    'core.hooksPath': hooks,
    'diff.external': cmd('diff-external'),
    'diff.tc.textconv': cmd('textconv'),
    'diff.tc.command': cmd('diff-command'),
    'filter.tc.clean': cmd('filter-clean'),
    'filter.tc.smudge': cmd('filter-smudge'),
    'filter.tc.required': 'true',
    'filter.tp.process': cmd('filter-process'),
    'merge.tc.driver': cmd('merge-driver'),
    'core.sshCommand': cmd('ssh-command'),
    'credential.helper': cmd('credential-helper'),
  };
  for (const [key, value] of Object.entries(settings)) h.git(['config', key, value]);
  return { cmd, ran: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []) };
}

// An HTTP origin that asks for credentials, in its own process so the
// synchronous CLI runs below do not block it.
function unauthorizedServer(t) {
  const child = cp.spawn(process.execPath, ['-e', `
    const s = require('node:http').createServer((q, r) => { r.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); r.end(); });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  return new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
}

test('git the CLI and gates run takes no command from repository config or hooks', async (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--clean-cmd', h.env.TOWER_CRANE_CLEAN_CMD]);
  for (const title of ['Change', 'Other', 'Ssh', 'Https']) h.ok(['task', 'add', '--title', title, '--acceptance', 'works']);
  h.ok(['brief', 'set', 'T2', '-'], { input: '- change it\n' });
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.git(['switch', '-q', 'main']);
  const { cmd, ran } = plant(h);
  const env = { GIT_TERMINAL_PROMPT: '0' };

  h.ok(['worktree', 'T2', '--agent', 'orchestrator'], { env });
  h.ok(['spawn', '--task', 'T2', '--dry-run'], { env });
  for (const type of ['tests', 'clean']) {
    const receipt = h.json(['check', type, 'T1', '--agent', 'checker'], { env: { ...env, TOWER_CRANE_CLEAN_CMD: '' } });
    assert.ok(receipt.commands.some((c) => c.command === 'git' && c.args.includes('worktree')), `${type} checked out the submitted commit`);
  }
  h.ok(['spawn', '--role', 'review', '--task', 'T1', '--dry-run'], { env });
  h.ok(['claim', 'T2', '--agent', 'worker-2']);
  h.ok(['submit', 'T2', '--sha', sha, '--agent', 'worker-2'], { env });
  assert.deepEqual(ran(), []);

  h.git(['remote', 'add', 'origin', 'ssh://git@127.0.0.1:9/acme/demo.git']);
  assert.match(h.run(['worktree', 'T3', '--agent', 'orchestrator'], { env }).stderr, /git fetch origin main failed/);
  assert.deepEqual(ran(), []);

  const port = await unauthorizedServer(t);
  h.git(['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/acme/demo.git`]);
  h.git(['config', `credential.http://127.0.0.1:${port}.helper`, cmd('credential-url-helper')]);
  assert.match(h.run(['worktree', 'T4', '--agent', 'orchestrator'], { env }).stderr, /git fetch origin main failed/);
  assert.deepEqual(ran(), []);
});

// gh runs git itself (gh stack sync rebases and pushes), so the stub gh runs
// git status in its working directory the way gh would.
test('git started through gh takes no command from repository config or hooks', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--pr', '7', '--agent', 'worker']);
  h.git(['switch', '-q', 'main']);
  const { ran } = plant(h);
  const bin = path.join(h.base, 'gh-bin');
  fs.mkdirSync(bin);
  const stub = path.join(bin, 'gh.js');
  fs.writeFileSync(stub, `require('node:child_process').execFileSync('git', ['status', '--porcelain'], { stdio: 'ignore' });
console.log(JSON.stringify({ state: 'OPEN', headRefName: 'feature' }));\n`);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(stub)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh.cmd'), `@"${process.execPath}" "${stub}" %*\r\n`);
  const env = { GIT_TERMINAL_PROMPT: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}` };

  h.ok(['submit', 'T1', '--sha', sha, '--pr', '7', '--agent', 'worker'], { env });
  assert.deepEqual(ran(), []);
});

test('repository git proxies cannot run before command-scope overrides', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Proxy', '--acceptance', 'works']);
  const marker = path.join(h.base, 'proxy-ran');
  const script = path.join(h.base, 'proxy.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const proxy = path.join(h.base, 'proxy');
  fs.writeFileSync(proxy, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  h.git(['config', 'core.gitProxy', proxy]);
  h.git(['remote', 'add', 'origin', 'git://127.0.0.1:9/acme/demo.git']);

  const result = h.run(['worktree', 'T1', '--agent', 'orchestrator']);
  assert.match(result.stderr, /git fetch origin main failed/);
  assert.equal(fs.existsSync(marker), false, 'repository proxy never runs');

  h.run(['worktree', 'T1', '--agent', 'orchestrator'], { env: { GIT_PROXY_COMMAND: proxy } });
  assert.equal(fs.existsSync(marker), true, 'caller-provided proxy still runs');
});

test('an incomplete config scan refuses the CLI command before a hidden driver runs', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Oversized config', '--acceptance', 'works']);
  const marker = path.join(h.base, 'driver-ran');
  const script = path.join(h.base, 'driver.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdin.pipe(process.stdout);\n`);
  fs.appendFileSync(path.join(h.repo, '.git', 'config'), `\n[padding]\nvalue = ${'x'.repeat(2 * 1024 * 1024)}\n`);
  h.git(['config', 'filter.hidden.smudge', `${shellQuote(process.execPath)} ${shellQuote(script)}`]);
  fs.writeFileSync(path.join(h.repo, '.git', 'info', 'attributes'), '* filter=hidden\n');

  const result = h.run(['worktree', 'T1', '--agent', 'orchestrator']);
  assert.notEqual(result.code, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(h.base, 'repo-worktrees', 'T1-oversized-config')), false);
});

// The scan runs in the source checkout, where these conditions do not match;
// git reads them in the worktrees it creates for the task and the gates.
test('conditional includes cannot add a driver the config scan misses', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--clean-cmd', h.env.TOWER_CRANE_CLEAN_CMD]);
  for (const title of ['Change', 'Other', 'Tilde']) h.ok(['task', 'add', '--title', title, '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.git(['switch', '-q', 'main']);
  const marker = path.join(h.base, 'planted');
  const script = path.join(h.base, 'planted.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\nprocess.stdin.pipe(process.stdout);\n`);
  const gitDir = path.join(h.repo, '.git');
  for (const [name, condition] of [['gitdir', 'gitdir:**/worktrees/**'], ['branch', 'onbranch:tower-crane/**']]) {
    h.git(['config', '--file', path.join(gitDir, `${name}.inc`), `filter.${name}.smudge`, `${shellQuote(process.execPath)} ${shellQuote(script)} ${name}`]);
    h.git(['config', `includeIf.${condition}.path`, `${name}.inc`]);
  }
  fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '*.js filter=gitdir\n*.json filter=branch\nvalue.js filter=branch\n');
  const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []);

  h.ok(['worktree', 'T2', '--agent', 'orchestrator']);
  for (const type of ['tests', 'clean']) {
    h.json(['check', type, 'T1', '--agent', 'checker'], { env: { TOWER_CRANE_CLEAN_CMD: '' } });
  }
  assert.deepEqual(ran(), []);

  h.git(['config', 'includeIf.onbranch:tower-crane/**.path', '~nobody-here/branch.inc']);
  assert.match(h.run(['worktree', 'T3', '--agent', 'orchestrator']).stderr, /cannot read git configuration safely/);
  assert.deepEqual(ran(), []);
});
