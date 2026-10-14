'use strict';

// Both CI proofs run the whole suite under the tests gate's deadline. Each
// prints its wall time against that deadline and warns while there is still
// headroom, so a slow trend shows up before a run times out.

const fs = require('node:fs');

const DEADLINE_MIN = 45;
const WARN_SHARE = 0.75;

function suiteTime(ms, deadlineMin = DEADLINE_MIN) {
  const share = ms / (deadlineMin * 60000);
  return { wall_ms: Math.round(ms), deadline_min: deadlineMin, share: Number(share.toFixed(3)), warn: share > WARN_SHARE };
}

function reportSuiteTime(label, time, { env = process.env, write = (line) => console.log(line) } = {}) {
  const line = `${label}: suite wall time ${(time.wall_ms / 60000).toFixed(1)} min, ${Math.round(time.share * 100)}% of the ${time.deadline_min}-minute software-gate deadline`;
  write(line);
  // GitHub turns this line into a warning annotation on the run; elsewhere it reads as plain text.
  if (time.warn) write(`::warning title=Suite time::${line}, over the ${Math.round(WARN_SHARE * 100)}% warning line`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${time.warn ? 'Warning: ' : ''}${line}\n`);
  return line;
}

module.exports = { suiteTime, reportSuiteTime, DEADLINE_MIN, WARN_SHARE };
