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
// hides is told apart from one codex hides. The check writes its verdicts to
// a file in a writable directory of the probe tree, since a sandboxed
// command's stdout was seen to come back empty. Only readable/denied
// verdicts are recorded, never file contents.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { outsideHome } = require('../../lib/agents');

const home = fs.realpathSync(os.homedir());
const scratch = fs.realpathSync(process.argv[2]);
const codex = process.argv[3] || 'codex';
const base = path.join(scratch, 'codex-probe');
const codexHome = path.join(base, 'codex-home');
const outDir = path.join(base, 'out');
const files = ['hidden/file', 'open/file', 'open/deeper/file'];
fs.rmSync(base, { recursive: true, force: true });
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true });
  fs.writeFileSync(path.join(base, f), 'probe\n');
}
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'config.toml'), '');

const targets = {
  ...Object.fromEntries(files.map((f) => [`<probe>/${f}`, path.join(base, f)])),
  '~': home, '~/.bashrc': path.join(home, '.bashrc'), '~/.gitconfig': path.join(home, '.gitconfig'),
  '~/.config/gh': path.join(home, '.config', 'gh'), '~/.claude/.credentials.json': path.join(home, '.claude', '.credentials.json'),
  '~/.codex/auth.json': path.join(home, '.codex', 'auth.json'), '~/.aws': path.join(home, '.aws'),
  '~/.docker/config.json': path.join(home, '.docker', 'config.json'), '~/.npmrc': path.join(home, '.npmrc'),
  '~/.netrc': path.join(home, '.netrc'), '/etc/hostname': '/etc/hostname', '/bin/sh': '/bin/sh',
};
const check = (name) => `const fs=require("fs");const t=${JSON.stringify(targets)};const o={};for(const[k,p]of Object.entries(t)){try{const s=fs.statSync(p);if(s.isDirectory())o[k]="readable dir ("+fs.readdirSync(p).length+" entries)";else{fs.closeSync(fs.openSync(p,"r"));o[k]="readable"}}catch(e){o[k]="ERR "+e.code}}fs.writeFileSync(${JSON.stringify(path.join(outDir, `${name}.json`))},JSON.stringify(o))`;

const at = (...p) => path.join(base, ...p);
// What spawn opens to run codex (nodeInstalls, harnessRoots): node's
// directory and its packages, where a codex wrapper on PATH finds the codex
// package whose own binary the sandbox runs, and the codex command.
const node = path.dirname(fs.realpathSync(process.execPath));
const found = cp.spawnSync('sh', ['-c', `command -v ${codex}`], { encoding: 'utf8' }).stdout.trim();
let pkg = fs.realpathSync(found || codex);
while (!fs.existsSync(path.join(pkg, 'package.json')) && path.dirname(pkg) !== pkg) pkg = path.dirname(pkg);
if (pkg === path.dirname(pkg)) pkg = fs.realpathSync(found || codex);
const runtime = Object.fromEntries([node, path.resolve(node, '..', 'lib', 'node_modules'), pkg].map((p) => [p, 'read']));
const write = { [outDir]: 'write' };
const variants = {
  // A hidden directory with a readable path inside it: under :root, codex
  // mounts readable paths before it hides one.
  noneOverRead: { ':root': 'read', ':tmpdir': 'write', [at()]: 'none', [at('open')]: 'read', ...write },
  // The same with the inner path writable: codex mounts writable paths last.
  noneOverWrite: { ':root': 'read', ':tmpdir': 'write', [at()]: 'none', [at('open')]: 'write' },
  // The whole home hidden, the probe tree, node and codex reopened.
  homeNone: { ':root': 'read', ':tmpdir': 'write', [home]: 'none', [at('open')]: 'read', ...runtime, ...write },
  // This PR's layout: nothing read through :root; :minimal, each entry
  // outside the home and the named readable paths, so the rest of the home
  // is never mounted.
  allowlist: {
    ':minimal': 'read', ':tmpdir': 'write', ':slash_tmp': 'write',
    ...Object.fromEntries(outsideHome(home).map((p) => [p, 'read'])),
    [at('open')]: 'read', [at('open', 'deeper')]: 'none', ...runtime, ...write,
  },
};

const toml = (rules) => `{${Object.entries(rules).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`;
const verdicts = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, `${name}.json`), 'utf8')); }
  catch { return null; }
};
const tail = (s) => s.slice(-1500);
cp.spawnSync(process.execPath, ['-e', check('baseline')], { encoding: 'utf8' });
const out = {
  codex: cp.spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  baseline: verdicts('baseline'),
  variants: {},
};
for (const [name, rules] of Object.entries(variants)) {
  const profile = toml(rules);
  const r = cp.spawnSync(codex, ['sandbox', '-c', 'default_permissions="t187"', '-c', `permissions.t187.filesystem=${profile}`,
    '-c', 'permissions.t187.network={enabled=false}', '--', process.execPath, '-e', check(name)], {
    encoding: 'utf8', cwd: outDir, env: { ...process.env, CODEX_HOME: codexHome }, timeout: 60000,
  });
  out.variants[name] = {
    rules: Object.keys(rules).length > 12 ? `${Object.keys(rules).length} rules, ${Buffer.byteLength(profile)} bytes` : rules,
    exit: r.status, signal: r.signal, verdicts: verdicts(name), stdout: tail(r.stdout), stderr: tail(r.stderr),
  };
}
fs.rmSync(base, { recursive: true, force: true });
const text = JSON.stringify(out, null, 2).split(base).join('<probe>').split(home).join('~');
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'codex-sandbox.json'), `${text}\n`);
console.log(text);
