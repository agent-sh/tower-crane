'use strict';

// Runaway rules: which claims look like they burn budget, stopped moving or
// lost their usage reading. Computed from the state and the event log on each
// read, never stored; status and the board call the same function.

const T = require('./tasks');
const P = require('./processes');
const L = require('./ladder');
const { SIZES } = require('./state');

// The 90th percentile of tokens per task over T70's window W was 5.5 times the
// median (docs/human-experience.md, section 1); a project without enough
// history of its own uses that ratio.
const DEFAULT_MULTIPLE = 5.5;
// A 90th percentile of fewer than 10 samples is the largest sample.
const MIN_SAMPLES = 10;
// A tier or tier-and-size median needs more than one task's spend.
const MIN_TIER = 3;
// A shorter window measures one turn's burst, not a rate.
const RATE_WINDOW_MS = 5 * 60e3;
// Sent back this many times, a task is in a loop.
const REWORK_LOOP = 3;

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
}

const median = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);

// The project's own norms from its accepted tasks: the multiple a spend must
// pass, spend medians by tier and size, and the median rate per tier.
function calibrate(st) {
  const done = st.tasks.tasks.filter((t) => t.status === 'accepted' && t.spend && t.spend.tokens > 0);
  const tokens = done.map((t) => t.spend.tokens).sort((a, b) => a - b);
  const multiple = tokens.length >= MIN_SAMPLES ? Math.round((quantile(tokens, 0.9) / quantile(tokens, 0.5)) * 10) / 10 : DEFAULT_MULTIPLE;
  const all = tokens.length ? median(tokens) : null;
  const tiers = {};
  const sizes = {};
  for (const tier of L.TIERS) {
    const own = done.filter((t) => t.tier === tier);
    const rates = own.filter((t) => t.spend.minutes > 0).map((t) => t.spend.tokens / t.spend.minutes);
    tiers[tier] = {
      median: own.length >= MIN_TIER ? median(own.map((t) => t.spend.tokens)) : all,
      from: own.length >= MIN_TIER ? 'tier' : 'project',
      rate: rates.length >= MIN_TIER ? median(rates) : null,
      samples: own.length,
    };
    sizes[tier] = {};
    for (const size of SIZES) {
      const bucket = own.filter((t) => t.size === size);
      sizes[tier][size] = {
        ...tiers[tier], size, size_samples: bucket.length,
        median: bucket.length >= MIN_TIER ? median(bucket.map((t) => t.spend.tokens)) : tiers[tier].median,
        from: bucket.length >= MIN_TIER ? 'tier-size' : tiers[tier].from,
      };
    }
  }
  return { multiple, samples: tokens.length, from: tokens.length >= MIN_SAMPLES ? 'project' : 'default', median: all, tiers, sizes };
}

function spendNorm(norms, task) {
  return norms.sizes[task.tier]?.[task.size] || norms.tiers[task.tier]
    || { median: norms.median, from: 'project', rate: null, samples: 0 };
}

// Tokens per minute over the newest RATE_WINDOW_MS of the agent's live
// readings, or null while the readings span less than that.
function burnRate(events, task, agent, now) {
  const live = events.filter((e) => e.cmd === 'spend live' && e.task === task && (e.detail.agent || e.agent) === agent && e.detail.tokens != null);
  if (live.length < 2) return null;
  const last = live.at(-1);
  const start = live.findLast((e) => Date.parse(last.at) - Date.parse(e.at) >= RATE_WINDOW_MS);
  if (!start || now - Date.parse(last.at) > RATE_WINDOW_MS) return null;
  return (last.detail.tokens - start.detail.tokens) / ((Date.parse(last.at) - Date.parse(start.at)) / 60e3);
}

const M = (n) => `${Math.round(n / 1e5) / 10}M`;

// Name the borrowed history when a bucket is too small.
function medianName(tier, norm, fmt = M) {
  if (norm.from === 'tier-size') return `the ${tier} ${norm.size} median of ${fmt(norm.median)}`;
  const n = norm.samples || 0;
  const name = norm.from === 'project'
    ? `the project median of ${fmt(norm.median)} (${tier} has ${n || 'no'} accepted task${n > 1 ? 's' : ''} with tokens)`
    : `the ${tier} median of ${fmt(norm.median)}`;
  if (!norm.size) return name;
  const count = norm.size_samples || 0;
  return `${name} (${tier} ${norm.size} has ${count || 'no'} accepted task${count > 1 ? 's' : ''} with tokens; needs ${MIN_TIER})`;
}
const mins = (ms) => `${Math.max(1, Math.round(ms / 60e3))} min`;

