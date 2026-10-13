'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { makeRepo, PTY_AVAILABLE } = require('./helpers');
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
  // git splits this one itself, without a shell, so it names a program. Its
  // splitting reads a backslash as an escape, so the path uses forward slashes.
  const keyCommand = path.join(hooks, 'key-command');
  fs.writeFileSync(keyCommand, `#!/bin/sh\n${cmd('gpg-key-command')}\n`, { mode: 0o755 });
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
    'credential.helper': `!${cmd('credential-helper')}`,
    // Runs for each signed commit when no user.signingKey is set.
    'commit.gpgSign': 'true',
    'gpg.format': 'ssh',
    'gpg.ssh.defaultKeyCommand': keyCommand.replace(/\\/g, '/'),
    // With loose objects past gc.auto, a fetch or commit runs gc --auto in
    // the foreground, whose prune runs this hook.
    'gc.auto': '1',
    'gc.autoDetach': 'false',
    'gc.recentObjectsHook': cmd('recent-objects-hook'),
  };
  for (const [key, value] of Object.entries(settings)) h.git(['config', key, value]);
  ageLooseObjects(gitDir);
  return { cmd, ran: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []) };
}

// gc --auto counts the loose objects in objects/17.
function ageLooseObjects(gitDir) {
  const aged = Date.now() / 1000 - 30 * 86400;
  for (let i = 0, found = 0; found < 3; i++) {
    const body = Buffer.from(`aged ${i}\n`);
    const object = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
    const id = crypto.createHash('sha1').update(object).digest('hex');
    if (!id.startsWith('17')) continue;
    const file = path.join(gitDir, 'objects', '17', id.slice(2));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.deflateSync(object));
    fs.utimesSync(file, aged, aged);
    found++;
  }
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
  for (const title of ['Change', 'Other', 'Ssh', 'Https', 'Local', 'Helper', 'Vcs']) h.ok(['task', 'add', '--title', title, '--acceptance', 'works']);
  h.ok(['brief', 'set', 'T2', '-'], { input: '- change it\n' });
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.git(['switch', '-q', 'main']);
  const origin = path.join(h.base, 'origin.git');
  h.git(['clone', '-q', '--bare', h.repo, origin]);
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
  h.git(['config', `credential.http://127.0.0.1:${port}.helper`, `!${cmd('credential-url-helper')}`]);
  assert.match(h.run(['worktree', 'T4', '--agent', 'orchestrator'], { env }).stderr, /git fetch origin main failed/);
  assert.deepEqual(ran(), []);

  // A fetch that succeeds runs auto-maintenance.
  h.git(['remote', 'set-url', 'origin', origin]);
  h.ok(['worktree', 'T5', '--agent', 'orchestrator'], { env });
  assert.deepEqual(ran(), []);

  // A remote helper with no git-remote-<name> program runs the alias.
  h.git(['config', 'alias.remote-tcx', `!${cmd('remote-helper-alias')} </dev/null; false`]);
  h.git(['remote', 'set-url', 'origin', 'tcx::anything']);
  const helper = h.run(['worktree', 'T6', '--agent', 'orchestrator'], { env });
  assert.deepEqual(ran(), []);
  assert.match(helper.stderr, /git fetch origin main failed/);
  h.git(['config', 'alias.remote-tcy', `!${cmd('remote-vcs-alias')} </dev/null; false`]);
  h.git(['config', 'protocol.tcy.allow', 'always']);
  h.git(['remote', 'set-url', 'origin', 'https://127.0.0.1:9/acme/demo.git']);
  h.git(['config', 'remote.origin.vcs', 'tcy']);
  const vcs = h.run(['worktree', 'T7', '--agent', 'orchestrator'], { env });
  assert.deepEqual(ran(), []);
  assert.match(vcs.stderr, /git fetch origin main failed/);
});

