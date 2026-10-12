'use strict';
// What a codex permission profile can express for reads under $HOME, run
// against the real codex sandbox (`codex sandbox`). No model call is made.
//
//   node research/T187-probes/codex-sandbox.js SCRATCH [path/to/codex]
//
// SCRATCH is a writable directory under $HOME; the probe tree and a scratch
// CODEX_HOME (which keeps the user's config out) are made in it. Nothing is
// written elsewhere. Each variant runs the same check inside the sandbox, and
// the baseline runs it outside, so a path the caller's own sandbox already
// hides is told apart from one codex hides. Only readable/denied verdicts are
// printed, never file contents.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const home = fs.realpathSync(os.homedir());
const scratch = fs.realpathSync(process.argv[2]);
const codex = process.argv[3] || 'codex';
const base = path.join(scratch, 'codex-probe');
const codexHome = path.join(base, 'codex-home');
const files = ['hidden/file', 'open/file', 'open/deeper/file', 'open/sub/file'];
fs.rmSync(base, { recursive: true, force: true });
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true });
  fs.writeFileSync(path.join(base, f), 'probe\n');
}
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'config.toml'), '');

const targets = {
  ...Object.fromEntries(files.map((f) => [`<probe>/${f}`, path.join(base, f)])),
  '~': home, '~/.bashrc': path.join(home, '.bashrc'), '~/.gitconfig': path.join(home, '.gitconfig'),
  '~/.config/gh': path.join(home, '.config', 'gh'), '~/.claude/.credentials.json': path.join(home, '.claude', '.credentials.json'),
  '~/.codex/auth.json': path.join(home, '.codex', 'auth.json'), '~/.aws': path.join(home, '.aws'),
  '~/.docker/config.json': path.join(home, '.docker', 'config.json'), '~/.npmrc': path.join(home, '.npmrc'),
  '~/.netrc': path.join(home, '.netrc'), '/etc/hostname': '/etc/hostname',
};
const check = `const fs=require("fs");const t=${JSON.stringify(targets)};const o={};for(const[k,p]of Object.entries(t)){try{const s=fs.statSync(p);if(s.isDirectory())o[k]="readable dir ("+fs.readdirSync(p).length+" entries)";else{fs.closeSync(fs.openSync(p,"r"));o[k]="readable"}}catch(e){o[k]="ERR "+e.code}}console.log(JSON.stringify(o))`;

const at = (...p) => path.join(base, ...p);
const node = path.dirname(fs.realpathSync(process.execPath));
const variants = {
  // A hidden directory with a readable path inside it, and a hidden one inside that.
  nestedRead: { ':root': 'read', ':tmpdir': 'write', [at()]: 'none', [at('open')]: 'read', [at('open', 'deeper')]: 'none' },
  // The same with the inner path writable.
  nestedWrite: { ':root': 'read', ':tmpdir': 'write', [at()]: 'none', [at('open')]: 'write' },
  // The whole home hidden, the probe tree and node reopened.
  homeNone: { ':root': 'read', ':tmpdir': 'write', [home]: 'none', [at()]: 'read', [node]: 'read' },
  // This PR's layout: hide each entry that holds no readable path, never a parent of one.
  siblings: { ':root': 'read', ':tmpdir': 'write', [at('hidden')]: 'none', [at('open', 'deeper')]: 'none' },
};

const toml = (rules) => `{${Object.entries(rules).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`;
const parse = (r) => {
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); }
  catch { return { exit: r.status, stdout: r.stdout.slice(-500), stderr: r.stderr.slice(-1500) }; }
};
const out = {
  codex: cp.spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  baseline: parse(cp.spawnSync(process.execPath, ['-e', check], { encoding: 'utf8' })),
  variants: {},
};
for (const [name, rules] of Object.entries(variants)) {
  const r = cp.spawnSync(codex, ['sandbox', '-c', 'default_permissions="t187"', '-c', `permissions.t187.filesystem=${toml(rules)}`,
    '-c', 'permissions.t187.network={enabled=false}', '--', process.execPath, '-e', check], {
    encoding: 'utf8', cwd: base, env: { ...process.env, CODEX_HOME: codexHome }, timeout: 60000,
  });
  out.variants[name] = { rules, result: parse(r) };
}
fs.rmSync(base, { recursive: true, force: true });
const text = JSON.stringify(out, null, 2).split(base).join('<probe>').split(home).join('~');
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'codex-sandbox.json'), `${text}\n`);
console.log(text);
