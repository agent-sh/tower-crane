'use strict';
// Shared recorder for the T101 probes. Scratch repos come from test/helpers.js,
// under TOWER_CRANE_TEST_TMP; nothing here touches a real state directory.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const H = require(path.join(ROOT, 'test', 'helpers'));
const results = [];
// Results are committed, so scratch and home paths become placeholders that hold on any checkout.
const TMP_ROOT = fs.realpathSync.native(process.env.TOWER_CRANE_TEST_TMP || require('node:os').tmpdir());
const portable = (text) => text.split(path.join(TMP_ROOT, 'tower-crane-')).join('<tmp>/tower-crane-')
  .split(require('node:os').homedir()).join('~');
function rec(id, surface, command, expected, observed, verdict) {
  results.push({ id, surface, command, expected, observed: portable(String(observed).trim()).slice(0, 700), verdict });
  process.stdout.write(`${id} [${verdict}] ${String(observed).trim().split('\n')[0].slice(0, 200)}\n`);
}
function save(name) {
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(results, null, 2)}\n`);
}
const out = (r) => `exit ${r.code}; ${(r.stderr || r.stdout).trim()}`;
const noTask = (env) => { const e = { ...env }; delete e.TOWER_CRANE_TASK; return e; };
const plain = (env) => { const e = noTask(env); delete e.TOWER_CRANE_AGENT; return e; };
const lib = (name) => require(path.join(ROOT, 'lib', name));
module.exports = { ROOT, H, rec, save, out, noTask, plain, lib };