// A sandboxed worker can create the common directory's commondir file. Git in
// the main checkout then reads the repository it names: its config, hooks,
// refs and objects, and Tower Crane finds its state beside it. Here that
// repository's config sets core.fsmonitor and its state names a tests command.
test('a planted commondir in the common directory stops git the CLI and gates run', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--clean-cmd', h.env.TOWER_CRANE_CLEAN_CMD]);
  for (const title of ['Change', 'Other']) h.ok(['task', 'add', '--title', title, '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.git(['switch', '-q', 'main']);
  const marker = path.join(h.base, 'planted');
  const script = path.join(h.base, 'planted.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\n`);
  const cmd = (name) => `${shellQuote(process.execPath)} ${shellQuote(script)} ${name}`;
  const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []);
  const other = path.join(h.base, 'other');
  fs.cpSync(h.repo, other, { recursive: true });
  h.git(['config', 'core.fsmonitor', cmd('fsmonitor')], other);
  h.ok(['project', 'set', '--tests-cmd', cmd('tests-cmd'), '--state', path.join(other, '.tower-crane')]);
  h.git(['worktree', 'add', '-q', '--detach', path.join(h.base, 'linked'), 'main']);
  const planted = path.join(h.repo, '.git', 'commondir');
  fs.writeFileSync(planted, `${path.join(other, '.git')}\n`);

  cp.spawnSync('git', ['status'], { cwd: h.repo, env: h.env, stdio: 'ignore' });
  assert.deepEqual(ran(), ['fsmonitor'], 'plain git in the main checkout takes the planted setting');
  fs.rmSync(marker);

  const env = { GIT_TERMINAL_PROMPT: '0', TOWER_CRANE_CLEAN_CMD: '' };
  for (const args of [['status'], ['worktree', 'T2', '--agent', 'orchestrator'],
    ['check', 'tests', 'T1', '--agent', 'checker'], ['check', 'clean', 'T1', '--agent', 'checker']]) {
    const r = h.run(args, { env });
    assert.notEqual(r.code, 0, `${args.join(' ')} refused`);
    assert.match(r.stderr, /commondir points git at .*other.*then remove or restore /s, args.join(' '));
  }
  // A linked worktree's git is not redirected, but its common directory is the same.
  const commands = require('../lib/commands');
  for (const dir of [h.repo, path.join(h.repo, 'test'), path.join(h.base, 'linked')]) {
    assert.throws(() => commands.execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, env: h.env }), /commondir/, dir);
    assert.throws(() => commands.spawnSync('git', ['status'], { cwd: dir, env: h.env }), /commondir/, dir);
  }
  assert.deepEqual(ran(), []);

  fs.rmSync(planted);
  h.ok(['worktree', 'T2', '--agent', 'orchestrator'], { env });
  assert.deepEqual(ran(), []);
});

