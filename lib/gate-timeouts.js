'use strict';

// Preserve the original gate budget for projects that have not configured one.
const DEFAULT_MINUTES = 20;
const FIELDS = ['tests_timeout_min', 'clean_timeout_min'];
const MAX_TIMER_MS = 2 ** 31 - 1;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function valid(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value > 0 && Math.round(value * 60000) >= 1 && value * 60000 <= MAX_TIMER_MS;
}

function errors(gates) {
  return FIELDS.filter((key) => gates?.[key] != null && !valid(gates[key]))
    .map((key) => `project.json gates.${key} must be a positive number of minutes within Node's timer range or null`);
}

function minutes(project, type) {
  return project.gates?.[`${type}_timeout_min`] ?? DEFAULT_MINUTES;
}

// Only runner-reported file names count. A runner that prints no starts or
// interruption locations cannot tell us which files were still running.
function runningFiles(before, after) {
  const pending = new Set();
  for (const line of before.replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
    const start = /^# Subtest: (.+\.[\w]+)$/.exec(line);
    const end = /^(?:not )?ok(?:\s+\d+)?\s+-\s+(.+?)(?:\s+#.*)?$/.exec(line);
    if (start) pending.add(start[1]);
    if (end) pending.delete(end[1]);
  }
  const output = after.replace(ANSI_ESCAPE, '');
  for (const line of output.split(/\r?\n/)) {
    const interrupted = /^⚠ .+ \((.+):\d+:\d+\)$/.exec(line)
      || /^# Interrupted while running: .+ at (.+):\d+:\d+$/.exec(line);
    if (interrupted) pending.add(interrupted[1]);
  }
  for (const block of output.split(/(?=^test at )/m)) {
    const location = /^test at (.+):\d+:\d+\r?\n/.exec(block);
    if (location && block.includes('Promise resolution is still pending but the event loop has already resolved')) {
      pending.add(location[1]);
    }
  }
  return [...pending];
}

function failure(run, budget, command, where = '', redact) {
  const C = require('./gates/common');
  redact ||= C.createRedactor(Object.entries(process.env).filter(([key, value]) => C.secretValue(key, value)));
  const output = run.output ?? [run.stdout, run.stderr].filter(Boolean).join('\n');
  // SIGTERM makes Node print cancellation errors. Keep the output from before
  // the signal so those errors cannot masquerade as failed test assertions.
  const before = run.timeoutOutput ?? '';
  const files = runningFiles(before, run.timeoutDiagnostics ?? output).map(redact);
  const outputTail = C.tailLines(redact(before.replace(ANSI_ESCAPE, '')), 40).slice(-8192);
  return {
    ok: false,
    infrastructure_failure: true,
    timeout: { minutes: budget, running_files: files, output_tail: outputTail },
    summary: `\`${redact(command)}\`${where ? ` ${redact(where)}` : ''}: timed out after ${budget} min (infrastructure failure).\n`
      + `Files still running (reported by runner): ${files.length ? files.join(', ') : 'not reported'}.\n`
      + 'Adjust the project gate timeout or resolve the stalled command, then rerun the gate.'
      + (outputTail ? `\nOutput before timeout (last 40 lines, max 8192 characters):\n${outputTail}` : ''),
  };
}

module.exports = { FIELDS, DEFAULT_MINUTES, valid, errors, minutes, runningFiles, failure };
