'use strict';

// Proofs measure a fixed set independently of the project's full-suite gate.

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readText } = require('./text');

// A clone's full-suite gate keeps its own deadline.
const DEADLINE_MIN = 45;
// Brokers and workers create scratch and nested gates; ladder covers the swap's
// documented-defaults assertion. Keep complete files at three file workers.
const PROOF_FILES = ['test/ladder.test.js', 'test/broker.test.js', 'test/spawn.test.js', 'test/gates/tests.test.js'];
// The local sizing run took 133.5 s; 10 minutes leaves 4.5 times that budget.
// Its two worker-shim refusals still need host verification (docs/testing.md).
const PROOF_DEADLINE_MIN = 10;
const WARN_SHARE = 0.75;
// Setup time around the suite runs: the model swap proof runs the suite once;
// the gate scratch proof reruns it on the base when the head fails.
const JOB_TIMEOUTS = { 'model-swap': PROOF_DEADLINE_MIN + 5, 'gate-scratch': 2 * PROOF_DEADLINE_MIN + 10 };

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

function jobTimeout(workflow, job) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/.test(line)) break;
    const match = /^    timeout-minutes: (\S+)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

// The project's settings sit beside the git common directory, as lib/state.js
// finds them. A checkout without Tower Crane state, such as CI, has none.
function projectFile(root, env) {
  if (env.TOWER_CRANE_STATE) return path.join(path.resolve(root, env.TOWER_CRANE_STATE), 'project.json');
  let common;
  try {
    common = cp.execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
  const dir = path.resolve(root, common);
  return path.join(path.basename(dir) === '.git' ? path.dirname(dir) : dir, '.tower-crane', 'project.json');
}

// The workflow is shared, so its drift fails. The project settings are each
// clone's own: a contributor may run the gate with another timeout, so a
// difference there only warns.
function checkSuiteDeadline(root, env = process.env, warn = (line) => console.error(line)) {
  const found = [];
  const ci = path.join(root, '.github', 'workflows', 'ci.yml');
  // A copy of the tree without its workflows, as test fixtures make, has no jobs to hold.
  const workflow = fs.existsSync(ci) ? readText(ci) : null;
  for (const [job, minutes] of workflow === null ? [] : Object.entries(JOB_TIMEOUTS)) {
    const actual = jobTimeout(workflow, job);
    if (actual !== String(minutes)) {
      found.push(`.github/workflows/ci.yml job ${job} has timeout-minutes ${actual ?? 'unset'}; PROOF_DEADLINE_MIN ${PROOF_DEADLINE_MIN} in scripts/suite-time.js sets it to ${minutes}`);
    }
  }
  const file = projectFile(root, env);
  if (file && fs.existsSync(file)) {
    const configured = JSON.parse(readText(file)).gates?.tests_timeout_min;
    // An unset timeout is a project that has not adopted the suite deadline.
    if (configured != null && configured !== DEADLINE_MIN) {
      warn(`warning: the project's gates.tests_timeout_min is ${configured} min but DEADLINE_MIN in scripts/suite-time.js is ${DEADLINE_MIN}; change them together (project set --tests-timeout-min)`);
    }
  }
  if (found.length) throw new Error(found.join('\n'));
}

module.exports = { suiteTime, reportSuiteTime, checkSuiteDeadline, DEADLINE_MIN, PROOF_FILES, PROOF_DEADLINE_MIN, WARN_SHARE, JOB_TIMEOUTS };