function workerSpend(task, events) {
  const workers = new Set([task.claim.agent]);
  const roles = new Map();
  for (const e of events) {
    if (e.task !== task.id) continue;
    if (e.cmd === 'claim') workers.add(e.detail?.holder || e.agent);
    if (e.cmd === 'spawn') {
      roles.set(e.detail.agent, e.detail.role);
      if (e.detail.role === 'worker') workers.add(e.detail.agent);
    }
  }
  const entries = task.spend?.entries || [];
  for (const e of entries) {
    if (roles.has(e.agent) ? roles.get(e.agent) === 'worker'
      : L.TIERS.includes(e.rung) || (!e.rung && !['owner', 'orchestrator'].includes(e.agent))) workers.add(e.agent);
  }
  const current = entries.filter((e) => e.agent === task.claim.agent);
  return { count: workers.size, entries: current, tokens: current.some((e) => e.tokens != null) ? current.reduce((n, e) => n + (e.tokens || 0), 0) : null };
}

function cacheText(spend, entries = spend.entries) {
  const measured = entries?.filter((e) => e.tokens != null || e.source !== 'manual');
  // Aggregate categories sum only known reports; they cannot fill a missing breakdown.
  const complete = measured?.length
    ? measured.every((e) => ['tokens', 'input', 'cached', 'output'].every((k) => e[k] != null))
      && measured.reduce((n, e) => n + e.tokens, 0) === spend.tokens
    : ['input', 'cached', 'output'].every((k) => spend[k] != null);
  if (!complete) return 'cached share unknown, uncached tokens unknown';
  const totals = measured?.length ? measured.reduce((s, e) => ({ input: s.input + e.input, cached: s.cached + e.cached, output: s.output + e.output }), { input: 0, cached: 0, output: 0 }) : spend;
  return `${Math.round(totals.cached / spend.tokens * 100)}% cached, ${M(totals.input - totals.cached + totals.output)} uncached tokens`;
}

// Every rule a claim trips, in the order the queue names them.
function runaways(st, now = Date.now(), events = st.events) {
  const norms = calibrate(st);
  const reworks = new Map();
  for (const e of events) if (e.cmd === 'rework' && e.task) reworks.set(e.task, (reworks.get(e.task) || 0) + 1);
  const out = [];
  for (const t of st.tasks.tasks) {
    if (t.status !== 'in_progress' || !t.claim) continue;
    const agent = t.claim.agent;
    const add = (rule, text, extra = {}) => out.push({ task: t.id, title: t.title, agent, tier: t.tier, rule, text, ...extra });
    const norm = spendNorm(norms, t);
    const spent = (t.spend && t.spend.tokens) || 0;
    const worker = workerSpend(t, events);
    const comparison = (tokens) => `${Math.round((tokens / norm.median) * 10) / 10} times ${medianName(t.tier, norm)}; the rule is ${norms.multiple} times`;
    if (norm.median && spent > norms.multiple * norm.median) {
      const current = worker.tokens === null ? 'usage unknown' : `${M(worker.tokens)} tokens`;
      add('spend', `${t.id} has spent ${M(spent)} tokens over ${worker.count} worker${worker.count === 1 ? '' : 's'} (current ${agent}: ${current}); ${cacheText(t.spend)}; ${comparison(spent)}`, { agent: null, value: spent, limit: Math.round(norms.multiple * norm.median) });
    }
    if (norm.median && worker.tokens > norms.multiple * norm.median) {
      add('worker-spend', `${agent} has spent ${M(worker.tokens)} tokens in this worker session; ${cacheText({ tokens: worker.tokens }, worker.entries)}; ${comparison(worker.tokens)}`, { value: worker.tokens, limit: Math.round(norms.multiple * norm.median) });
    }
    const rate = norm.rate ? burnRate(events, t.id, agent, now) : null;
    if (rate !== null && rate > norms.multiple * norm.rate) {
      add('rate', `burning ${M(rate)} tokens a minute, ${Math.round((rate / norm.rate) * 10) / 10} times the ${t.tier} median rate; the rule is ${norms.multiple} times`, { value: Math.round(rate), limit: Math.round(norms.multiple * norm.rate) });
    }
    const live = T.liveSpend({ ...t, spend: t.spend || {} }, now).find((l) => l.agent === agent);
    if (live && live.state === 'stale') add('stale', `usage not reported for ${mins(live.age_s * 1000)}; spend and burn rate are unknown`, { since: live.at });
    const supervised = P.supervised(st, t, events);
    if (T.leaseExpired(t, now)) add('lease', supervised ? `lease ran out ${mins(now - Date.parse(t.claim.until))} ago while its process still runs` : `lease ran out ${mins(now - Date.parse(t.claim.until))} ago`, { since: t.claim.until, supervised });
    const stall = events.findLast((e) => e.cmd === 'stall' && e.task === t.id && e.at >= (t.claim.since || ''));
    if (stall && supervised && !events.some((e) => e.task === t.id && e.agent === agent && e.at > stall.at && e.cmd !== 'renew')) {
      add('progress', `no progress since ${stall.at.slice(11, 16)} UTC`, { since: stall.at });
    }
    if ((reworks.get(t.id) || 0) >= REWORK_LOOP) add('reworks', `sent back ${reworks.get(t.id)} times`);
  }
  return { norms, flags: out };
}

module.exports = { runaways, calibrate, spendNorm, burnRate, medianName, DEFAULT_MULTIPLE, MIN_SAMPLES, MIN_TIER, RATE_WINDOW_MS, REWORK_LOOP };
