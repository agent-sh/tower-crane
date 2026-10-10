'use strict';

// Writes the results tables of docs/human-bench.md from two bench runs, and
// copies the screenshot matrix next to it:
//
//   node test/bench/report.js --results DIR --doc docs/human-bench.md --shots docs/human-bench
//
// The tables replace what sits between the results markers in the doc.

const fs = require('node:fs');
const path = require('node:path');

const opt = {};
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, '')] = a[i + 1];
const read = (b) => JSON.parse(fs.readFileSync(path.join(opt.results, `results-${b}.json`), 'utf8'));
const before = read('before');
const after = read('after');
const SIZES = ['3840x1080', '1920x1080', '1280x800', '390x844'];
const mark = (v) => (v === true ? 'pass' : v === false ? 'fail' : v == null ? '-' : String(v));
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');

function h1(r, size) {
  const x = r.scenarios[`H1 ${size}-light`];
  if (!x || x.error) return 'error';
  return `${x.first_viewport}/${x.items} in view, title ${x.title_count}/${x.expected_count}, KLM ${x.klm_s} s, ${mark(x.pass)}`;
}

function path1(x, extra = '') {
  if (!x) return '-';
  if (x.error) return `error: ${x.error.split('\n')[0].slice(0, 80)}`;
  if (x.note && x.clicks === undefined && !('flagged' in x) && !('shown' in x) && !('sentence' in x)) return `no path: ${x.note}, fail`;
  return `${x.clicks} clicks, ${x.scrolls} scrolls, KLM ${x.klm_without_typing_s ?? x.klm_s} s without typing${extra}, ${mark(x.pass)}`;
}

const rows = [
  ['H1', 'Find what needs me, 3840x1080', h1(before, '3840x1080'), h1(after, '3840x1080')],
  ['H1', 'Find what needs me, 1920x1080', h1(before, '1920x1080'), h1(after, '1920x1080')],
  ['H1', 'Find what needs me, 1280x800', h1(before, '1280x800'), h1(after, '1280x800')],
  ['H1', 'Find what needs me, 390x844 (count and first item)', h1(before, '390x844'), h1(after, '390x844')],
  ['H2', 'Answer a decision with a note', path1(before.scenarios.H2, before.scenarios.H2 ? `, focus after: ${before.scenarios.H2.focus_after}` : ''), path1(after.scenarios.H2, after.scenarios.H2 ? `, focus after: ${after.scenarios.H2.focus_after}` : '')],
  ['H2a', 'Approve a change', `sentence ${mark(before.scenarios.H2a?.sentence)}, raw JSON ${before.scenarios.H2a?.raw_json ? 'shown' : 'no'}; apply: no path`, `sentence ${mark(after.scenarios.H2a?.sentence)}, raw JSON ${after.scenarios.H2a?.raw_json ? 'shown' : 'behind a disclosure'}; apply: no path (T89/T91)`],
  ['H3', 'Judge a review and send it back', path1(before.scenarios.H3, before.scenarios.H3 ? `, ${before.scenarios.H3.scroll_px} px scrolled` : ''), path1(after.scenarios.H3, after.scenarios.H3 ? `, ${after.scenarios.H3.scroll_px} px scrolled` : '')],
  ['H4', 'Stop a runaway', h4(before.scenarios.H4), h4(after.scenarios.H4)],
  ['H4s', 'Lost telemetry: stale', h4s(before.scenarios['H4s stale']), h4s(after.scenarios['H4s stale'])],
  ['H4s', 'Lost telemetry: unavailable', h4s(before.scenarios['H4s unavailable']), h4s(after.scenarios['H4s unavailable'])],
  ['H4p', 'Pause dispatch', 'no command on this base', 'no command on this base (T91), skipped'],
  ['H5', 'See spend, 1920x1080', h5(before.scenarios['H5 1920x1080']), h5(after.scenarios['H5 1920x1080'])],
  ['H5', 'See spend, 1280x800', h5(before.scenarios['H5 1280x800']), h5(after.scenarios['H5 1280x800'])],
  ['H6', 'Steer an agent', path1(before.scenarios.H6), path1(after.scenarios.H6)],
  ['H7', 'Return after absence', h7(before.scenarios.H7), h7(after.scenarios.H7)],
  ['H8', 'Calm run, light and dark', h8(before.scenarios), h8(after.scenarios)],
  ['H9', 'Mode parity (H2, H3, H6)', h9(before.scenarios.H9), h9(after.scenarios.H9)],
];

