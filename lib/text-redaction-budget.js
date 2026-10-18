'use strict';

const { performance } = require('node:perf_hooks');

// The budget grows with the text, so ordinary output of any size up to the size limit fits and
// only text that needs more work per character than a log does fails closed. Measured in work
// units include allocations: a control run spends a quarter on bookkeeping and occupies three
// Int32 entries; four-byte entries cost a sixteenth each, charged by capacity before allocation.
// Runs use blocks and views join bounded groups of parts, avoiding retained control objects and
// arrays of every slice. Charging full capacity also covers old and new maps during growth.
// At 1 MiB, plain/colored fixtures with both streams spend 0.028/0.033 units per character;
// CRLF and progress fixtures with one stream spend 0.093 and at most 0.124 respectively.
// The floor lets short texts with a few dense sites through. The deadline is a backstop for
// work the units miss; plain text takes about 30 ms per MiB.
const TEXT_CHARACTERS = 32 << 20;
const WORK_FLOOR = 262144;
const WORK_PER_CHARACTER = 1;
const MS_FLOOR = 5000;
const MS_PER_MIB = 1000;

class TextBudgetExceeded extends Error {}

// All entry points are synchronous. Nested cleanup, shape scans and stream readings share one
// budget, set by the outer input; a failure unwinds to the outer caller, which drops the entire
// input.
let active = null;

function textWork(units = 1) {
  if (!active) return;
  active.work += units;
  if (active.work > active.limit) throw new TextBudgetExceeded(`over ${active.limit} redaction work units`);
  if (active.work >= active.nextClock) {
    active.nextClock = active.work + 1024;
    if (performance.now() > active.deadline) throw new TextBudgetExceeded(`over ${active.ms} ms redaction time`);
  }
}

function textMap(entries) {
  textWork(entries / 16);
  return new Int32Array(entries);
}

function textBudget(input, run, dropped = (text) => text) {
  const outer = active === null;
  if (outer) {
    const ms = Math.round(MS_FLOOR + MS_PER_MIB * input.length / 1048576);
    active = { work: 0, nextClock: 0, limit: WORK_FLOOR + WORK_PER_CHARACTER * input.length, ms, deadline: performance.now() + ms };
  }
  try {
    if (input.length > TEXT_CHARACTERS) throw new TextBudgetExceeded(`over ${TEXT_CHARACTERS / 1048576} Mi characters`);
    const result = run();
    if (performance.now() > active.deadline) throw new TextBudgetExceeded(`over ${active.ms} ms redaction time`);
    return result;
  } catch (e) {
    if (!outer || !(e instanceof TextBudgetExceeded)) throw e;
    return dropped(`[unscannable text: ${e.message}; content omitted]`, e.message);
  } finally {
    if (outer) active = null;
  }
}

module.exports = { textBudget, textWork, textMap };
