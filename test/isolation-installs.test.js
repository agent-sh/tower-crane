'use strict';

// What else a spawned agent's sandbox shows: node installs and harness programs
// under the home, whole-home read paths, repository imports, the user's git
// settings, gh config, write rules, protected git paths and caches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, BIN } = require('./helpers');
const { STUB, NO_STUBS, SECRET, setup, isolateGitEnvironment, spawn, isolated, commandsRead } = require('./isolation-helpers');

test('node installs and harness programs under the home stay readable; other installs there do not', { skip: NO_STUBS }, t => {
  // Seen 2026-10-12: codex runs its own binary inside its sandbox through a
  // link in its home, and hiding it stopped every Codex worker from starting.
  const { h, u } = setup(t);
  const prefix = path.join(u.home, '.nvm', 'versions', 'node', 'v0');
  const other = path.join(u.home, '.nvm', 'versions', 'node', 'v1', 'bin', 'node');
  for (const node of [path.join(prefix, 'bin', 'node'), other]) {
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
  }
  const vendored = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'vendor', 'codex');
  fs.mkdirSync(path.dirname(vendored), { recursive: true });
  fs.writeFileSync(vendored, '#!/bin/sh\n', { mode: 0o755 });
  // A harness installed under the home on PATH, outside any node install.
  const tools = path.join(u.home, 'tools-bin');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
  // A node in ~/.local/bin opens that directory, never ~/.local/share.
  const local = path.join(u.home, '.local', 'bin', 'node');
  const share = path.join(u.home, '.local', 'share', 'opencode', 'auth.json');
  for (const [file, text] of [[local, '#!/bin/sh\n'], [share, `${SECRET}-LOCAL\n`]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o755 });
  }
  // The node installs last on PATH, so the real node keeps running the stubs.
  const env = { PATH: [tools, u.env.PATH, path.join(prefix, 'bin'), path.dirname(local)].join(path.delimiter) };
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'medium', harness);
    spawn(h, u, 'medium', env);
    const seen = u.report();
    for (const p of [vendored, path.join(prefix, 'bin', 'node'), path.join(tools, 'opencode'), local]) {
      assert.equal(commandsRead(seen, p), true, `${harness}: ${p} is readable`);
    }
    assert.equal(commandsRead(seen, other), false, `${harness}: a node install not on PATH stays hidden`);
    assert.equal(commandsRead(seen, share), false, `${harness}: a node in ~/.local/bin leaves ~/.local/share hidden`);
  }
});

test('a sandbox read path that is the whole home refuses dispatch', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ read: ['~'] })]);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    fs.rmSync(u.out, { force: true });
    const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env: u.env });
    assert.notEqual(refused.code, 0, `${harness}: reading the whole home must refuse dispatch`);
    assert.match(refused.stderr, /sandbox path .* is the user's home/);
    assert.ok(!fs.existsSync(u.out), 'the harness must not start');
  }
  // A directory that holds the home would open all of it: / mounts the whole
  // filesystem in codex's sandbox.
  for (const read of ['/', path.dirname(u.home)]) {
    h.ok(['project', 'set', '--sandbox', JSON.stringify({ read: [read] })]);
    for (const harness of ['claude', 'codex']) {
      isolated(h, 'hard', harness);
      fs.rmSync(u.out, { force: true });
      const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env: u.env });
      assert.notEqual(refused.code, 0, `${harness}: reading ${read} must refuse dispatch`);
      assert.match(refused.stderr, /sandbox path .* holds the user's home/);
      assert.ok(!fs.existsSync(u.out), 'the harness must not start');
    }
  }
  assert.notEqual(h.run(['project', 'set', '--sandbox', JSON.stringify({ read: 'tools' })]).code, 0, 'sandbox.read must be a list of paths');
});

