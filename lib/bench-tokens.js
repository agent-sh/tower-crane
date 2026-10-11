'use strict';

const fs = require('node:fs');
const S = require('./state');
const L = require('./ladder');
const { cost } = require('./reviewer');
const { refuse } = require('./util');

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const known = (n) => Number.isSafeInteger(n) && n >= 0;

// The order of worker rungs a task ran on, repeats collapsed: "easy>medium" is
// a task that climbed once. Native work without spawn receipts falls back to
// the rungs its spend entries name.
function pathOf(task, events) {
  let rungs = events.filter((e) => e.task === task.id && e.cmd === 'spawn' && e.detail?.role === 'worker' && e.detail.rung)
    .map((e) => e.detail.rung);
  if (!rungs.length) rungs = (task.spend.entries || []).filter((x) => x.rung && x.rung !== 'review').map((x) => x.rung);
  const path = rungs.filter((r, i) => r !== rungs[i - 1]);
  return path.length ? path.join('>') : 'unknown';
}

function priced(entry, prices) {
  if (entry.cost_usd != null) return entry.cost_usd;
  // A profile-only dispatch names its model through the profile alias.
  const model = entry.model || entry.profile;
  return model ? cost(entry, prices.get(L.modelIdentity(model))) : null;
}

// One accepted task's spend, split by token category. Input is inclusive of
// cache reads in every harness parser, so fresh input is input minus cached.
function taskSpend(task, prices) {
  const out = { tokens: 0, fresh: 0, cached: 0, output: 0, usd: 0, unknown: 0, unpriced: 0, by_rung: {} };
  for (const entry of task.spend.entries || []) {
    // Live counters are partial until exit collection removes the marker.
    if (entry.live || (!known(entry.tokens) && (entry.source !== 'manual' || entry.input !== null))) out.unknown++;
    if (!known(entry.tokens)) continue;
    const rung = entry.rung || 'unknown';
    const r = out.by_rung[rung] ||= { tokens: 0, usd: 0, unpriced: 0 };
    out.tokens += entry.tokens;
    r.tokens += entry.tokens;
    if (out.fresh !== null && known(entry.input) && known(entry.cached)) {
      out.fresh += entry.input - entry.cached;
    } else out.fresh = null;
    // A missing segment makes the task's category total unknown.
    for (const key of ['cached', 'output']) {
      if (out[key] !== null && known(entry[key])) out[key] += entry[key];
      else out[key] = null;
    }
    const usd = priced(entry, prices);
    if (usd === null) { out.unpriced++; r.unpriced++; } else { out.usd += usd; r.usd += usd; }
  }
  return out;
}

// A session absent from spend has no placeholder to mark its usage unknown.
// Match dispatches and fresh execution segments using the collector's source IDs.
function missingSpawns(task, events) {
  const entries = task.spend.entries || [];
  const dispatches = events.filter((e) => e.task === task.id && e.cmd === 'spawn');
  const current = new Map();
  const missing = new Set();
  for (const event of events) {
    if (event.task !== task.id || !event.detail?.agent) continue;
    const d = event.detail;
    if (event.cmd === 'spawn') current.set(d.agent, event);
    else if (event.cmd !== 'spawn fallback' && !(event.cmd === 'spawn retry' && d.fresh)) continue;
    const dispatch = current.get(d.agent);
    if (!dispatch) continue;
    const source = `spawn:${d.agent}${dispatch.detail.resumed ? `:attempt:${dispatch.detail.attempt}` : ''}${d.route_index ? `:route:${d.route_index}` : ''}${event.cmd === 'spawn retry' ? `:retry:${d.retry}` : ''}`;
    const next = dispatches.find((e) => e.detail?.agent === d.agent && Date.parse(e.at) > Date.parse(dispatch.at));
    const recorded = entries.some((entry) => entry.source === source
      || (event.cmd === 'spawn' && entry.source === 'manual' && entry.agent === d.agent && known(entry.tokens)
        && Date.parse(entry.at) >= Date.parse(dispatch.at) && (!next || Date.parse(entry.at) < Date.parse(next.at))));
    if (!recorded) missing.add(source);
  }
  return [...missing];
}

