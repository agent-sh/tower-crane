'use strict';

const fs = require('node:fs');
const cp = require('node:child_process');
const original = cp.spawnSync;

// Keep GitHub offline while the real CLI reads checks and records gate evidence.
cp.spawnSync = function github(file, args, ...rest) {
  if (file !== 'gh') return original.call(this, file, args, ...rest);
  const data = JSON.parse(fs.readFileSync(process.env.TEST_GITHUB, 'utf8'));
  const filter = args[args.indexOf('--jq') + 1] || '';
  let items;
  if (args[0] === 'pr' && args[1] === 'view') {
    return {
      status: 0,
      stdout: JSON.stringify({
        headRefOid: data.sha,
        ...(data.pr === undefined ? { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } : data.pr),
      }),
      stderr: '',
    };
  }
  if (args[0] === 'api' && args.includes('--paginate')) {
    if (args[1].endsWith(`/commits/${data.sha}/check-runs?per_page=100`)) {
      items = data.runs.map((c) => ({
        name: c.name, status: c.status, conclusion: c.conclusion, app: c.app.slug,
        ...(filter.includes('output') ? { output: c.output } : {}),
        ...(filter.includes('suite:') ? { suite: c.check_suite.id } : {}),
        ...(filter.includes('started_at') ? { id: c.id, started_at: c.started_at } : {}),
      }));
    } else if (args[1].endsWith(`/commits/${data.sha}/check-suites?per_page=100`)) {
      items = data.suites.map((s) => ({
        app: s.app.slug, status: s.status, conclusion: s.conclusion, runs: s.latest_check_runs_count,
        ...(/[{,]\s*id\s*[,}]/.test(filter) ? { id: s.id } : {}),
      }));
    }
  }
  if (!items) throw new Error(`unexpected gh call: ${args.join(' ')}`);
  return { status: 0, stdout: items.map((c) => JSON.stringify(c)).join('\n'), stderr: '' };
};