function h4(x) {
  if (!x) return '-';
  if (x.error) return `error: ${x.error.split('\n')[0].slice(0, 80)}`;
  return `spend rose before exit: ${x.rose_before_exit ? 'yes' : 'no'}; flagged: ${x.flagged ? `yes, ${x.flag_latency_ms} ms after the rule's threshold` : 'no'}; stop: ${x.path ? `${x.path.clicks} clicks, KLM ${x.path.klm_s} s, stopped ${x.stopped ? 'with no retry' : 'no'}; recorded ${x.recorded_tokens} of the stub's ${x.stub_tokens}` : 'no path'}, ${mark(x.pass)}`;
}
function h4s(x) {
  if (!x) return '-';
  if (x.error) return `error: ${x.error.split('\n')[0].slice(0, 80)}`;
  return `state in words: ${x.shown ? 'yes' : 'no'}; drawn as zero: ${x.drawn_as_zero ? 'yes' : 'no'}; Now item: ${x.flagged ? 'yes' : 'no'}; sentence says not counted: ${x.sentence_not_counted ? 'yes' : 'no'}, ${mark(x.pass)}`;
}
function h5(x) {
  if (!x) return '-';
  if (x.error) return `error: ${x.error.split('\n')[0].slice(0, 80)}`;
  return `${Object.entries(x.parts).map(([k, v]) => `${k} ${v.shown ? 'shown' : 'not shown'}`).join(', ')}; freshness ${x.freshness_shown ? 'shown' : 'not shown'}, ${mark(x.pass)}`;
}
function h7(x) {
  if (!x) return '-';
  return `named ${x.named.length} of ${x.expected.length}; grouped by meaning: ${x.grouped_by_meaning ? 'yes' : 'no'}; heading contradicts: ${x.heading_contradiction ? 'yes' : 'no'}, ${mark(x.pass)}`;
}
function h8(sc) {
  const l = sc['H8 light']; const d = sc['H8 dark'];
  if (!l || !d) return '-';
  return `alarm or attention hue: ${l.hues}/${d.hues}; motion after load: ${l.motion_after_load}/${d.motion_after_load}${l.motion_samples.length ? ` (${l.motion_samples[0]})` : ''}; says nothing needs you: ${l.says_nothing_needs_you ? 'yes' : 'no'}, ${mark(l.pass && d.pass)}`;
}
function h9(x) {
  if (!x) return '-';
  return `compared ${x.compared.join(', ') || 'nothing'}; mismatches ${x.mismatches.length}${x.compared.length < 3 ? '; H6 has no board path' : ''}, ${mark(x.pass)}`;
}

function checkRow(r, key) {
  const c = r.checks[`front ${key}`];
  if (!c || c.error) return null;
  const rd = c.readability;
  return [
    `${c.contrast.failures} of ${c.contrast.checked}`,
    `${c.color_alone.unlabeled} of ${c.color_alone.checked}`,
    `${c.targets.failures} of ${c.targets.checked}, ${c.targets.short_buttons} short buttons`,
    `${c.names.unnamed} unnamed, ${c.names.h1} h1`,
    `${rd.sizes} sizes (${rd.size_list.join(', ')}), min ${rd.min_px}, ${rd.under_12_share}% under 12 px, ${rd.clipped} clipped, ${rd.long_lines} long lines${rd.horizontal_scroll ? ', page scrolls sideways' : ''}`,
    c.density ? `${c.density.share}%` : '-',
  ];
}

function roomRow(r) {
  const out = {};
  for (const [k, v] of Object.entries(r.rooms)) {
    const room = k.split(' ')[0];
    out[room] ||= { n: 0, pass: 0, fails: new Set() };
    for (const [name, res] of Object.entries(v)) {
      out[room].n++;
      if (res && res.pass) out[room].pass++;
      else out[room].fails.add(name.replace('_', ' '));
    }
  }
  return out;
}