// The fixture for the races below: a repository whose copy, `other`, has a
// state of its own with its own task and a tests command that writes a marker.
function redirectFixture(t) {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--clean-cmd', h.env.TOWER_CRANE_CLEAN_CMD]);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.git(['switch', '-q', 'main']);
  const marker = path.join(h.base, 'planted');
  const script = path.join(h.base, 'planted.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\n`);
  const other = path.join(h.base, 'other');
  fs.cpSync(h.repo, other, { recursive: true });
  const state = ['--state', path.join(other, '.tower-crane')];
  h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(script)} tests-cmd`, ...state]);
  h.ok(['task', 'add', '--title', 'Other state', '--acceptance', 'works', ...state]);
  return { h, other, planted: path.join(h.repo, '.git', 'commondir'),
    ran: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []) };
}

// The guard reads the files before git does; a commondir that appears in
// between must not decide where the state is. A git on PATH that plants the
// file only while it looks the repository up makes that window certain.
test('a commondir that appears after the guard does not redirect the state lookup', { skip: process.platform === 'win32' && 'a sh wrapper stands in for git' }, (t) => {
  const { h, other, planted, ran } = redirectFixture(t);
  const bin = path.join(h.base, 'git-bin');
  fs.mkdirSync(bin);
  const realGit = cp.execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: h.env }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case " $* " in
  *" --git-common-dir "*) printf '%s\\n' ${shellQuote(path.join(other, '.git'))} > ${shellQuote(planted)}
    ${shellQuote(realGit)} "$@"; s=$?; rm -f ${shellQuote(planted)}; exit $s ;;
esac
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  const env = { GIT_TERMINAL_PROMPT: '0', TOWER_CRANE_CLEAN_CMD: '', PATH: `${bin}${path.delimiter}${h.env.PATH}` };
  const list = h.run(['task', 'list', '--json'], { env });
  assert.doesNotMatch(list.stdout, /Other state/);
  assert.notEqual(list.code, 0);
  assert.match(list.stderr, /changed during the lookup/);
  const check = h.run(['check', 'tests', 'T1', '--agent', 'checker'], { env });
  assert.notEqual(check.code, 0);
  assert.deepEqual(ran(), []);
});

// The same window, opened by a worker that writes and removes the file every
// millisecond, as a write loop against the supervisor's removal does.
test('a commondir toggled in a loop never redirects the state lookup', (t) => {
  const { h, other, planted } = redirectFixture(t);
  const toggler = cp.spawn(process.execPath, ['-e', `
const fs = require('node:fs');
const [file, named] = process.argv.slice(1);
const spin = (ms) => { const end = process.hrtime.bigint() + BigInt(ms * 1e6); while (process.hrtime.bigint() < end); };
const stop = Date.now() + 300000;
while (Date.now() < stop) {
  try { fs.writeFileSync(file, named + '\\n'); } catch {}
  spin(1);
  try { fs.unlinkSync(file); } catch {}
  spin(1);
}`, planted, path.join(other, '.git')], { stdio: 'ignore' });
  t.after(() => { toggler.kill(); fs.rmSync(planted, { force: true }); });
  const seen = { other: 0, refused: 0, own: 0 };
  // Before the confirm, about one run in ten read the other state; 150 runs
  // miss that with odds near 1e-6.
  for (let i = 0; i < 150 && !seen.other; i++) {
    const r = h.run(['task', 'list', '--json']);
    if (/Other state/.test(r.stdout)) seen.other++;
    else if (r.code !== 0) seen.refused++;
    else seen.own++;
  }
  assert.equal(seen.other, 0, JSON.stringify(seen));
});

// Only a worktree admin directory names its common directory, and only one
// that holds it. A separate git directory, as a submodule's is, has none.
test('a commondir in a separate git directory, a bare repository or a rewritten admin directory is refused', (t) => {
  const h = makeRepo(t);
  h.init();
  const commands = require('../lib/commands');
  const other = path.join(h.base, 'other');
  fs.cpSync(h.repo, other, { recursive: true });
  const status = (cwd) => commands.spawnSync('git', ['status', '--porcelain'], { cwd, env: h.env, encoding: 'utf8' });

  const separate = path.join(h.base, 'separate');
  const sepDir = path.join(h.base, 'separate.git');
  cp.execFileSync('git', ['init', '-q', '--separate-git-dir', sepDir, separate], { env: h.env });
  assert.equal(status(separate).status, 0);
  fs.writeFileSync(path.join(sepDir, 'commondir'), `${path.join(other, '.git')}\n`);
  assert.throws(() => status(separate), /separate\.git.commondir points git at/);

  // Planting `gitdir` too, with an entry in the other repository that leads
  // back, does not make a git directory with objects of its own an admin one.
  fs.writeFileSync(path.join(sepDir, 'gitdir'), `${path.join(separate, '.git')}\n`);
  fs.mkdirSync(path.join(other, '.git', 'worktrees'), { recursive: true });
  fs.symlinkSync(sepDir, path.join(other, '.git', 'worktrees', 'separate.git'));
  assert.throws(() => status(separate), /separate\.git.commondir points git at/);
  const bare = path.join(h.base, 'bare.git');
  cp.execFileSync('git', ['clone', '-q', '--bare', h.repo, bare], { env: h.env });
  assert.equal(commands.spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: bare, env: h.env }).status, 0);
  fs.writeFileSync(path.join(bare, 'gitdir'), `${path.join(h.base, 'nowhere', '.git')}\n`);
  fs.writeFileSync(path.join(bare, 'commondir'), `${path.join(other, '.git')}\n`);
  fs.symlinkSync(bare, path.join(other, '.git', 'worktrees', 'bare.git'));
  assert.throws(() => commands.spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: bare, env: h.env }), /bare\.git.commondir points git at/);

  const linked = path.join(h.base, 'linked');
  h.git(['worktree', 'add', '-q', '--detach', linked, 'main']);
  assert.equal(status(linked).status, 0);
  const admin = path.join(h.repo, '.git', 'worktrees', 'linked');
  fs.writeFileSync(path.join(admin, 'commondir'), `${path.join(other, '.git')}\n`);
  assert.throws(() => status(linked), /does not hold this worktree's admin directory/);
  // An admin directory kept in .git-admin/ is held through that entry.
  const moved = path.join(h.base, '.git-admin', 'linked');
  fs.mkdirSync(path.dirname(moved));
  fs.renameSync(admin, moved);
  fs.writeFileSync(path.join(moved, 'commondir'), `${path.join(h.repo, '.git')}\n`);
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${moved}\n`);
  assert.throws(() => status(linked), /does not hold this worktree's admin directory/);
  fs.symlinkSync(moved, admin);
  assert.equal(status(linked).status, 0);
});