test('repository imports of files under the home the agent may not read refuse startup', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const docker = path.join(u.home, '.docker', 'config.json');
  fs.mkdirSync(path.dirname(docker), { recursive: true });
  fs.writeFileSync(docker, '{"auths":{"example":{"auth":"IMPORT-SECRET"}}}\n');
  const auth = path.join(u.home, '.codex', 'auth.json');
  const alias = path.join(wt, 'credential-import.md');
  fs.symlinkSync(auth, alias);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    for (const file of [auth, docker, alias]) {
      fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${file}\n`);
      if (file === alias) {
        // A global rule importing the repository's file does not make its imports the user's.
        const global = path.join(u.home, harness === 'claude' ? '.claude/CLAUDE.md' : '.codex/AGENTS.md');
        fs.appendFileSync(global, `@${path.join(wt, 'AGENTS.md')}\n`);
      }
      for (const mode of ['--dry-run', '--wait']) {
        const r = h.run(['spawn', '--task', 'T1', '--role', 'hard', mode], { env: u.env });
        assert.notEqual(r.code, 0, `${harness}: ${file} must not load into the harness`);
        assert.match(r.stderr, /house rule .* is under the user's home outside the agent's readable paths/);
        assert.doesNotMatch(r.stdout + r.stderr, /IMPORT-SECRET|PLANTED-SECRET/);
        assert.ok(!fs.existsSync(u.out), 'refuse before starting the harness');
      }
    }
    fs.rmSync(path.join(wt, 'AGENTS.md'));
  }
  // The user's own global rules may import a file under the home; it stays readable.
  const notes = path.join(u.home, 'notes', 'rules.md');
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, 'USER-NOTES\n');
  fs.writeFileSync(path.join(u.home, '.claude', 'CLAUDE.md'), `PLANTED-MEMORY\n@${notes}\n`);
  isolated(h, 'hard', 'claude');
  spawn(h, u, 'hard');
  assert.equal(commandsRead(u.report(), notes), true, 'a global rule import stays readable');
});

test('a sandboxed agent runs with the user\'s git settings but none of their credential helpers, and no helper answers for GitHub', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const { global } = isolateGitEnvironment(h, u);
  const included = path.join(h.base, 'included.gitconfig');
  fs.writeFileSync(included, '[alias]\n\tst = status\n[credential "https://example.com"]\n\thelper = store\n');
  const ignore = path.join(u.home, 'global.gitignore');
  fs.writeFileSync(ignore, '*.planted\n');
  fs.writeFileSync(global, [
    '[user]', '\tname = Planted User', '\temail = planted@example.com',
    '[credential]', '\thelper = cache --timeout=3600',
    '[http "https://github.com/"]', '\textraHeader = AUTHORIZATION: bearer HEADER-SECRET',
    '[core]', '\texcludesFile = ~/global.gitignore',
    '[include]', `\tpath = ${included}`,
    // Secrets git keeps outside credential.*: a URL's userinfo and a mail password.
    '[url "https://x:URL-SECRET@github.com/"]', '\tinsteadOf = https://github.com/',
    '[url "ssh://git@example.com/"]', '\tinsteadOf = https://example.com/',
    '[http]', '\tproxy = http://u:PROXY-SECRET@proxy.example:8080',
    '[sendemail]', '\tsmtpPass = SMTP-SECRET', '',
  ].join('\n'));
  const git = require(path.join(ROOT, 'lib', 'shim.js')).findReal('git', '');
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    const started = spawn(h, u, 'hard');
    const seen = u.report();
    const rendered = path.join(h.state, 'homes', started.agent, 'home', '.gitconfig');
    // O_NOFOLLOW refuses a link, so one open proves the file is the agent's own.
    const fd = fs.openSync(rendered, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let text;
    try {
      assert.equal(fs.fstatSync(fd).isFile(), true, `${harness}: the agent's git config is its own file`);
      text = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
    assert.doesNotMatch(text, /HEADER-SECRET|cache --timeout|helper = "?store/, 'no credential helper or auth header');
    assert.doesNotMatch(text, /URL-SECRET|PROXY-SECRET|SMTP-SECRET/, 'no URL userinfo or mail password');
    const gitEnv = { ...h.env, GIT_CONFIG_GLOBAL: rendered, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const get = (key) => cp.spawnSync(git, ['config', '--global', '--get', key], { env: gitEnv, encoding: 'utf8' }).stdout.trim();
    assert.equal(get('user.name'), 'Planted User');
    assert.equal(get('alias.st'), 'status', 'included files are flattened in');
    assert.equal(get('core.excludesfile'), ignore);
    assert.equal(get('url.ssh://git@example.com/.insteadof'), 'https://example.com/', 'a user name in an ssh URL stays');
    assert.equal(get('http.proxy'), 'http://proxy.example:8080');
    assert.equal(commandsRead(seen, ignore), true, `${harness}: the excludes file it names stays readable`);
    // A token an agent finds, or sets, in its environment reaches no helper:
    // the agent's pushes go through its broker (lib/github-broker.js).
    const fill = (host) => cp.spawnSync(git, ['credential', 'fill'], {
      env: { ...gitEnv, GH_TOKEN: 'found-token', GITHUB_TOKEN: 'found-token' }, input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', cwd: h.base,
    });
    for (const host of ['github.com', 'example.com']) {
      const filled = fill(host);
      assert.notEqual(filled.status, 0, `${harness}: ${host} gets no credential`);
      assert.doesNotMatch(filled.stdout, /password=/, `${harness}: ${host}`);
    }
  }
});

test('harness roots cover an npm package, never a whole bin directory', { skip: process.platform === 'win32' && 'shebang bins' }, t => {
  const base = makeRepo(t).base;
  const pkg = path.join(base, 'lib', 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(pkg, 'bin', 'codex.js'), path.join(bin, 'codex'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const roots = require(path.join(ROOT, 'lib', 'agents')).harnessRoots({ cwd: base, env: { PATH: bin } });
  assert.deepEqual(roots.sort(), [fs.realpathSync(path.join(bin, 'claude')), fs.realpathSync(pkg)].sort());
});

test('gh config isolation survives settings on initial and fallback launches, and the agent\'s gh runs on the host with the user\'s config', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  const reports = path.join(h.base, 'gh-launches.jsonl');
  const original = path.join(h.base, 'original-gh');
  const selected = path.join(h.base, 'settings-gh');
  fs.mkdirSync(original);
  fs.mkdirSync(selected);
  fs.writeFileSync(path.join(h.base, 'bin', 'gh'), `#!${process.execPath}
const path = require('node:path');
if (process.argv[2] === 'auth') {
  if (process.env.GH_CONFIG_DIR !== ${JSON.stringify(original)}) process.exit(1);
  console.log('stub-gh-token');
} else {
  // The broker's gh, on the host: the user's own config, and no token.
  if (process.env.GH_CONFIG_DIR !== ${JSON.stringify(original)}) {
    console.error('not the gh config of the user'); process.exit(1);
  }
  if (process.env.GH_TOKEN) process.exit(1);
}
`);
  for (const harness of ['claude', 'codex']) fs.writeFileSync(path.join(h.base, 'bin', harness), `#!${process.execPath}
const fs = require('node:fs');
require(${JSON.stringify(STUB)})(${JSON.stringify(harness)});
const report = JSON.parse(fs.readFileSync(process.env.STUB_OUT, 'utf8'));
fs.appendFileSync(${JSON.stringify(reports)}, JSON.stringify({ harness: report.harness, ran: report.ran, token: report.ghToken,
  config: process.env.GH_CONFIG_DIR, home: process.env.HOME }) + '\\n');
if (process.env.STUB_FAIL_HARNESS === ${JSON.stringify(harness)}) {
  console.error('HTTP 503 service unavailable'); process.exit(1);
}
`);
  const envFile = path.join(h.base, 'gh-settings.env');
  fs.writeFileSync(envFile, `GH_CONFIG_DIR=${JSON.stringify(selected)}\n`);
  for (const source of ['literal', 'file']) {
    h.ok(['project', 'set', '--env', source === 'literal' ? JSON.stringify({ GH_CONFIG_DIR: selected }) : '{}', '--env_file', envFile]);
    for (const primary of ['claude', 'codex']) {
      const fallback = primary === 'claude' ? 'codex' : 'claude';
      isolated(h, 'hard', primary);
      h.ok(['ladder', 'set', 'hard', '--supervision', '{"retries":0,"backoff_ms":10,"max_backoff_ms":10}']);
      // A fallback's env is a grant only the owner's ladder set makes.
      h.ok(['ladder', 'set', 'hard', '--fallbacks', JSON.stringify([{
        harness: fallback, model: 'second', ...(source === 'literal' ? { env: { GH_CONFIG_DIR: selected } } : {}),
      }])]);
      fs.rmSync(reports, { force: true });
      spawn(h, u, 'hard', { GH_CONFIG_DIR: original, STUB_FAIL_HARNESS: primary,
        STUB_RUN: JSON.stringify([['gh', 'pr', 'view', '1']]) });
      const seen = fs.readFileSync(reports, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(seen.map(report => report.harness), [primary, fallback]);
      for (const report of seen) {
        assert.equal(report.token, null, `${source} ${report.harness}: the agent holds no gh token`);
        assert.equal(report.config, path.join(report.home, '.config', 'gh'), `${source} ${report.harness}: the agent's gh config is its own`);
        assert.equal(report.ran[0].code, 0, `${source} ${report.harness}: ${report.ran[0].stderr}`);
      }
    }
  }
});

test('a brokered ci log runs the host gh, not the agent\'s gh shim that refuses gh api', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  isolated(h, 'hard', 'claude');
  const branch = h.readState('tasks.json').tasks[0].branch;
  const sha = h.git(['rev-parse', 'HEAD']);
  const data = path.join(h.base, 'ci-feedback.json');
  fs.writeFileSync(data, JSON.stringify({
    jobs: { 42: { id: 42, name: 'test', head_branch: branch, head_sha: sha } },
    refs: { [`heads/${branch}`]: { ref: `refs/heads/${branch}`, object: { sha } } },
    logs: { 42: 'not ok 1 - read through the broker\n' },
    alerts: {},
  }));
  // The host gh: the plant's keyring login, and the CI feedback endpoints.
  fs.writeFileSync(path.join(h.base, 'bin', 'gh'), `#!${process.execPath}
if (process.argv[2] === 'auth' && process.argv[3] === 'token') console.log('stub-gh-token');
else require(${JSON.stringify(path.join(__dirname, 'fixtures', 'ci-feedback-gh.js'))});
`, { mode: 0o755 });
  // The agent's PATH starts with its home's gh shim, which refuses gh api.
  spawn(h, u, 'hard', { CI_FEEDBACK_GH: data, STUB_RUN: JSON.stringify([[process.execPath, BIN, 'ci', 'log', '42']]) });
  const seen = u.report();
  assert.equal(seen.ran[0].code, 0, seen.ran[0].stderr);
  const scratch = h.readState('tasks.json').tasks[0].scratch;
  assert.equal(fs.readFileSync(path.join(scratch, 'ci-job-42.log'), 'utf8'), 'not ok 1 - read through the broker\n');
});

test('a codex agent writes only where its agent file says; a worker writes its git metadata, reviewer and small checks cannot write the worktree', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  // A worker fetches, adds, commits and pushes: it writes the repository's
  // git directory and its worktree's admin directory inside it.
  const common = fs.realpathSync(h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt));
  const own = fs.realpathSync(h.git(['rev-parse', '--path-format=absolute', '--git-dir'], wt));
  // A submodule named lib/a keeps its git directory in modules/lib/a.
  const mod = path.join(common, 'modules', 'lib', 'a');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(mod, 'config'), '');
  fs.rmSync(path.join(common, 'info'), { recursive: true, force: true });
  // What makes git outside the sandbox run commands, or read another config,
  // stays read-only though the git directory around it is writable.
  const guarded = [path.join(common, 'config'), path.join(common, 'config.worktree'), path.join(common, 'hooks'), path.join(common, 'info'),
    path.join(common, 'remotes'), path.join(common, 'branches'),
    path.join(mod, 'config'), path.join(mod, 'hooks'), path.join(own, 'config.worktree'), path.join(own, 'commondir'), path.join(own, 'gitdir'),
    path.join(fs.realpathSync(wt), '.git')];
  const globalSeen = [process.execPath, '-e', 'process.stderr.write(String(process.env.GIT_CONFIG_GLOBAL))'];
  for (const [rung, worktree] of [['hard', 'write'], ['review', 'read'], ['small', 'read']]) {
    isolated(h, rung, 'codex');
    const started = spawn(h, u, rung, { STUB_RUN: JSON.stringify([globalSeen]) });
    const home = path.join(h.state, 'homes', started.agent);
    const { config, ran } = u.report();
    const rules = config.permissions['tower-crane'].filesystem;
    for (const d of [common, own]) assert.equal(rules[d], worktree, `${rung}: ${d}`);
    for (const p of guarded) assert.equal(rules[p], worktree === 'write' ? 'read' : undefined, `${rung}: ${p}`);
    // The global config git reads, in the sandbox too: the rendered config
    // (lib/git-config.js) in the state directory, which the agent reads and
    // never writes; a codex agent writes its HOME, where the copy is read-only.
    const global = path.join(h.state, 'gitconfig', started.agent);
    assert.equal(ran[0].stderr, global, `${rung}: GIT_CONFIG_GLOBAL`);
    assert.equal(fs.readFileSync(global, 'utf8'), fs.readFileSync(path.join(home, 'home', '.gitconfig'), 'utf8'), rung);
    assert.match(fs.readFileSync(global, 'utf8'), /\[credential\]\n\thelper = ""\n$/, `${rung}: the rendered config clears every credential helper`);
    assert.doesNotMatch(fs.readFileSync(global, 'utf8'), /credential "https:\/\/github\.com"|GH_TOKEN/, `${rung}: no helper answers for GitHub`);
    assert.equal(rules[path.join(home, 'home', '.gitconfig')], 'read', `${rung}: the copy in its HOME`);
    assert.equal(rules[path.join(common, 'worktrees')], worktree === 'write' ? 'read' : undefined, `${rung}: other worktrees' admin directories`);
    assert.deepEqual(rules[':workspace_roots'], { '.': worktree }, rung);
    assert.equal(rules[':minimal'], 'read', rung);
    assert.equal(rules[h.state], 'read', `${rung}: the state is read-only; the broker writes it`);
    assert.equal(rules[path.join(h.state, 'homes')], 'none', `${rung}: other agent homes are hidden, including future spawns`);
    assert.equal(rules[home], 'read', `${rung}: its generated home remains readable`);
    const sessionRoot = path.join(h.state, 'homes', '.codex', started.agent);
    assert.equal(rules[sessionRoot], 'write', `${rung}: only its persisted sessions are writable`);
    assert.equal(started.codex_home, sessionRoot);
    assert.equal(fs.readlinkSync(path.join(h.state, 'homes', started.agent, 'sessions')), path.join(sessionRoot, 'sessions'));
    assert.equal(rules[path.join(h.state, 'brokers')], 'none', `${rung}: no agent reads another agent's broker token`);
    assert.equal(rules[path.join(h.state, 'ci-artifacts')], 'none', `${rung}: no agent reads unredacted local CI artifacts`);
    assert.equal(rules[path.join(h.state, 'brokers', started.agent)], 'write', `${rung}: its own broker directory is visible`);
    assert.equal(rules[path.join(home, 'home')], 'write', `${rung}: its HOME is writable`);
    // Codex mounts every readable path, then hides each 'none' directory,
    // then mounts the writable paths: a path under a hidden directory is
    // visible only if a writable rule names it or a directory between.
    const visible = (p) => {
      const named = Object.keys(rules).filter((k) => !k.startsWith(':') && (p === k || p.startsWith(k + path.sep)));
      const hidden = named.filter((k) => rules[k] === 'none');
      return hidden.every((d) => named.some((k) => rules[k] === 'write' && k.startsWith(d + path.sep)));
    };
    for (const p of [path.join(home, 'home'), path.join(h.state, 'brokers', started.agent, 'broker.json')]) {
      assert.ok(visible(p), `${rung}: the agent's commands see ${p}`);
    }
    assert.ok(!visible(path.join(h.state, 'brokers', 'worker-T9-1', 'broker.json')), `${rung}: another agent's token is hidden`);
    assert.equal(config.permissions['tower-crane'].network.enabled, true);
  }
  // The codex loop left T1 submitted; a worker needs a task it can claim.
  h.ok(['rework', 'T1', '--reason', 'probe the claude rungs']);
  // Other worktrees' admin directories, whose commondir and config.worktree
  // decide which config git reads there, are read-only, including one added
  // later: the task worktree's own lives outside worktrees/. claude adds a
  // linked worktree's common directory to its sandbox's writes itself, so a
  // read-only role gets the same carve-outs.
  assert.equal(path.dirname(own), path.join(path.dirname(fs.realpathSync(wt)), '.git-admin'));
  const worktrees = path.join(common, 'worktrees');
  for (const [rung, writes] of [['hard', true], ['small', false]]) {
    isolated(h, rung, 'claude');
    spawn(h, u, rung);
    const { allowWrite: allow, denyWrite: deny } = u.report().settings.sandbox.filesystem;
    for (const d of [common, own]) assert.equal(allow.includes(d), writes, `claude ${rung}: ${d}`);
    for (const p of [...guarded, worktrees]) assert.ok(deny.includes(p), `claude ${rung}: ${p}`);
    assert.ok(!deny.some((p) => own === p || own.startsWith(p + path.sep)), `claude ${rung}: its own admin directory stays writable`);
  }
  // Each guarded path exists, so no sandbox masks it with a placeholder.
  for (const p of guarded) assert.ok(fs.existsSync(p), p);
  assert.ok(fs.statSync(path.join(common, 'info')).isDirectory());
});