function group(items) {
  const tokens = items.map((x) => x.tokens);
  const usd = items.filter((x) => !x.unpriced).map((x) => x.usd);
  return {
    tasks: items.length,
    median_tokens: median(tokens),
    mean_tokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null,
    median_usd: median(usd),
    priced_tasks: usd.length,
    ...(items[0] && 'fresh' in items[0] ? {
      median_fresh: median(items.map((x) => x.fresh).filter(known)), median_cached: median(items.map((x) => x.cached).filter(known)), median_output: median(items.map((x) => x.output).filter(known)),
    } : {}),
  };
}

function loadPrices(st, file) {
  let table = st.project.review?.prices || {};
  if (file) {
    try { table = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw refuse(`cannot read prices ${file}: ${e.message}`); }
    const errs = require('./reviewer').errors({ prices: table });
    if (errs.length) throw refuse(errs.join('; '));
  }
  return new Map(Object.entries(table).map(([model, rates]) => [L.modelIdentity(model), rates]));
}

const fmt = (n) => (n === null ? '-' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const usdText = (n) => (n === null ? '-' : `$${n.toFixed(2)}`);

function benchTokens(ctx) {
  const st = S.loadState(ctx.stateDir);
  const prices = loadPrices(st, ctx.flags.prices);
  const accepted = st.tasks.tasks.filter((t) => t.status === 'accepted');
  const rows = accepted.map((task) => {
    const spend = taskSpend(task, prices);
    const missing = missingSpawns(task, st.events);
    return { id: task.id, tier: task.tier, path: pathOf(task, st.events), ...spend,
      unknown: spend.unknown + missing.length, missing_spawns: missing };
  });
  // Tasks with an unrecorded spawn or no token record at all would pull medians down.
  const complete = rows.filter((r) => !r.unknown && r.tokens > 0);
  const all = st.tasks.tasks.map((task) => taskSpend(task, prices));
  const spent = all.reduce((a, x) => a + x.tokens, 0);
  // A model with no rate is named, so a missing price row cannot pass for a cheap task.
  const unpriced = {};
  for (const task of accepted) for (const entry of task.spend.entries || []) {
    if (!known(entry.tokens) || priced(entry, prices) !== null) continue;
    const model = L.modelIdentity(entry.model || entry.profile) || 'unknown';
    unpriced[model] = (unpriced[model] || 0) + 1;
  }
  const byPath = {};
  for (const r of complete) (byPath[r.path] ||= []).push(r);
  const rungs = [...new Set(complete.flatMap((r) => Object.keys(r.by_rung)))].sort();
  const byRung = Object.fromEntries(rungs.map((rung) => [rung, group(complete.filter((r) => r.by_rung[rung])
    .map((r) => ({ tokens: r.by_rung[rung].tokens, usd: r.by_rung[rung].usd, unpriced: r.by_rung[rung].unpriced })))]));
  const data = {
    accepted: rows.length,
    complete: complete.length,
    all_tasks_tokens: spent,
    tokens_per_accepted: rows.length ? Math.round(spent / rows.length) : null,
    overall: group(complete),
    by_path: Object.fromEntries(Object.entries(byPath).sort().map(([p, list]) => [p, group(list)])),
    by_rung: byRung,
    unpriced_models: Object.fromEntries(Object.entries(unpriced).sort()),
    tasks: rows,
  };
  const line = (name, g) => `${name.padEnd(24)} ${String(g.tasks).padStart(5)} ${fmt(g.median_tokens).padStart(9)} ${fmt(g.mean_tokens).padStart(9)} ${usdText(g.median_usd).padStart(9)} ${String(g.priced_tasks).padStart(6)}`;
  const head = `${''.padEnd(24)} tasks    median      mean   med USD priced`;
  const lines = [
    `accepted tasks: ${rows.length}, with complete token records: ${complete.length}`,
    `all recorded task tokens / accepted tasks: ${fmt(data.tokens_per_accepted)}`,
    `unpriced entries by model: ${Object.entries(data.unpriced_models).map(([m, n]) => `${m} ${n}`).join(', ') || 'none'}`,
    '', head, line('all', data.overall),
    '', 'by escalation path', head, ...Object.entries(data.by_path).map(([p, g]) => line(p, g)),
    '', 'by rung (tokens a task spent on that rung)', head, ...Object.entries(byRung).map(([r, g]) => line(r, g)),
  ];
  return { data, text: lines.join('\n') };
}

module.exports = { benchTokens, pathOf, taskSpend, median };
