'use strict';
// Reduces raw run files to one value per metric per run, then reports the
// median of the runs with min..max. Usage: node summarize.js RAW_DIR OUT_DIR
const fs = require('node:fs');
const path = require('node:path');

const [rawDir, outDir] = process.argv.slice(2);
const OPTIONS = ['A-cli', 'A-proto', 'B', 'C-files', 'C-sqlite', 'D'];
const DATASETS = ['live', 's50', 's200'];

function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)];
}
const median = (xs) => pct(xs, 50);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function perRun(r) {
  const m = {};
  if (r.hooks) {
    const all = [...r.hooks.empty, ...r.hooks.delivered];
    m.hook_n = all.length;
    m.hook_p50 = pct(all, 50);
    m.hook_p95 = pct(all, 95);
    m.hook_delivering_p50 = pct(r.hooks.delivered, 50);
    m.hook_send_p50 = pct(r.hooks.sends, 50);
    m.hook_send_p95 = pct(r.hooks.sends, 95);
    m.hook_per_s = all.length / r.hooks.wall_s;
    m.hook_cores = r.hooks.cores;
    m.hook_cpu_ms_per_op = 1000 * r.hooks.cpu_s / (all.length + r.hooks.sends.length);
    m.hook_errors = r.hooks.errors.length;
    m.hook_busy_skips = r.hooks.busy;
  }
  if (r.transitions) {
    const t = r.transitions;
    const muts = [...t.claim, ...t.submit, ...t.evidence, ...t.rework];
    m.mut_n = muts.length;
    m.mut_p50 = pct(muts, 50);
    m.mut_p95 = pct(muts, 95);
    m.mut_per_s = muts.length / t.wall_s;
    for (const k of ['claim', 'submit', 'evidence', 'rework']) m[`${k}_p50`] = pct(t[k], 50);
    m.mut_paced_hook_p95 = pct(t.hooks, 95);
    m.mut_cores = t.cores;
    m.mut_cpu_ms_per_op = 1000 * t.cpu_s / (muts.length + t.hooks.length);
    m.mut_conflicts = t.conflicts;
    m.mut_errors = t.errors.length;
    m.mut_cycles = t.cycles;
  }
  if (r.replay) {
    m.replay0_ms = median(r.replay.from0);
    m.replay_recent_ms = median(r.replay.recent);
    m.replay0_events = r.replay.count0;
  }
  if (r.crash) {
    const c = r.crash.cycles;
    m.crash_cycles = c.length;
    m.crash_acked = c.length ? c.at(-1).acked_notes + c.at(-1).acked_msgs : 0;
    m.crash_lost_acked = Math.max(0, ...c.map((x) => x.lost_acked));
    m.crash_state_without_event = Math.max(0, ...c.map((x) => x.state_without_event));
    m.crash_event_without_state = Math.max(0, ...c.map((x) => x.event_without_state));
    m.crash_inbox_mismatch = Math.max(0, ...c.map((x) => x.inbox_mismatch || 0));
    m.crash_bad_lines = Math.max(0, ...c.map((x) => x.bad_lines || 0));
    m.crash_torn_tails = c.filter((x) => x.torn_tail).length;
    m.crash_restart_ms = median(c.map((x) => x.restart_ms));
    m.crash_first_write_ms = median(c.map((x) => x.first_write_ms));
    m.crash_integrity_fail = c.filter((x) => x.integrity && x.integrity !== 'ok').length;
    m.crash_validate_fail = c.filter((x) => x.validate && !x.validate.ok).length;
  }
  if (r.startup_ms !== undefined) m.startup_ms = r.startup_ms;
  m.load = r.host.load_start[0];
  m.error = r.error ? 1 : 0;
  return m;
}

const runs = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')));
const table = {};
for (const r of runs) {
  if (r.quick) continue;
  const key = `${r.option}|${r.dataset}`;
  (table[key] ||= []).push(perRun(r));
}

function agg(list, k) {
  const xs = list.map((m) => m[k]).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!xs.length) return null;
  return { median: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

const summary = {};
for (const [key, list] of Object.entries(table)) {
  const keys = new Set(list.flatMap((m) => Object.keys(m)));
  summary[key] = Object.fromEntries([...keys].map((k) => [k, agg(list, k)]));
}

const fmt = (a, digits = 0) => {
  if (!a) return 'n/a';
  const f = (x) => (Math.abs(x) >= 100 || digits === 0 ? Math.round(x).toString() : x.toFixed(digits));
  return a.min === a.max ? f(a.median) : `${f(a.median)} (${f(a.min)}..${f(a.max)})`;
};

const COLS = {
  hooks: [['hook_p50', 'hook p50 ms'], ['hook_p95', 'hook p95 ms'], ['hook_per_s', 'hooks/s', 1], ['hook_send_p95', 'send p95 ms'], ['hook_cores', 'CPU cores', 1], ['hook_cpu_ms_per_op', 'CPU ms/op', 1]],
  transitions: [['mut_p50', 'mutation p50 ms'], ['mut_p95', 'mutation p95 ms'], ['mut_per_s', 'mutations/s', 1], ['mut_paced_hook_p95', 'hook p95 ms (paced)'], ['mut_cores', 'CPU cores', 1], ['mut_cpu_ms_per_op', 'CPU ms/op', 1], ['mut_errors', 'errors']],
  replay: [['replay0_ms', 'from 0 ms'], ['replay_recent_ms', 'last 1000 ms'], ['replay0_events', 'events read']],
  crash: [['crash_acked', 'acked writes'], ['crash_lost_acked', 'acked lost'], ['crash_state_without_event', 'state w/o event'], ['crash_inbox_mismatch', 'index mismatch'], ['crash_bad_lines', 'bad records'], ['crash_restart_ms', 'restart ms'], ['crash_first_write_ms', 'first write ms']],
};

let md = '# Results\n\nMedian of 3 runs, (min..max) across runs. Each run is one value per metric (for example the p95 of that run).\n';
for (const [section, cols] of Object.entries(COLS)) {
  md += `\n## ${section}\n`;
  for (const ds of DATASETS) {
    md += `\n### ${ds}\n\n| option | ${cols.map((c) => c[1]).join(' | ')} |\n|---|${cols.map(() => '---').join('|')}|\n`;
    for (const o of OPTIONS) {
      const s = summary[`${o}|${ds}`];
      if (!s) continue;
      md += `| ${o} | ${cols.map(([k, , d]) => fmt(s[k], d)).join(' | ')} |\n`;
    }
  }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'summary.md'), md);
process.stdout.write(md);