test('a link planted at a protected git path refuses the spawn and leaves its target untouched', { skip: NO_STUBS || (process.platform === 'win32' && 'symlinks need privileges on Windows') }, (t) => {
  const { h, u, wt } = setup(t);
  const common = h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt);
  // A sandbox would protect the target and leave the link to be swapped.
  const target = path.join(h.base, 'elsewhere');
  fs.writeFileSync(target, 'untouched\n');
  fs.symlinkSync(target, path.join(common, 'config.worktree'));
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    const r = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env: u.env });
    assert.notEqual(r.code, 0, harness);
    assert.match(r.stderr, /config\.worktree is a link; a sandbox cannot keep it read-only/, harness);
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n', harness);
    assert.ok(fs.lstatSync(path.join(common, 'config.worktree')).isSymbolicLink(), harness);
  }
});

test('a sandboxed harness\'s own git runs no command the shared config, hooks, nested repo or the agent\'s HOME name; the agent\'s sandboxed git still runs hooks and drivers', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  fs.writeFileSync(path.join(wt, 'f.txt'), 'one\n');
  fs.writeFileSync(path.join(wt, 'g.txt'), 'one\n');
  h.git(['add', 'f.txt', 'g.txt'], wt);
  h.git(['commit', '-qm', 'f'], wt);
  const sub = path.join(wt, 'sub');
  h.git(['init', '-q', sub]);
  fs.writeFileSync(path.join(sub, 'f.txt'), 'one\n');
  h.git(['add', 'f.txt'], sub);
  h.git(['commit', '-qm', 'sub'], sub);
  h.git(['add', 'sub'], wt);
  h.git(['commit', '-qm', 'gitlink'], wt);
  // What a worker could have planted in the shared git directory.
  const common = h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt);
  // Each marks only a run under the spawned harness, whose environment alone
  // has TOWER_CRANE_SESSION: Tower Crane's own git and this test's are out of scope here.
  const mark = (name) => path.join(h.base, `ran-${name}`);
  const touch = (name) => `[ -z "$TOWER_CRANE_SESSION" ] || touch '${mark(name)}'`;
  h.git(['config', 'core.fsmonitor', `${touch('fsmonitor')}; false`], wt);
  h.git(['config', 'filter.planted.clean', `${touch('filter')}; cat`], wt);
  fs.writeFileSync(path.join(common, 'info', 'attributes'), 'f.txt filter=planted\ng.txt filter=home\n');
  fs.writeFileSync(path.join(common, 'hooks', 'post-checkout'), `#!/bin/sh\n${touch('hook')}\n`, { mode: 0o755 });
  const marks = ['fsmonitor', 'filter', 'hook', 'home', 'submodule'];
  // A codex agent writes its HOME, so after launch it can swap the linked
  // ~/.gitconfig for one that names a driver the scan never saw.
  const homeConfig = `const fs = require('node:fs'); const f = require('node:path').join(require('node:os').homedir(), '.gitconfig');
fs.rmSync(f, { force: true }); fs.writeFileSync(f, ${JSON.stringify(`[filter "home"]
	clean = ${touch('home')}; cat