// gh runs git itself (gh stack sync rebases and pushes), so the stub gh runs
// git status and commits in its working directory the way gh would. The
// commit fails once the planted signing command is emptied.
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
  fs.writeFileSync(stub, `const cp = require('node:child_process');
cp.execFileSync('git', ['status', '--porcelain'], { stdio: 'ignore' });
cp.spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'sync'], { stdio: 'ignore' });
console.log(JSON.stringify({ state: 'OPEN', headRefName: 'feature' }));\n`);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(stub)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh.cmd'), `@"${process.execPath}" "${stub}" %*\r\n`);
  const env = { GIT_TERMINAL_PROMPT: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}` };

  h.ok(['submit', 'T1', '--sha', sha, '--pr', '7', '--agent', 'worker'], { env });
  assert.deepEqual(ran(), []);
});

// The pinned cleanup tool is the owner's, but the git it runs in the gate
// worktree reads the same repository config. deslop runs these two.
test('git run by the pinned clean command takes no command from repository config', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  const tool = path.join(h.base, 'clean-tool.js');
  fs.writeFileSync(tool, `const cp = require('node:child_process');
const base = process.argv[3].slice('--base='.length);
cp.spawnSync('git', ['diff', '-M', base + '..HEAD'], { stdio: 'ignore' });
cp.spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { stdio: 'ignore' });
console.log(JSON.stringify({ items: [] }));\n`);
  h.ok(['project', 'set', '--clean-cmd', `${shellQuote(process.execPath)} ${shellQuote(tool)}`]);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.git(['switch', '-q', 'main']);
  const { ran } = plant(h);

  const receipt = h.json(['check', 'clean', 'T1', '--agent', 'checker'], { env: { GIT_TERMINAL_PROMPT: '0', TOWER_CRANE_CLEAN_CMD: '' } });
  assert.equal(receipt.ok, true, receipt.summary);
  assert.deepEqual(ran(), []);
});

// Git reads GIT_SSH and SSH_ASKPASS only when core.sshCommand and
// core.askPass are unset, so the command-scope defaults must carry them.
test('the caller\'s GIT_SSH and SSH_ASKPASS still run under the command-scope defaults', async (t) => {
  const h = makeRepo(t);
  h.init();
  const marker = path.join(h.base, 'caller-ran');
  const script = path.join(h.base, 'caller.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\nconsole.log('x');\n`);
  const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []);
  const bin = path.join(h.base, 'caller bin');
  fs.mkdirSync(bin);
  const program = (name) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} ${name}\n`, { mode: 0o755 });
    return file;
  };
  h.git(['remote', 'add', 'origin', 'ssh://git@127.0.0.1:9/acme/demo.git']);
  const { spawnSync } = require('../lib/commands');
  // h.env carries no GIT_ variable of the caller's.
  const base = h.env;

  spawnSync('git', ['-C', h.repo, 'fetch', 'origin', 'main'], { env: { ...base, GIT_SSH: program('my-ssh') }, stdio: 'ignore' });
  assert.ok(ran().includes('my-ssh'), 'GIT_SSH runs');

  const port = await unauthorizedServer(t);
  h.git(['remote', 'set-url', 'origin', `http://127.0.0.1:${port}/acme/demo.git`]);
  spawnSync('git', ['-C', h.repo, 'fetch', 'origin', 'main'], { env: { ...base, SSH_ASKPASS: program('my-askpass'), GIT_TERMINAL_PROMPT: '0' }, stdio: 'ignore' });
  assert.ok(ran().includes('my-askpass'), 'SSH_ASKPASS runs');
});