let md = '| # | Scenario | Before | After |\n|---|---|---|---|\n';
md += rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n');
md += '\n\nChecks on the front room with the busy run, per size and theme (failures of checked):\n\n| Build | Size, theme | Contrast | Color alone | Targets | Names | Readability | Density |\n|---|---|---|---|---|---|---|---|\n';
for (const [name, r] of [['before', before], ['after', after]]) {
  for (const size of SIZES) for (const theme of ['light', 'dark']) {
    const row = checkRow(r, `${size}-${theme}`);
    if (row) md += `| ${name} | ${size} ${theme} | ${row.map(cell).join(' | ')} |\n`;
  }
}
md += '\nThe other rooms, at 1920x1080 in both themes, 1280x800 dark and 390x844 light (checks passed of run):\n\n| Room | Before | After |\n|---|---|---|\n';
const rb = roomRow(before); const ra = roomRow(after);
const roomName = { board: 'Board (before) / Now', now: 'Now', review: 'Review', plan: 'Plan', spend: 'Spend', history: 'History', sheet: 'Task sheet', settings: 'Settings' };
for (const room of ['plan', 'spend', 'history', 'sheet', 'settings', 'review']) {
  const f = (x) => (x ? `${x.pass} of ${x.n}${x.fails.size ? ` (fails: ${[...x.fails].join(', ')})` : ''}` : 'no such room');
  md += `| ${roomName[room]} | ${f(rb[room])} | ${f(ra[room])} |\n`;
}
const k = (r) => r.checks['keyboard 1920x1080'];
const o = (r, s) => r.checks[`one room ${s}`];
const mo = (r) => r.checks['motion reduced 1920x1080'];
md += `\n| Check | Before | After |\n|---|---|---|\n`;
md += `| Keyboard: H2 and H6 actions reached by Tab with a ring; Escape closes a sheet and returns focus | ${k(before) ? `${k(before).reached} of ${k(before).of}${k(before).missing.length ? ` (missing: ${k(before).missing.map((x) => x.replace(/"/g, "'")).join(', ')})` : ''}; sheet ${k(before).escape_closed && k(before).focus_returned ? 'ok' : 'fail'}, ${mark(k(before).pass)}` : '-'} | ${k(after) ? `${k(after).reached} of ${k(after).of} in ${k(after).tabs} tabs; sheet ${k(after).escape_closed && k(after).focus_returned ? 'ok' : 'fail'}, ${mark(k(after).pass)}` : '-'} |\n`;
for (const s of ['1920x1080', '390x844']) md += `| One room at a time, ${s}: nav, direct link, sheet inside, cleared fragment, live update | ${o(before, s) ? `${o(before, s).checks - o(before, s).failures.length} of ${o(before, s).checks}, ${mark(o(before, s).pass)}` : '-'} | ${o(after, s) ? `${o(after, s).checks - o(after, s).failures.length} of ${o(after, s).checks}, ${mark(o(after, s).pass)}` : '-'} |\n`;
md += `| Reduced motion: running animations after load | ${mo(before) ? `${mo(before).running}, ${mark(mo(before).pass)}` : '-'} | ${mo(after) ? `${mo(after).running}, ${mark(mo(after).pass)}` : '-'} |\n`;
md += `\nRuns: before ${before.started_at.slice(0, 16).replace('T', ' ')}Z on \`${path.basename(before.tree)}\`, after ${after.started_at.slice(0, 16).replace('T', ' ')}Z. Errors recorded: before ${before.errors.length}, after ${after.errors.length}.\n`;

const doc = fs.readFileSync(opt.doc, 'utf8');
const start = doc.indexOf('<!-- results -->');
const end = doc.indexOf('<!-- /results -->');
if (start < 0 || end < 0) throw new Error('the doc needs <!-- results --> and <!-- /results --> markers');
fs.writeFileSync(opt.doc, `${doc.slice(0, start)}<!-- results -->\n\n${md}\n${doc.slice(end)}`);

// The screenshot matrix: the front room at every size and theme, every other
// room at three, and the end state of each scenario on the after build.
if (opt.shots) {
  const keep = (f) => /^front-/.test(f) || /^(review|plan|spend|history)-(1920x1080-(light|dark)|390x844-light)\.webp$/.test(f) || /^(sheet|settings)-/.test(f) || /^H(2|3|4|5|6|7|8)/.test(f) && !/^H5-(3840|1280|390)/.test(f);
  for (const b of ['before', 'after']) {
    const from = path.join(opt.results, b);
    const to = path.join(opt.shots, b);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from).filter(keep)) fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
}
process.stdout.write(md);