`)});`;
  // A nested repository is writable even when the shared git config is not.
  // Plant its driver after launch, beyond the harness's initial config scan.
  const subConfig = `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(sub, '.git', 'config'))}, ${JSON.stringify(`[filter "nested"]
	clean = ${touch('submodule')}; cat
`)});
fs.writeFileSync(${JSON.stringify(path.join(sub, '.gitattributes'))}, 'f.txt filter=nested\\n');
fs.writeFileSync(${JSON.stringify(path.join(sub, 'f.txt'))}, 'two\\n');`;
  // A command the agent runs, as its sandbox marks it: the repository's hooks
  // run there, and background gc stays off.
  const agent = path.join(h.base, 'agent.json');
  const inSandbox = `const cp = require('node:child_process'); const fs = require('node:fs');
const env = { ...process.env, SANDBOX_RUNTIME: '1' };
cp.execFileSync('git', ['checkout', '-q', '-b', 'probe-agent'], { env });
cp.execFileSync('git', ['status', '--porcelain'], { env });
const gc = cp.execFileSync('git', ['config', 'gc.auto'], { env, encoding: 'utf8' }).trim();
fs.writeFileSync(${JSON.stringify(agent)}, JSON.stringify({ hook: fs.existsSync(${JSON.stringify(mark('hook'))}), submodule: fs.existsSync(${JSON.stringify(mark('submodule'))}), gc }));`;
  for (const harness of ['claude', 'codex']) {
    for (const m of marks) fs.rmSync(mark(m), { force: true });
    // Same size, so status must hash the content through the clean filter.
    for (const f of ['f.txt', 'g.txt']) fs.writeFileSync(path.join(wt, f), harness === 'claude' ? 'two\n' : 'six\n');
    isolated(h, 'hard', harness);
    const run = [[process.execPath, '-e', homeConfig], [process.execPath, '-e', subConfig], ['git', 'status', '--porcelain'], ['git', 'checkout', '-q', '-b', `probe-${harness}`], ['git', 'checkout', '-q', '-']];
    // Like the owner's own session, with no GIT_CONFIG_GLOBAL of its own.
    spawn(h, u, 'hard', { STUB_RUN: JSON.stringify(run), GIT_CONFIG_GLOBAL: undefined });
    const seen = u.report();
    for (const r of seen.ran) assert.equal(r.code, 0, `${harness}: ${r.argv.join(' ')}: ${r.stderr}`);
    assert.deepEqual(marks.filter((m) => fs.existsSync(mark(m))), [], `${harness}: the harness's git ran a planted command`);
    spawn(h, u, 'hard', { STUB_RUN: JSON.stringify([[process.execPath, '-e', inSandbox]]) });
    assert.equal(u.report().ran[0].code, 0, u.report().ran[0].stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(agent, 'utf8')), { hook: true, submodule: true, gc: '0' }, harness);
    h.git(['checkout', '-q', '-'], wt);
    for (const b of [`probe-${harness}`, 'probe-agent']) h.git(['branch', '-D', b], wt);
  }
});