// A scan is a git process of its own, so one per call doubled the cost of
// every git call; the reuse must still see a worker's edit to any file the
// scan read, including one only an include names.
test('a config scan is reused until a file it read changes', (t) => {
  const h = makeRepo(t);
  h.init();
  fs.writeFileSync(path.join(h.repo, 'value.txt'), 'one\n');
  h.git(['add', 'value.txt']);
  h.git(['commit', '-qm', 'value']);
  const wt = path.join(h.base, 'wt');
  h.git(['worktree', 'add', '-q', '--detach', wt]);
  const trace = path.join(h.base, 'trace');
  const env = { ...h.env, GIT_TRACE: trace };
  const count = (text) => (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter((l) => l.includes(text)).length : 0);
  const scans = () => count('config --list --show-scope');
  const parses = () => count('config --file - --no-includes');
  const { spawnSync } = require('../lib/commands');
  const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' });

  fs.writeFileSync(path.join(h.repo, '.git', 'worktrees', 'wt', 'config.worktree'), '');
  for (const dir of [h.repo, h.repo, wt, wt]) git(dir, ['status', '--porcelain']);
  assert.equal(scans(), 2, 'one scan per checkout');
  assert.equal(parses(), 0, 'a config without includes is taken from the listing');

  const marker = path.join(h.base, 'planted');
  const script = path.join(h.base, 'planted.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'textconv\\n');\nprocess.stdout.write(require('node:fs').readFileSync(process.argv[2]));\n`);
  fs.writeFileSync(path.join(h.repo, '.git', 'info', 'attributes'), '* diff=tc\n');
  const extra = path.join(h.repo, '.git', 'extra');
  fs.writeFileSync(extra, '');
  h.git(['config', 'include.path', 'extra']);
  git(h.repo, ['status', '--porcelain']);
  assert.equal(scans(), 3, 'the config changed');
  assert.equal(parses(), 1, 'a config with an include is parsed');
  h.git(['config', '--file', extra, 'diff.tc.textconv', `${shellQuote(process.execPath)} ${shellQuote(script)}`]);
  for (const dir of [h.repo, wt]) {
    fs.writeFileSync(path.join(dir, 'value.txt'), 'two\n');
    git(dir, ['diff']);
  }
  assert.equal(scans(), 5, 'the included file changed');
  assert.equal(fs.existsSync(marker), false, 'no planted textconv ran');
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

// One row per setting the closed list names. Git runs a credential helper
// through the shell only with a leading !, and runs gpg.program and
// gpg.ssh.defaultKeyCommand without one, so those name a program file. It
// splits defaultKeyCommand reading a backslash as an escape, so that path uses
// forward slashes. Plain git, run on a copy of the
// planted repository, shows the setting takes effect; git started through
// lib/commands must not take it. Rows with `caller` are the caller's own
// settings, which still apply.
const COMMIT = ['commit', '-q', '--allow-empty', '-m', 'row'];
const SSH_ORIGIN = 'ssh://git@127.0.0.1:9/acme/demo.git';
const ROWS = [
  { name: 'core.fsmonitor', run: ['status', '--porcelain'], plant: (r) => r.set('core.fsmonitor', r.cmd('fsmonitor')) },
  { name: 'core.hooksPath', run: COMMIT, plant: (r) => r.set('core.hooksPath', r.hook(path.join(r.base, 'hooks'), 'post-commit')) },
  { name: 'the hooks directory', run: COMMIT, plant: (r) => r.hook(path.join(r.gitDir, 'hooks'), 'post-commit') },
  { name: 'diff.external', run: ['diff'], plant: (r) => { r.change(); r.set('diff.external', r.cmd('diff-external')); } },
  { name: 'diff.<driver>.textconv', run: ['diff'], plant: (r) => { r.attributes('* diff=tc'); r.change(); r.set('diff.tc.textconv', r.cmd('textconv')); } },
  { name: 'diff.<driver>.command', run: ['diff'], plant: (r) => { r.attributes('* diff=tc'); r.change(); r.set('diff.tc.command', r.cmd('diff-command')); } },
  { name: 'filter.<driver>.clean', run: ['add', 'README.md'], plant: (r) => { r.attributes('* filter=tc'); r.change(); r.set('filter.tc.clean', r.cmd('filter-clean')); } },
  { name: 'filter.<driver>.smudge', run: ['checkout', '--', 'README.md'], plant: (r) => {
    r.attributes('* filter=tc'); r.set('filter.tc.smudge', r.cmd('filter-smudge')); fs.rmSync(path.join(r.repo, 'README.md'));
  } },
  { name: 'filter.<driver>.process', run: ['add', 'README.md'], plant: (r) => { r.attributes('* filter=tc'); r.change(); r.set('filter.tc.process', r.cmd('filter-process')); } },
  { name: 'merge.<driver>.driver', run: ['merge', '-q', '--no-edit', 'other'], plant: (r) => {
    r.git(['switch', '-q', '-c', 'other']);
    r.change('other\n'); r.git(['commit', '-qam', 'other']);
    r.git(['switch', '-q', 'main']);
    r.change('main\n'); r.git(['commit', '-qam', 'main']);
    r.attributes('* merge=tc'); r.set('merge.tc.driver', r.cmd('merge-driver'));
  } },
  { name: 'core.sshCommand', run: ['fetch', 'origin'], plant: (r) => { r.git(['remote', 'add', 'origin', SSH_ORIGIN]); r.set('core.sshCommand', r.cmd('ssh-command')); } },
  { name: 'GIT_SSH_COMMAND', run: ['fetch', 'origin'], caller: 'caller-ssh-command', plant: (r) => {
    r.git(['remote', 'add', 'origin', SSH_ORIGIN]); r.set('core.sshCommand', r.cmd('ssh-command'));
    return { GIT_SSH_COMMAND: r.cmd('caller-ssh-command') };
  } },
  { name: 'GIT_SSH', run: ['fetch', 'origin'], caller: 'caller-ssh', plant: (r) => {
    r.git(['remote', 'add', 'origin', SSH_ORIGIN]); r.set('core.sshCommand', r.cmd('ssh-command'));
    return { GIT_SSH: r.program('caller-ssh') };
  } },
  { name: 'credential.helper', run: ['fetch', 'origin'], plant: async (r, t) => {
    r.git(['remote', 'add', 'origin', `http://127.0.0.1:${await unauthorizedServer(t)}/acme/demo.git`]);
    r.set('credential.helper', `!${r.cmd('credential-helper')}`);
  } },
  { name: 'credential.<url>.helper', run: ['fetch', 'origin'], plant: async (r, t) => {
    const url = `http://127.0.0.1:${await unauthorizedServer(t)}`;
    r.git(['remote', 'add', 'origin', `${url}/acme/demo.git`]);
    r.set(`credential.${url}.helper`, `!${r.cmd('credential-url-helper')}`);
  } },
  { name: 'gpg.program', run: COMMIT, plant: (r) => { r.set('commit.gpgSign', 'true'); r.set('gpg.program', r.program('gpg-program')); } },
  { name: 'gpg.ssh.defaultKeyCommand', run: COMMIT, plant: (r) => {
    r.set('commit.gpgSign', 'true'); r.set('gpg.format', 'ssh'); r.set('gpg.ssh.defaultKeyCommand', r.program('gpg-key-command').replace(/\\/g, '/'));
  } },
  { name: 'gc.recentObjectsHook', run: COMMIT, plant: (r) => {
    ageLooseObjects(r.gitDir);
    r.set('gc.auto', '1'); r.set('gc.autoDetach', 'false'); r.set('gc.recentObjectsHook', r.cmd('recent-objects-hook'));
  } },
  // The user allows the helper protocol, so only the alias is the repository's.
  { name: 'alias.remote-<name> through a <name>:: URL', run: ['fetch', 'origin'], plant: (r) => {
    r.trust('protocol.tcx.allow', 'always');
    r.git(['remote', 'add', 'origin', 'tcx::anything']); r.set('alias.remote-tcx', `!${r.cmd('helper-alias')}`);
  } },
  { name: 'alias.remote-<name> through remote.<r>.vcs', run: ['fetch', 'origin'], plant: (r) => {
    r.trust('protocol.tcy.allow', 'always');
    r.git(['remote', 'add', 'origin', 'https://127.0.0.1:9/acme/demo.git']); r.set('remote.origin.vcs', 'tcy');
    r.set('alias.remote-tcy', `!${r.cmd('vcs-alias')}`);
  } },
  { name: 'protocol.ext.allow', run: ['fetch', 'origin'], plant: (r) => {
    const ext = [process.execPath, r.script, 'ext-command'].map((a) => a.replace(/%/g, '%%').replace(/ /g, '% ')).join(' ');
    r.git(['remote', 'add', 'origin', `ext::${ext}`]); r.set('protocol.ext.allow', 'always');
  } },
  // A helper the user installed, which git allows only for a typed URL.
  { name: 'protocol.allow', run: ['fetch', 'origin'], plant: (r) => {
    r.git(['remote', 'add', 'origin', 'tcz::anything']); r.set('protocol.allow', 'always');
    return { PATH: r.helper('tcz') };
  } },
  { name: 'protocol.<name>.allow', run: ['fetch', 'origin'], plant: (r) => {
    r.git(['remote', 'add', 'origin', 'tcz::anything']); r.set('protocol.tcz.allow', 'always');
    return { PATH: r.helper('tcz') };
  } },
  // git pages only to a terminal.
  { name: 'core.pager', run: ['log', '-1'], tty: true, plant: (r) => { r.set('core.pager', r.cmd('core-pager')); return { PAGER: 'cat' }; } },
  { name: 'pager.<cmd>', run: ['log', '-1'], tty: true, plant: (r) => { r.set('pager.log', r.cmd('pager-log')); return { PAGER: 'cat' }; } },
  // The user's git-lfs filter downloads a.bin through the agent the
  // repository names.
  { name: 'lfs.customtransfer.<name>.path', lfs: true, run: ['checkout', '--', 'a.bin'], plant: (r) => {
    r.lfs(); r.set('lfs.standalonetransferagent', 'tc'); r.set('lfs.customtransfer.tc.path', r.program('lfs-transfer'));
  } },
  { name: 'lfs.<url>.standalonetransferagent', lfs: true, run: ['checkout', '--', 'a.bin'], plant: (r) => {
    r.lfs(); r.set(`lfs.${LFS_URL}.standalonetransferagent`, 'tc'); r.set('lfs.customtransfer.tc.path', r.program('lfs-transfer'));
  } },
  // git-lfs splits an extension command at spaces and runs it without a shell.
  { name: 'lfs.extension.<name>.clean', lfs: true, run: ['add', 'b.bin'], plant: (r) => {
    r.lfs(); fs.writeFileSync(path.join(r.repo, 'b.bin'), 'content\n');
    const command = [process.execPath, r.script, 'lfs-extension'].join(' ');
    for (const [key, value] of [['clean', command], ['smudge', command], ['priority', '0']]) r.set(`lfs.extension.tc.${key}`, value);
  } },
];
const LFS_AVAILABLE = cp.spawnSync('git-lfs', ['version'], { timeout: 10000 }).status === 0;
const LFS_URL = 'http://127.0.0.1:9/acme/demo.git/info/lfs';

function rowRepo(h) {
  const marker = path.join(h.base, 'planted');
  const script = path.join(h.base, 'planted.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\n`);
  const cmd = (name) => `${shellQuote(process.execPath)} ${shellQuote(script)} ${name}`;
  const bin = path.join(h.base, 'bin');
  const program = (name) => {
    fs.mkdirSync(bin, { recursive: true });
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${cmd(name)}\n`, { mode: 0o755 });
    return file;
  };
  const gitDir = path.join(h.repo, '.git');
  return {
    base: h.base, repo: h.repo, gitDir, script, cmd, program, git: h.git,
    set: (key, value) => h.git(['config', key, value]),
    trust: (key, value) => h.git(['config', '--file', h.env.GIT_CONFIG_GLOBAL, key, value]),
    change: (text = 'changed\n') => fs.writeFileSync(path.join(h.repo, 'README.md'), text),
    attributes: (line) => fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), `${line}\n`),
    hook: (dir, name) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${cmd(`hook-${name}`)}\n`, { mode: 0o755 });
      return dir;
    },
    helper: (name) => { program(`git-remote-${name}`); return `${bin}${path.delimiter}${process.env.PATH}`; },
    // A committed pointer whose object is not here, under the filter
    // `git lfs install` puts in the user's config. a.bin is left to check out.
    lfs: () => {
      fs.writeFileSync(path.join(h.repo, 'a.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'1'.repeat(64)}\nsize 5\n`);
      h.git(['add', 'a.bin']);
      h.git(['commit', '-qm', 'pointer']);
      fs.rmSync(path.join(h.repo, 'a.bin'));
      for (const [key, value] of [['process', 'git-lfs filter-process'], ['required', 'true']]) h.git(['config', '--file', h.env.GIT_CONFIG_GLOBAL, `filter.lfs.${key}`, value]);
      fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '*.bin filter=lfs\n');
      h.git(['config', 'lfs.url', LFS_URL]);
      h.git(['config', 'lfs.transfer.maxretries', '1']);
    },
    ran: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []),
    clear: () => fs.rmSync(marker, { force: true }),
  };
}

test('git started through lib/commands takes none of the listed settings from repository config', async (t) => {
  const commands = require('../lib/commands');
  for (const row of ROWS) {
    await t.test(row.name, { skip: (row.tty && !PTY_AVAILABLE && 'no pty') || (row.lfs && !LFS_AVAILABLE && 'no git-lfs') }, async (t) => {
      const h = makeRepo(t);
      const r = rowRepo(h);
      const env = { ...h.env, GIT_TERMINAL_PROMPT: '0', ...(await row.plant(r, t)) };
      const git = (spawn, dir, rowEnv) => (row.tty
        ? cp.spawnSync('script', ['-qec', ['git', '-C', dir, ...row.run].map(shellQuote).join(' '), '/dev/null'], { env: rowEnv, encoding: 'utf8', timeout: 60000 })
        : spawn('git', ['-C', dir, ...row.run], { env: rowEnv, encoding: 'utf8', timeout: 60000 }));
      if (!row.caller) {
        const control = path.join(h.base, 'control');
        fs.cpSync(h.repo, control, { recursive: true, preserveTimestamps: true });
        git(cp.spawnSync, control, env);
        assert.notDeepEqual(r.ran(), [], 'plain git takes the planted setting');
        r.clear();
      }
      if (row.tty) git(null, h.repo, commands.gitEnv(h.repo, env));
      else git(commands.spawnSync, h.repo, env);
      // git can start ssh twice for one fetch, once to probe its variant.
      assert.deepEqual([...new Set(r.ran())], row.caller ? [row.caller] : []);
    });
  }
});

test('tower-crane worktree takes no git-lfs transfer agent from repository config', { skip: !LFS_AVAILABLE && 'no git-lfs' }, (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Lfs', '--acceptance', 'works']);
  const r = rowRepo(h);
  r.lfs();
  r.set('lfs.standalonetransferagent', 'tc');
  r.set('lfs.customtransfer.tc.path', r.program('lfs-transfer'));
  cp.spawnSync('git', ['-C', h.repo, 'worktree', 'add', '-q', '--detach', path.join(h.base, 'control')], { env: h.env, stdio: 'ignore', timeout: 60000 });
  assert.notDeepEqual(r.ran(), [], 'plain git runs the planted agent');
  r.clear();

  h.run(['worktree', 'T1', '--agent', 'orchestrator'], { env: { GIT_TERMINAL_PROMPT: '0' } });
  assert.deepEqual(r.ran(), []);
});
