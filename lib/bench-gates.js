'use strict';

const fs = require('node:fs');
const S = require('./state');
const { shaMatch, refuse } = require('./util');

const GATES = ['tests', 'clean', 'sources', 'ci', 'merge'];

// Agents can record tests or clean evidence by hand; only runs of the gate
// itself are software results.
function gateRun(e) {
  const d = e.detail;
  if (!e.task || !d || !GATES.includes(d.type) || typeof d.ok !== 'boolean' || !d.sha) return false;
  return e.cmd === `check ${d.type}` || (d.type === 'merge' && e.cmd === 'merge');
}

const reviewOf = (e) => e.detail && e.detail.type === 'review' && typeof e.detail.ok === 'boolean' && e.detail.sha;

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

// Hosted summaries name the failed checks; local execution receipts carry the
// exit status. Observation failures say nothing about the code.
function ciReason(summary, detail = {}) {
  const receipt = detail.receipt;
  if (receipt) {
    // The local runner records execution separately from its human summary.
    const failed = detail.confirmed_failure === true && Number.isInteger(receipt.exit) && receipt.exit > 0
      && ![126, 127, 9009].includes(receipt.exit) && !receipt.signal
      && shaMatch(receipt.head_sha, detail.sha) && Array.isArray(receipt.command) && receipt.command.length > 0;
    return failed
      ? { reason: 'checks', checks: [`local CI (${receipt.variant || 'default'})`] }
      : { reason: 'local-observation', checks: [] };
  }
  const text = String(summary || '');
  const checks = [];
  for (const m of text.matchAll(/^(?:failing|required check runs not successful): (.+)$/gm)) {
    for (const c of m[1].matchAll(/([^,()]+(?:\([^()]*\))?)\s*\((\w+)\)/g)) {
      const name = c[1].trim().replace(/, shard \d+\/\d+\)$/, ')');
      if (FAILED.has(c[2]) && !checks.includes(name)) checks.push(name);
    }
  }
  if (checks.length) return { reason: 'checks', checks };
  if (!text) return { reason: 'unknown', checks };
  if (/mergeability is unknown|is CONFLICTING/.test(text)) return { reason: 'mergeability', checks };
  if (/^PR head moved/m.test(text)) return { reason: 'head-moved', checks };
  if (/^gh api .* failed/m.test(text)) return { reason: 'query', checks };
  if (/not completed:|\((queued|in_progress|cancelled)[,)]/.test(text)) return { reason: 'pending', checks };
  return { reason: 'other', checks };
}

// A failing gate is a positive: it says the sha is not ready. A fail is false
// when the same gate later passes the same sha, so nothing in the code changed;
// it is true when the task moved to another sha without that. A pass is false
// when a later review blocker or failed CI check run hits the same sha and
// stands, and true when a later passing review or merge confirms it. Anything
// else stays open. A CI fail without a failed hosted check or confirmed local
// execution is no verdict on the code, so it is noncode and scored as neither.
function label(run, later, why) {
  const d = run.detail;
  const same = later.filter((e) => shaMatch(e.detail?.sha, d.sha));
  if (!d.ok) {
    if (d.type === 'ci' && why.get(run)?.reason !== 'checks') return { label: 'noncode', by: null, source: null };
    const overturn = same.find((e) => gateRun(e) && e.detail.type === d.type && e.detail.ok);
    if (overturn) return { label: 'fp', by: overturn.id || overturn.at, source: d.type };
    const moved = later.find((e) => e.cmd === 'submit' && e.detail?.sha && !shaMatch(e.detail.sha, d.sha));
    if (moved) return { label: 'tp', by: moved.id || moved.at, source: 'submit' };
    return { label: 'open', by: null, source: null };
  }
  const kind = (e) => (reviewOf(e) ? 'review' : gateRun(e) && e.detail.type === 'ci' ? 'ci' : null);
  // Only failed check runs speak about the code, and a failure the same kind
  // of check later reversed at this sha (a rerun, a second review) stands for nothing.
  const stands = (e, i) => kind(e) && !e.detail.ok && (kind(e) === 'review' || why.get(e)?.reason === 'checks')
    && !same.slice(i + 1).some((x) => kind(x) === kind(e) && x.detail.ok);
  const contras = same.filter(stands);
  // Each kind that contradicts the pass is kept, so recall against CI does
  // not depend on whether a review blocker happened to come first.
  if (contras.length) return { label: 'fn', by: contras[0].id || contras[0].at, source: kind(contras[0]), contradicted_by: [...new Set(contras.map(kind))] };
  const confirm = same.find((e) => (reviewOf(e) && e.detail.ok) || (gateRun(e) && e.detail.type === 'merge' && e.detail.ok));
  if (confirm) return { label: 'tn', by: confirm.id || confirm.at, source: reviewOf(confirm) ? 'review' : 'merge' };
  return { label: 'open', by: null, source: null };
}