test('worker and reviewer sandboxes write a cache of their own, never the user cache root, the tower-crane install, the CLI on PATH or a gate program', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  // Installed tools and scratch under the user cache run outside any sandbox.
  const root = path.join(u.home, '.cache');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(path.join(tools, 'bin'), { recursive: true });
  for (const f of ['bin/tower-crane', 'run-tests', 'clean-cmd.sh']) fs.writeFileSync(path.join(tools, f), '#!/bin/sh\n', { mode: 0o755 });
  h.ok(['project', 'set', '--tests-cmd', `${path.join(tools, 'run-tests')} --all`, '--clean-cmd', path.join(tools, 'clean-cmd.sh')]);
  const env = { PATH: `${path.join(tools, 'bin')}${path.delimiter}${u.env.PATH}`, XDG_CACHE_HOME: '' };
  const forbidden = [root, ROOT, path.join(tools, 'bin', 'tower-crane'), path.join(tools, 'run-tests'), path.join(tools, 'clean-cmd.sh')].map((p) => fs.realpathSync(p));
  const contains = (dir, p) => p === dir || p.startsWith(dir + path.sep);
  const probe = [process.execPath, '-e', `process.stderr.write(JSON.stringify(${JSON.stringify(['XDG_CACHE_HOME', 'GOCACHE', 'GOMODCACHE', 'npm_config_cache'])}.map((k) => process.env[k])))`];
  const covered = new Set();
  for (const harness of ['claude', 'codex']) {
    // A reviewer runs on the first tier rung at or above the task's tier.
    for (const rung of ['easy', 'medium', 'hard', 'review']) isolated(h, rung, harness);
    for (const rung of ['hard', 'review']) {
      const started = spawn(h, u, rung, { ...env, STUB_RUN: JSON.stringify([probe]) });
      const seen = u.report();
      covered.add(`${seen.harness} ${rung}`);
      const writes = seen.harness === 'claude' ? seen.settings.sandbox.filesystem.allowWrite
        : Object.entries(seen.config.permissions['tower-crane'].filesystem).filter(([k, v]) => !k.startsWith(':') && v === 'write').map(([k]) => k);
      for (const w of writes) {
        for (const p of forbidden) assert.ok(!contains(w, p), `${seen.harness} ${rung}: ${w} grants a write on ${p}`);
      }
      // Besides it, codex and claude write their temp directory, which is the
      // short tc/<12 hex> under the cache root when tmp in the cache is too
      // long (codexTmp, claudeTmp).
      const own = writes.filter((w) => contains(root, w) && w !== seen.tmpdir);
      assert.equal(own.length, 1, `${seen.harness} ${rung}: one directory under the cache root: ${JSON.stringify(own)}`);
      if (writes.includes(seen.tmpdir) && !contains(own[0], seen.tmpdir)) {
        assert.match(seen.tmpdir, /[\\/]tc[\\/][0-9a-f]{12}$/, `${seen.harness} ${rung}: the temp directory is its own`);
      }
      assert.ok(contains(path.join(fs.realpathSync(root), 'tower-crane', rung === 'review' ? 'agents' : 'tasks'), own[0]) && path.basename(own[0]) === (rung === 'review' ? started.agent : 'T1'), own[0]);
      assert.ok(fs.statSync(own[0]).isDirectory(), 'the granted cache exists');
      assert.deepEqual(JSON.parse(seen.ran[0].stderr), [own[0], ...['go-build', 'go-mod', 'npm'].map((d) => path.join(own[0], d))], `${seen.harness} ${rung}: tool caches point at the agent cache`);
    }
  }
  assert.deepEqual([...covered].sort(), ['claude hard', 'claude review', 'codex hard', 'codex review']);
});
