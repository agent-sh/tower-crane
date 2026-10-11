'use strict';
// Secrets handoff and the sandbox a spawned agent gets, through stub harnesses
// (test/fixtures/harness-stub.js) in a scratch home.
const fs = require('node:fs');
const path = require('node:path');
const { H, ROOT, rec, save, out } = require('./lib');

const STUB = path.join(ROOT, 'test', 'fixtures', 'harness-stub.js');
const SECRET = 'T101-PLANTED';

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}
const holding = (dir, needle) => walk(dir).filter((f) => fs.readFileSync(f, 'utf8').includes(needle)).map((f) => path.relative(dir, f));

const h = H.makeRepo();
try {
  h.init();
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'nothing leaks']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe\n' });
  const home = path.join(h.base, 'home');
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };
  put('.cache/some-tool/bin/tool.js', '// an installed tool under the cache\n');
  put('.config/gh/hosts.yml', 'github.com:\n  user: probe\n');
  put('.claude/settings.json', '{}');
  put('.codex/config.toml', [
    'model = "m"', 'model_provider = "p"', '',
    '[model_providers.p]', 'name = "P"',
    `apikey = "${SECRET}-APIKEY"`, `key = "${SECRET}-KEY"`, `bearer = "${SECRET}-BEARER"`, `api_key = "${SECRET}-API_KEY"`, '',
  ].join('\n'));
  put('private.env', `PROBE_FILE_SECRET=${SECRET}-ENVFILE\n`);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)})(${JSON.stringify(name)});\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = token ]; then echo ${SECRET}-GH-TOKEN; exit 0; fi\necho fake gh\n`, { mode: 0o755 });
  const stubOut = path.join(h.base, 'stub.json');
  const env = { ...h.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: stubOut,
    GH_TOKEN: '', GITHUB_TOKEN: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CACHE_HOME: '' };
  h.ok(['project', 'set', '--env_file', path.join(home, 'private.env')], { env });

  // Claude worker.
  h.ok(['ladder', 'set', 'medium', '--harness', 'claude', '--model', 'fixture-large', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  let r = h.run(['spawn', '--task', 'T1', '--wait', '--json'], { env });
  const report = JSON.parse(fs.readFileSync(stubOut, 'utf8'));
  const sfs = report.settings?.sandbox?.filesystem || {};
  const cache = path.join(home, '.cache');
  rec('S1', 'sandbox', 'tower-crane spawn --task T1 --wait on a claude worker rung (stub); read sandbox.filesystem.allowWrite from the settings the stub loaded',
    'the worker writes its worktree, the git dir and a cache of its own, not the whole user cache that holds installed tools',
    `${out(r).split('\n')[0]}; allowWrite: ${JSON.stringify(sfs.allowWrite)}`, (sfs.allowWrite || []).includes(cache) ? 'CONFIRMED' : 'held');
  const denied = sfs.denyRead || [];
  const credentialPaths = ['.config/gh', '.claude', '.codex', '.docker', '.npmrc', '.netrc', '.git-credentials'].map((p) => path.join(home, p));
  const open = credentialPaths.filter((p) => !denied.some((d) => p === d || p.startsWith(`${d}${path.sep}`)));
  rec('S2', 'sandbox/secrets', 'same spawn: compare sandbox.filesystem.denyRead with the user credential stores (gh, claude, codex, docker, npm, netrc, git-credentials)',
    'credential stores in the user home are unreadable inside the sandbox (network allows every domain)',
    `denyRead: ${JSON.stringify(denied)}; network.allowedDomains: ${JSON.stringify(report.settings?.sandbox?.network?.allowedDomains)}; readable: ${open.map((p) => path.relative(home, p)).join(', ')}`,
    open.length ? 'CONFIRMED' : 'held');
  rec('S3', 'secrets', 'same spawn: gh auth token (stub) handed to the agent as GH_TOKEN; search the state directory for it',
    'the token reaches the agent process only, never a state file', `agent saw GH_TOKEN: ${report.ghToken ? 'yes' : 'no'}; state files holding it: ${JSON.stringify(holding(h.state, `${SECRET}-GH-TOKEN`))}`,
    holding(h.state, `${SECRET}-GH-TOKEN`).length ? 'CONFIRMED' : 'held');
  rec('S4', 'secrets', 'same spawn with project env_file holding PROBE_FILE_SECRET; search the state directory and the home cache for the value',
    'the value is in no state file, event or receipt', `state files: ${JSON.stringify(holding(h.state, `${SECRET}-ENVFILE`))}; cache files: ${JSON.stringify(holding(cache, `${SECRET}-ENVFILE`))}`,
    holding(h.state, `${SECRET}-ENVFILE`).length || holding(cache, `${SECRET}-ENVFILE`).length ? 'CONFIRMED' : 'held');
  const dry = h.run(['spawn', '--task', 'T1', '--dry-run'], { env });
  rec('S5', 'secrets', 'tower-crane spawn --task T1 --dry-run with the env_file and the gh token available', 'neither value printed',
    `env_file value printed: ${dry.stdout.includes(`${SECRET}-ENVFILE`)}; gh token printed: ${dry.stdout.includes(`${SECRET}-GH-TOKEN`)}`,
    dry.stdout.includes(SECRET) ? 'CONFIRMED' : 'held');

  // Codex worker: provider keys the scrub may miss.
  h.ok(['task', 'add', '--title', 'Probe codex', '--acceptance', 'nothing leaks']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'probe\n' });
  h.ok(['ladder', 'set', 'medium', '--harness', 'codex', '--profile', 'fixture-main', '--clear', 'model', '--clear', 'effort', '--clear', 'args']);
  put('.codex/fixture-main.config.toml', 'model = "s"\n');
  r = h.run(['spawn', '--task', 'T2', '--wait', '--json'], { env });
  const leaked = holding(h.state, SECRET).filter((f) => !f.startsWith('logs'));
  const which = ['APIKEY', 'KEY"', 'BEARER', 'API_KEY'].filter((k) => walk(h.state).some((f) => fs.readFileSync(f, 'utf8').includes(`${SECRET}-${k}`)));
  rec('S6', 'secrets/redaction', 'codex worker spawn with [model_providers.p] keys apikey, key, bearer and api_key in the user config.toml; search the agent home in the state directory',
    'no credential value is copied into the codex home', `${out(r).split('\n')[0]}; files: ${JSON.stringify(leaked)}; values copied: ${JSON.stringify(which)}`,
    leaked.length ? 'CONFIRMED' : 'held');
} finally {
  save('secrets');
  fs.rmSync(h.base, { recursive: true, force: true });
}
