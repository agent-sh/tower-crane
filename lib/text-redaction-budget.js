'use strict';

const { performance } = require('node:perf_hooks');

// A 16 MiB token run needs little bookkeeping and still fits. Dense controls and credential
// starts need maps and overlapping spans, so cap their count before allocating those views.
const TEXT_CHARACTERS = 32 << 20;
const TEXT_SITES = 32768;
const TEXT_WORK = 262144;
const TEXT_MS = 5000;
const SITES = /[\x00-\x08\x0b-\x1f\x7f-\x9f\uE000-\uF8FF]|authorization:|gh[pousr]_|github_pat_|sk-|AKIA|ASIA|xox[a-z]-|\[redacted:[A-Za-z0-9_]+\]/gi;

class TextBudgetExceeded extends Error {}

// All entry points are synchronous. Nested cleanup, shape scans and stream readings share one
// budget; a failure unwinds to the outer caller, which drops the entire input.
let active = null;

function textWork(units = 1) {
  if (!active) return;
  active.work += units;
  if (active.work > TEXT_WORK) throw new TextBudgetExceeded(`over ${TEXT_WORK} redaction work units`);
  if (active.work >= active.nextClock) {
    active.nextClock = active.work + 1024;
    if (performance.now() > active.deadline) throw new TextBudgetExceeded(`over ${TEXT_MS} ms redaction time`);
  }
}

function textBudget(input, run, dropped = (text) => text) {
  const outer = active === null;
  if (outer) active = { work: 0, nextClock: 0, deadline: performance.now() + TEXT_MS };
  try {
    if (input.length > TEXT_CHARACTERS) throw new TextBudgetExceeded(`over ${TEXT_CHARACTERS / 1048576} Mi characters`);
    let sites = 0;
    // A fresh regexp: nested calls must not share lastIndex.
    for (const m of input.matchAll(new RegExp(SITES.source, SITES.flags))) {
      // replace with a callback collects its matches before invoking the callback. Count
      // placeholders here too, before that allocation, using the work limit.
      if (!m[0].startsWith('[redacted:') && ++sites > TEXT_SITES) throw new TextBudgetExceeded(`over ${TEXT_SITES} control, marker or credential sites`);
      textWork();
    }
    textWork(0);
    const result = run();
    if (performance.now() > active.deadline) throw new TextBudgetExceeded(`over ${TEXT_MS} ms redaction time`);
    return result;
  } catch (e) {
    if (!outer || !(e instanceof TextBudgetExceeded)) throw e;
    return dropped(`[unscannable text: ${e.message}; content omitted]`, e.message);
  } finally {
    if (outer) active = null;
  }
}

module.exports = { textBudget, textWork };