// Events carry the verdict; the task's evidence entry carries the summary that
// says what failed. The gate stamps the entry and the event separately, so a
// fail event takes the latest unused failed ci entry of its task and sha
// stamped no later than the event itself.
function summaries(tasks) {
  const map = new Map();
  for (const task of tasks || []) {
    for (const e of task.evidence || []) {
      if (e.type !== 'ci' || e.ok !== false || !e.sha) continue;
      const key = `${task.id}|${String(e.sha).toLowerCase()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
  }
  const used = new Set();
  return (event) => {
    const list = map.get(`${event.task}|${String(event.detail.sha).toLowerCase()}`) || [];
    const at = Date.parse(event.at);
    let pick = -1;
    list.forEach((e, i) => { if (!used.has(e) && Date.parse(e.at) <= at && (pick < 0 || Date.parse(e.at) >= Date.parse(list[pick].at))) pick = i; });
    if (pick < 0) return null;
    used.add(list[pick]);
    return list[pick].summary;
  };
}

function labelEvents(events, tasks = []) {
  const summaryOf = summaries(tasks);
  const why = new Map();
  const byTask = new Map();
  for (const e of events) {
    if (!e || !e.task) continue;
    if (!byTask.has(e.task)) byTask.set(e.task, []);
    byTask.get(e.task).push(e);
    if (gateRun(e) && e.detail.type === 'ci' && !e.detail.ok) why.set(e, ciReason(summaryOf(e), e.detail));
  }
  const rows = [];
  for (const [task, list] of byTask) {
    list.forEach((e, i) => {
      if (!gateRun(e)) return;
      const row = { task, gate: e.detail.type, sha: e.detail.sha, at: e.at, ok: e.detail.ok, ...label(e, list.slice(i + 1), why) };
      if (why.has(e)) Object.assign(row, why.get(e));
      rows.push(row);
    });
  }
  return rows;
}

// Each check keeps its earliest failure at a task's sha, even if it first
// appears on a later poll. A failure is overturned when CI later passes that sha.
function ciChecks(rows, commitKey = commitKeys(rows)) {
  const checks = new Map();
  const seen = new Set();
  for (const r of rows) {
    if (r.gate !== 'ci' || r.ok || r.reason !== 'checks') continue;
    for (const name of r.checks) {
      const key = JSON.stringify([r.task, commitKey(r), name]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!checks.has(name)) checks.set(name, { check: name, fails: 0, tp: 0, fp: 0, open: 0 });
      checks.get(name)[r.label]++;
      checks.get(name).fails++;
    }
  }
  return [...checks.values()].map((c) => ({ ...c, precision: ratio(c.tp, c.tp + c.fp) }))
    .sort((a, b) => b.fails - a.fails || a.check.localeCompare(b.check));
}

const ratio = (a, b) => (b ? a / b : null);

// Resolve aliases from the recorded history, without needing the Git objects.
// A short prefix shared by distinct longer hashes cannot identify either one.
function commitKeys(rows) {
  const tasks = new Map();
  for (const r of rows) {
    if (!tasks.has(r.task)) tasks.set(r.task, new Set());
    tasks.get(r.task).add(String(r.sha).toLowerCase());
  }
  const keys = new Map();
  for (const [task, values] of tasks) {
    const shas = [...values].sort((a, b) => b.length - a.length);
    const aliases = new Map();
    for (const sha of shas) {
      const matches = shas.filter((other) => other.length >= sha.length && shaMatch(sha, other));
      const longest = matches[0];
      aliases.set(sha, longest && matches.every((other) => shaMatch(other, longest)) ? longest : sha);
    }
    keys.set(task, aliases);
  }
  return (r) => keys.get(r.task).get(String(r.sha).toLowerCase());
}

// Gates rerun on the same sha add runs, not information: one outcome of one
// gate at one sha counts once, labeled by its earliest run, which has the most
// later evidence. A CI fail that names no check run is not the same outcome as
// one that does, so a pending run cannot hide a later real failure.
function distinct(rows, commitKey = commitKeys(rows)) {
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.task}|${r.gate}|${commitKey(r)}|${r.ok}|${r.label === 'noncode' ? 'noncode' : 'code'}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

function score(all, gate, commitKey = commitKeys(all)) {
  const rows = distinct(all, commitKey);
  const c = { tp: 0, fp: 0, fn: 0, tn: 0, open: 0, noncode: 0 };
  const fnBy = { review: 0, ci: 0 };
  for (const r of rows) {
    c[r.label]++;
    if (r.label === 'fn') for (const k of r.contradicted_by) fnBy[k]++;
  }
  return {
    runs: all.length, results: rows.length, ...c, fn_by: fnBy,
    precision: ratio(c.tp, c.tp + c.fp),
    recall: ratio(c.tp, c.tp + c.fn),
    // CI is the stricter oracle for code faults; review blockers include
    // design and scope findings no software gate is meant to catch. The ci
    // and merge gates read CI themselves, so their recall against it says nothing.
    recall_ci: gate === 'ci' || gate === 'merge' ? null : ratio(c.tp, c.tp + fnBy.ci),
  };
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw refuse(`${file}:${i + 1} is not JSON`); }
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw refuse(`cannot read ${file}: ${e.message}`); }
}

function tally(map, key) {
  if (!map.has(key)) map.set(key, { items: 0, tp: 0, fp: 0, harmless: 0, caught: 0 });
  return map.get(key);
}

// Verdict-labeled detector hits: each hit was read and judged by hand.
function deslopHits(file) {
  const checks = new Map();
  for (const h of readJsonl(file)) {
    const t = tally(checks, h.detector || h.check || 'unknown');
    t.items++;
    if (h.verdict === 'true-slop') t.tp++;
    else if (h.verdict === 'harmless') t.harmless++;
    else t.fp++;
  }
  return [...checks].map(([check, t]) => ({
    check, items: t.items, tp: t.tp, harmless: t.harmless, fp: t.fp,
    precision: ratio(t.tp, t.items), precision_lenient: ratio(t.tp + t.harmless, t.items),
  })).sort((a, b) => b.items - a.items || a.check.localeCompare(b.check));
}

// Same parse as the eval's matcher: "path:line" or "path" at the start of the example.
function locate(example) {
  const m = /^([^\s:;,]+?)(?::(\d+))?(?:[-,]\d+)?(?:\s|$|;|,)/.exec(`${String(example || '').trim()} `);
  return m ? { path: m[1], line: m[2] ? Number(m[2]) : null } : { path: null, line: null };
}

const near = (item, at) => at.path && (item.file === at.path || String(item.file).endsWith(`/${at.path}`))
  && (at.line === null || Math.abs((item.line || 0) - at.line) <= 5);

// Reviewer-found defects against detector runs at the reviewed commit. An item
// near a labeled defect is a true positive; others are unconfirmed, so the
// precision is a lower bound: reviewers do not report every real problem.
function deslopEval(findingsFile, runsFile) {
  const findings = readJsonl(findingsFile);
  const caughtBefore = findings.filter((f) => f.deslop_caught === true).length;
  const result = { findings: findings.length, previous_caught: caughtBefore, previous_recall: ratio(caughtBefore, findings.length) };
  if (!runsFile) return result;
  const runs = readJson(runsFile);
  const keyOf = (f) => `${String(f.source || '').split(/\s/)[0]}@${f.reviewed_commit}`;
  const byKey = new Map();
  for (const f of findings) {
    if (!byKey.has(keyOf(f))) byKey.set(keyOf(f), []);
    byKey.get(keyOf(f)).push({ ...f, at: locate(f.example) });
  }
  const checks = new Map();
  let evaluated = 0;
  let caught = 0;
  for (const [key, list] of byKey) {
    const run = runs[key];
    if (!run || !Array.isArray(run.items)) continue;
    evaluated += list.length;
    for (const item of run.items) {
      const t = tally(checks, item.check);
      t.items++;
      if (list.some((f) => near(item, f.at))) t.tp++;
      else t.fp++;
    }
    for (const f of list) {
      const hits = run.items.filter((item) => near(item, f.at));
      if (hits.length) caught++;
      for (const check of new Set(hits.map((h) => h.check))) tally(checks, check).caught++;
    }
  }
  result.evaluated = evaluated;
  result.caught = caught;
  result.recall = ratio(caught, evaluated);
  result.checks = [...checks].map(([check, t]) => ({
    check, items: t.items, tp: t.tp, unconfirmed: t.fp,
    precision_min: ratio(t.tp, t.items), caught: t.caught, recall: ratio(t.caught, evaluated),
  })).sort((a, b) => b.items - a.items || a.check.localeCompare(b.check));
  return result;
}

// A detector report after agent confirmation: kept findings against dismissed ones.
function deslopReport(file) {
  const doc = readJson(file);
  const checks = new Map();
  for (const f of doc.findings || []) { const t = tally(checks, f.check); t.items++; t.tp++; }
  for (const f of doc.dismissed || []) { const t = tally(checks, f.check); t.items++; t.fp++; }
  return [...checks].map(([check, t]) => ({ check, items: t.items, confirmed: t.tp, dismissed: t.fp, precision: ratio(t.tp, t.items) }))
    .sort((a, b) => b.items - a.items || a.check.localeCompare(b.check));
}

const pct = (x) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);

function benchGates(ctx) {
  const st = S.loadState(ctx.stateDir);
  const f = ctx.flags;
  if (f['deslop-runs'] && !f['deslop-findings']) throw refuse('--deslop-runs needs --deslop-findings to label its items');
  const rows = labelEvents(st.events, st.tasks.tasks);
  const commitKey = commitKeys(rows);
  const gates = GATES.map((gate) => ({ gate, ...score(rows.filter((r) => r.gate === gate), gate, commitKey) }));
  const reasons = {};
  for (const r of distinct(rows, commitKey)) if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  const checks = ciChecks(rows, commitKey);
  const data = { gates, ci_fail_reasons: reasons, ci_checks: checks, labels: rows };
  const lines = ['gate     runs results   tp   fp   fn   tn open noncode  precision  recall  recall(ci)'];
  for (const g of gates) {
    lines.push(`${g.gate.padEnd(7)} ${String(g.runs).padStart(5)} ${String(g.results).padStart(7)} ${[g.tp, g.fp, g.fn, g.tn, g.open].map((n) => String(n).padStart(4)).join(' ')} ${String(g.noncode).padStart(7)}  ${pct(g.precision).padStart(9)}  ${pct(g.recall).padStart(6)}  ${pct(g.recall_ci).padStart(10)}`);
  }
  lines.push('noncode: CI fails without a failed hosted check or confirmed local execution; recall(ci) is - for ci and merge, which read CI themselves');
  lines.push('', `ci failures by reason: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  if (checks.length) {
    lines.push('', 'ci check runs that failed', 'check                                    fails   tp   fp open  precision');
    for (const c of checks) lines.push(`${c.check.padEnd(40)} ${String(c.fails).padStart(5)} ${[c.tp, c.fp, c.open].map((n) => String(n).padStart(4)).join(' ')}  ${pct(c.precision).padStart(9)}`);
  }
  if (f['deslop-hits'] || f['deslop-findings'] || f['deslop-report']) data.deslop = {};
  if (f['deslop-hits']) {
    data.deslop.hits = deslopHits(f['deslop-hits']);
    lines.push('', 'deslop hits by check (hand verdicts)', 'check                               items   tp harmless    fp  precision');
    for (const c of data.deslop.hits) lines.push(`${c.check.padEnd(35)} ${String(c.items).padStart(5)} ${String(c.tp).padStart(4)} ${String(c.harmless).padStart(8)} ${String(c.fp).padStart(5)}  ${pct(c.precision).padStart(9)}`);
  }
  if (f['deslop-findings']) {
    const e = data.deslop.eval = deslopEval(f['deslop-findings'], f['deslop-runs']);
    lines.push('', `deslop eval: ${e.findings} reviewer-found defects; earlier detector caught ${e.previous_caught} (${pct(e.previous_recall)})`);
    if (e.checks) {
      lines.push(`current run: ${e.caught} of ${e.evaluated} caught (${pct(e.recall)})`, 'check                 items   tp unconfirmed  precision>=  caught  recall');
      for (const c of e.checks) lines.push(`${c.check.padEnd(20)} ${String(c.items).padStart(6)} ${String(c.tp).padStart(4)} ${String(c.unconfirmed).padStart(11)}  ${pct(c.precision_min).padStart(11)}  ${String(c.caught).padStart(6)}  ${pct(c.recall).padStart(6)}`);
    }
  }
  if (f['deslop-report']) {
    data.deslop.report = deslopReport(f['deslop-report']);
    lines.push('', 'deslop report by check (agent confirmation)', 'check                 items confirmed dismissed  precision');
    for (const c of data.deslop.report) lines.push(`${c.check.padEnd(20)} ${String(c.items).padStart(6)} ${String(c.confirmed).padStart(9)} ${String(c.dismissed).padStart(9)}  ${pct(c.precision).padStart(9)}`);
  }
  return { data, text: lines.join('\n') };
}

module.exports = { benchGates, labelEvents, score, ciReason, ciChecks, deslopHits, deslopEval, deslopReport };
