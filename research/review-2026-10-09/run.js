'use strict';

const { ROOT, scratch, fs, path, cp, assert } = require('./harness');
const groups = ['automation', 'merge', 'lifecycle', 'gates', 'processes'];
const selector = process.argv[2];
const rows = [];

(async () => {
  for (const group of groups) {
    const probes = require(`./${group}`);
    for (const p of probes) {
      if (selector && selector !== group && selector !== p.id) continue;
      const prefix = process.env.T144_PROBE_COMMAND_PREFIX || 'nice -n 19 node research/review-2026-10-09/run.js';
      const command = `${prefix} ${p.id}`;
      let observed;
      let verdict;
      try {
        const r = await p.run();
        observed = r.observed;
        verdict = r.verdict || (r.held ? 'held' : 'CONFIRMED');
      } catch (e) {
        observed = { error: e.stack };
        verdict = 'inconclusive';
        process.exitCode = 1;
      }
      const row = { id: p.id, surface: p.surface || group, command, expected: p.expected, observed, verdict };
      rows.push(row);
      console.log(`${row.id}: ${verdict} ${JSON.stringify(observed)}`);
    }
  }
  assert.ok(rows.length, 'unknown probe selector');
  const output = path.join(__dirname, 'results');
  fs.mkdirSync(output, { recursive: true });
  const revision = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(output, `${selector || 'all'}.json`), JSON.stringify({
    revision, engine_root: ROOT, node: process.version, platform: process.platform,
    scratch, probes: rows,
  }, null, 2) + '\n');
  // Helpers remove their private seed on exit. All per-probe repos are removed in finally.
})().catch((e) => { console.error(e); process.exitCode = 1; });
