'use strict';

// Runaway rules: which claims look like they burn budget, stopped moving or
// lost their usage reading. Computed from the state and the event log on each
// read, never stored; status and the board call the same function.

const T = require('./tasks');
const P = require('./processes');
const L = require('./ladder');

// The 90th percentile of tokens per task over T70's window W was 5.5 times the
// median (docs/human-experience.md, section 1); a project without enough
// history of its own uses that ratio.
const DEFAULT_MULTIPLE = 5.5;
// A 90th percentile of fewer than 10 samples is the largest sample.
const MIN_SAMPLES = 10;
// A tier median needs three samples to be more than one task's spend.
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
// pass, the median spend per tier and the median rate per tier.
function calibrate(st) {
  const done = st.tasks.tasks.filter((t) => t.status === 'accepted' && t.spend && t.spend.tokens > 0);
  const tokens = done.map((t) => t.spend.tokens).sort((a, b) => a - b);
  const multiple = tokens.length >= MIN_SAMPLES ? Math.round((quantile(tokens, 0.9) / quantile(tokens, 0.5)) * 10) / 10 : DEFAULT_MULTIPLE;
  const all = tokens.length ? median(tokens) : null;
  const tiers = {};
  for (const tier of L.TIERS) {
    const own = done.filter((t) => t.tier === tier);
    const rates = own.filter((t) => t.spend.minutes > 0).map((t) => t.spend.tokens / t.spend.minutes);
    tiers[tier] = {
      median: own.length >= MIN_TIER ? median(own.map((t) => t.spend.tokens)) : all,
      rate: rates.length >= MIN_TIER ? median(rates) : null,
      samples: own.length,
    };
  }
  return { multiple, samples: tokens.length, from: tokens.length >= MIN_SAMPLES ? 'project' : 'default', median: all, tiers };
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
const mins = (ms) => `${Math.max(1, Math.round(ms / 60e3))} min`;

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
    const norm = norms.tiers[t.tier] || { median: norms.median, rate: null };
    const spent = (t.spend && t.spend.tokens) || 0;
    if (norm.median && spent > norms.multiple * norm.median) {
      add('spend', `spent ${M(spent)} tokens, ${Math.round((spent / norm.median) * 10) / 10} times the ${t.tier} median of ${M(norm.median)} (the rule is ${norms.multiple} times)`, { value: spent, limit: Math.round(norms.multiple * norm.median) });
    }
    const rate = norm.rate ? burnRate(events, t.id, agent, now) : null;
    if (rate !== null && rate > norms.multiple * norm.rate) {
      add('rate', `burning ${M(rate)} tokens a minute, ${Math.round((rate / norm.rate) * 10) / 10} times the ${t.tier} median rate (the rule is ${norms.multiple} times)`, { value: Math.round(rate), limit: Math.round(norms.multiple * norm.rate) });
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

module.exports = { runaways, calibrate, burnRate, DEFAULT_MULTIPLE, MIN_SAMPLES, MIN_TIER, RATE_WINDOW_MS, REWORK_LOOP };
