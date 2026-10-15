'use strict';
// A merged hotfix's full workflow run can fail at its merge commit because the base was already
// red there. Such a failure is `main_red`, not a verdict on the change, only with evidence that the
// base failed the same way before the change: every failed job's failing tests failed in an earlier
// run of the same workflow on the base, at a commit the merge commit contains, in a job of the same
// kind (the same name once a shard number is set aside, so the same runner label and matrix) and
// with the same first error line. Tests move between shards as files are added, so any shard of
// that job counts. The nearest such run is the parent run (the first parent's, or the nearest
// earlier one when the base's concurrency group cancelled it); an older run of the window counts
// as a known flaky test. A test the change touched (its name is in a hunk of the merge commit's
// diff) counts only when the parent run failed it the same way. A job whose log
// names no failing test counts only when its name marks a proof or check job, which never names
// tests, and an earlier run failed the job of that name with the same first error line. Anything
// else, a timed out or cancelled job included, stays a confirmed failure. The CI gate then waits
// for a later green run that contains the merge commit, as it does for a cancelled run, so main_red
// never passes a hotfix on its own.
const { gh, ghFailure, short, sameSha, listSome } = require('./common');
const { cleanLog } = require('../ci-log-text');

// Events whose runs on the base run the whole workflow: base pushes, the daily schedule and manual runs.
const FULL_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);
const GOOD = new Set(['success', 'neutral', 'skipped']);
// The inbox judges the base's CI from the same number of newest runs (lib/main-ci.js).
const WINDOW = 30;
// A failure older than a week says little about the base at the merge commit, and the daily
// scheduled run still puts at least seven runs in that week on a quiet base. On a red base the 30
// runs alone could reach back weeks.
const WINDOW_DAYS = 7;
// Commits read back from the merge commit to tell which earlier runs it contains: one page. A busy
// base cancels about every other push run, so WINDOW completed runs fit in it.
const ANCESTORS = 100;
// Tests kept per job in the evidence, as many as a summary lists.
const NAMES = 20;
const CHECK_HINT = 'Check project.repo, that the commit is pushed, and gh auth status.';
// Jobs that run a script, not a test runner: their logs need not name a failing test.
const NAMELESS_JOB = /\b(?:proof|probe|checks?|lint)\b/i;
const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
// The node:test summary names the file of each failing test on the line before it.
const LOCATION = /^\s*test at (.+?):\d+:\d+\s*$/;
// A gate receipt printed as JSON keeps its failing tests and the runner's output tail.
const OUTPUT_TAIL = /^\s*"output_tail": ("(?:[^"\\]|\\.)*"),?\s*$/;
const NAMES_OPEN = /^\s*"names": \[\s*$/;
const ERROR_LINE = /\b(?:error|failed|assert\w*|exception)\b/i;
const RUNNER_ERROR = /^##\[error\]Process completed with exit code \d+\.?$/;
// An error line whose values are on the next lines: an assertion header ending in a colon, or a TAP
// YAML block scalar.
const GENERIC = /:\s*(?:[|>][-+]?)?$/;

function workflowKey(w) {
  return w.path || w.name;
}

// The Actions API takes a workflow's numeric id or its file name.
function workflowRef(w) {
  return w.workflow_id ?? String(w.path || '').split('/').pop();
}

function runUrl(repo, id) {
  return `https://github.com/${repo}/actions/runs/${id}`;
}

// The job a failure must recur in: the same name once the shard is set aside.
function slot(name) {
  return String(name).replace(/,?\s*shard\s+\d+\s*\/\s*\d+/i, '').replace(/\(\s*,\s*/, '(').replace(/\s+\)/, ')');
}

// What makes two error lines the same failure: not the scratch paths, durations, ids or line numbers that change per run.
function normalize(line) {
  if (line == null) return null;
  return String(line)
    // A dump of records or a response body changes with every run; the message before it names the failure.
    .replace(/(?:\[\s*\{|\{\s*").*$/, '<data>')
    .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z?\b/g, '<date>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/]{1,2}[^\s'"`,()[\]]+){2,}/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, '<time>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/:\d+:\d+\b/g, ':<line>')
    .replace(/\s+/g, ' ')
    .trim();
}

// The failing tests a job log names, each with its first error line and, when the summary gives it,
// its file. A generic first line that ends in a colon (an assertion's "Expected values to be strictly
// equal:") takes the next non-empty line too, where the values are. A gate receipt printed as JSON
// adds the names and output tail it carries.
function parseLog(raw) {
  const { failingTests } = require('../ci-feedback');
  let lines = cleanLog(raw).split('\n').map((l) => l.replace(STAMP, ''));
  const listed = [];
  const embedded = [];
  for (let i = 0; i < lines.length; i++) {
    const tail = OUTPUT_TAIL.exec(lines[i]);
    if (tail) {
      try { embedded.push(...String(JSON.parse(tail[1])).split('\n')); } catch { /* not a JSON string */ }
    }
    if (NAMES_OPEN.test(lines[i])) {
      for (let j = i + 1; j < lines.length && !/^\s*\]/.test(lines[j]); j++) {
        try { listed.push(JSON.parse(lines[j].trim().replace(/,$/, ''))); } catch { break; }
      }
    }
  }
  lines = [...lines, ...embedded];
  const text = lines.join('\n');
  const files = new Map();
  lines.forEach((line, i) => {
    const at = LOCATION.exec(line);
    const next = lines[i + 1] && /^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(lines[i + 1]);
    if (at && next) files.set(next[1].trim(), at[1].replace(/\\/g, '/'));
  });
  const found = failingTests(text).map((t) => ({ name: t.name, error: fullError(lines, t) }));
  for (const name of listed) if (typeof name === 'string' && !found.some((t) => t.name === name)) found.push({ name, error: null });
  return found.map((t) => ({ ...t, ...(files.has(t.name) ? { file: files.get(t.name) } : {}) }));
}

function fullError(lines, t) {
  if (!t.error || RUNNER_ERROR.test(t.error.trim())) return null;
  if (!GENERIC.test(t.error)) return t.error;
  // The error under one of the test's failure lines, before the next failure starts: the spec
  // reporter prints a test twice, and its summary copy may be the one with the error.
  const failure = /^\s*(?:✖|not ok \d+ -)/;
  for (let i = 0; i < lines.length; i++) {
    if (!failure.test(lines[i]) || !lines[i].includes(t.name)) continue;
    for (let j = i + 1; j < lines.length && j <= i + 20 && !failure.test(lines[j]); j++) {
      if (lines[j].trim() !== t.error) continue;
      const next = lines.slice(j + 1, j + 12).map((l) => l.trim()).filter(Boolean);
      // Headers name no value: a YAML block's opener, an assertion's "strictly equal:", a diff's
      // "+ actual - expected". The first line after them that is not one has the values.
      const parts = [t.error];
      while (next.length && parts.length < 5 && (GENERIC.test(parts.at(-1)) || parts.at(-1) === '+ actual - expected')) parts.push(next.shift());
      // A diff gives the actual line, then the expected one.
      if (parts.includes('+ actual - expected') && next[0]?.startsWith('- ')) parts.push(next.shift());
      return parts.join(' ');
    }
  }
  return t.error;
}

// The first error line of a log that names no test, other than the runner's exit line.
function firstError(raw) {
  const line = cleanLog(raw).split('\n').map((l) => l.replace(STAMP, '').trim())
    .find((l) => l && !RUNNER_ERROR.test(l) && ERROR_LINE.test(l));
  return line || null;
}

async function jsonLines(ctx, args, what) {
  const r = await gh(ctx, args);
  if (!r.ok) return { error: `${ghFailure(r, what)}. ${CHECK_HINT}` };
  try {
    return { items: r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) };
  } catch (e) {
    return { error: `could not read ${what} output: ${e.message}` };
  }
}

// Reads GitHub once per run, job and listing, and only what a decision still needs.
function reader(ctx, repo) {
  const logs = new Map();
  const runJobs = new Map();
  // A job's log, parsed; null when it cannot be read.
  const log = (id) => {
    if (!logs.has(id)) {
      logs.set(id, gh(ctx, ['api', `repos/${repo}/actions/jobs/${id}/logs`, '--allow-escape-sequences'])
        .then((r) => (r.ok ? { tests: parseLog(r.stdout), error: firstError(r.stdout) } : null)));
    }
    return logs.get(id);
  };
  const jobs = (run) => {
    if (!runJobs.has(run.id)) {
      runJobs.set(run.id, jsonLines(ctx, ['api', `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, '--paginate', '--jq', '.jobs[] | {id, name, conclusion}'], `gh api actions/runs/${run.id}/jobs`));
    }
    return runJobs.get(run.id);
  };
  return { log, jobs };
}

// The merge commit's ancestors, newest first, without the merge commit itself.
async function ancestors(ctx, repo, sha) {
  const r = await jsonLines(ctx, ['api', `repos/${repo}/commits?sha=${sha}&per_page=${ANCESTORS}`, '--jq', '.[].sha | ascii_downcase | tojson'], `gh api commits?sha=${short(sha)}`);
  if (r.error) return r;
  return { shas: new Set(r.items.filter((s) => !sameSha(s, sha))) };
}

// The hunks of the merge commit's diff against its first parent.
async function changes(ctx, repo, sha) {
  const r = await jsonLines(ctx, ['api', `repos/${repo}/commits/${sha}?per_page=100`, '--paginate', '--jq', '.files[] | {filename, patch}'], `gh api commits/${short(sha)} files`);
  if (r.error) return r;
  return { patches: r.items.map((f) => f.patch || '').join('\n') };
}

// The last WINDOW completed, not cancelled full runs of the workflow on the base in the WINDOW_DAYS
// before the failed run, at commits the merge commit contains, newest first. A cancelled run judged nothing.
async function earlierRuns(ctx, repo, base, run, contained) {
  const until = Date.parse(run.created_at);
  const since = Number.isNaN(until) ? null : new Date(until - WINDOW_DAYS * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const created = encodeURIComponent(since ? `${since}..${run.created_at}` : `<=${run.created_at}`);
  const r = await jsonLines(ctx, ['api', `repos/${repo}/actions/workflows/${encodeURIComponent(workflowRef(run))}/runs?branch=${encodeURIComponent(base)}&created=${created}&per_page=100`,
    '--jq', '.workflow_runs[] | {id, name, path, event, created_at, head_sha, head_branch, status, conclusion, run_attempt}'], `gh api workflow runs of ${workflowKey(run)}`);
  if (r.error) return r;
  const runs = r.items.filter((w) => w.head_branch === base && FULL_EVENTS.has(w.event) && w.status === 'completed'
    && w.conclusion !== 'cancelled' && typeof w.head_sha === 'string' && contained.has(w.head_sha.toLowerCase())
    && workflowKey(w) === workflowKey(run) && (since == null || Date.parse(w.created_at) >= Date.parse(since)))
    .sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1));
  return { runs: runs.slice(0, WINDOW) };
}

// Where an earlier run failed the same test the same way: its job in the same slot, and the error.
function sameTest(test, earlierJobs) {
  for (const j of earlierJobs) {
    const hit = j.tests.find((t) => t.name === test.name && normalize(t.error) === normalize(test.error));
    if (hit) return { job: j.name, job_id: j.id, error: hit.error };
  }
  return null;
}

// Classifies the failed full runs at the merge commit. `failed` are workflow runs with their failed,
// timed out or cancelled check runs at the merge commit as `jobs` (an Actions check run id is its job id).
async function classify(ctx, repo, sha, base, failed) {
  const read = reader(ctx, repo);
  const contained = await ancestors(ctx, repo, sha);
  if (contained.error) return contained;
  let diff = null;
  const windows = new Map();
  const records = [];
  for (const { run, jobs } of failed) {
    const key = workflowKey(run);
    if (!windows.has(key)) windows.set(key, await earlierRuns(ctx, repo, base, run, contained.shas));
    const window = windows.get(key);
    if (window.error) return window;
    const parent = window.runs[0] || null;
    const merged = [];
    for (const c of jobs) {
      const job = { name: c.name, id: c.id, conclusion: c.conclusion, tests: [], explained: false };
      merged.push(job);
      // A timed out or cancelled job checked nothing, so it is not the base's known failure.
      if (c.conclusion !== 'failure') continue;
      const log = await read.log(c.id);
      if (!log) return { error: `gh api actions/jobs/${c.id}/logs failed: the log of ${c.name} at the merge commit cannot be read. ${CHECK_HINT}` };
      job.tests = log.tests.map((t) => ({ ...t, failed_before: null }));
      job.error = log.error;
    }
    if (merged.some((j) => j.tests.length)) {
      if (!diff) diff = await changes(ctx, repo, sha);
      if (diff.error) return diff;
      for (const j of merged) {
        for (const t of j.tests) {
          t.touched = t.name.length >= 8 && diff.patches.includes(t.name);
        }
      }
    }
    const open = () => merged.filter((j) => j.conclusion === 'failure' && !j.explained
      && (j.tests.length || (NAMELESS_JOB.test(j.name) && j.error)));
    for (const [index, earlier] of window.runs.entries()) {
      if (!open().length) break;
      if (GOOD.has(earlier.conclusion)) continue;
      const listed = await read.jobs(earlier);
      if (listed.error) return listed;
      for (const j of open()) {
        const peers = listed.items.filter((e) => e.conclusion === 'failure' && (j.tests.length ? slot(e.name) === slot(j.name) : e.name === j.name));
        const parsed = [];
        for (const e of peers) {
          const log = await read.log(e.id);
          if (log) parsed.push({ ...e, ...log });
        }
        const at = { run: earlier.id, sha: earlier.head_sha.toLowerCase(), url: runUrl(repo, earlier.id) };
        if (!j.tests.length) {
          const hit = parsed.find((e) => normalize(e.error) === normalize(j.error));
          if (hit) {
            j.failed_before = { ...at, job: hit.name, job_id: hit.id, error: hit.error };
            j.explained = true;
          }
          continue;
        }
        for (const t of j.tests) {
          // A test the change touched counts only at the parent run.
          if (t.failed_before || (t.touched && index > 0)) continue;
          const hit = sameTest(t, parsed);
          if (hit) t.failed_before = { ...at, ...hit };
        }
        // The same tests, each with the same error line; at least one has an error to compare, so a
        // failing suite that only repeats its failed child is no evidence alone.
        j.explained = j.tests.every((t) => t.failed_before) && j.tests.some((t) => t.error != null);
      }
    }
    records.push({
      id: run.id, workflow: key, event: run.event, attempt: run.run_attempt || 1, conclusion: run.conclusion, url: runUrl(repo, run.id),
      parent_run: parent && { id: parent.id, sha: parent.head_sha.toLowerCase(), event: parent.event, conclusion: parent.conclusion, url: runUrl(repo, parent.id) },
      earlier_runs: window.runs.length,
      jobs: merged.map((j) => ({
        name: j.name, id: j.id, conclusion: j.conclusion, explained: j.explained,
        ...(j.tests.length ? {} : { error: j.error ?? null, failed_before: j.failed_before || null }),
        tests: j.tests.slice(0, NAMES).map((t) => ({ name: t.name, error: t.error, ...(t.file ? { file: t.file } : {}), touched: !!t.touched, failed_before: t.failed_before })),
        ...(j.tests.length > NAMES ? { tests_total: j.tests.length } : {}),
      })),
    });
  }
  // A failed run with no failed job cannot be compared, and stays confirmed.
  const main = records.every((r) => r.jobs.length && r.jobs.every((j) => j.explained));
  return { failure: { classification: main ? 'main_red' : 'confirmed', runs: records } };
}

// The classification an earlier check recorded for the same failed run attempts at this merge commit.
// The earlier runs it read are completed, so the answer stands until a run is attempted again.
function recorded(task, sha, failed) {
  const entry = (task?.evidence || []).findLast((e) => e.type === 'ci' && sameSha(e.sha, sha)
    && sameSha(e.hotfix_ci?.merge_sha, sha) && e.hotfix_ci.failure);
  const before = entry?.hotfix_ci.failure;
  if (!['main_red', 'confirmed'].includes(before?.classification) || !Array.isArray(before.runs)) return null;
  const ids = (list) => list.map((r) => `${r.id}:${r.attempt}`).sort().join(',');
  return ids(before.runs) === ids(failed.map(({ run }) => ({ id: run.id, attempt: run.run_attempt || 1 }))) ? before : null;
}

// One line per failed run for the summary: its parent run and which failures the base already had.
function describe(failure, base) {
  return failure.runs.map((r) => {
    const parent = r.parent_run ? `parent run ${r.parent_run.id} at ${short(r.parent_run.sha)} ${r.parent_run.conclusion}` : `no earlier ${base} run read`;
    const label = (j) => `${j.name}${j.tests.length ? ` [${listSome(j.tests.map((t) => t.name), 3)}]` : ''}`;
    const where = (j) => [...new Set([...(j.failed_before ? [j.failed_before.run] : []), ...j.tests.map((t) => t.failed_before?.run).filter(Boolean)])].join(', ');
    if (!r.jobs.length) return `${r.workflow} ${r.event} run ${r.id} failed with no failed job to compare (${parent})`;
    const fresh = r.jobs.filter((j) => !j.explained);
    if (!fresh.length) {
      return `${r.workflow} ${r.event} run ${r.id} failed only as ${base} already failed (${parent}): ${listSome(r.jobs.map((j) => `${label(j)} in run ${where(j)}`), 20)}`;
    }
    const why = (j) => (j.conclusion !== 'failure' ? `${j.name} (${j.conclusion})`
      : !j.tests.length && !NAMELESS_JOB.test(j.name) ? `${j.name} (names no failing test)` : label(j));
    return `${r.workflow} ${r.event} run ${r.id} has failures new at the merge commit, not failed the same way in the ${r.earlier_runs} earlier ${base} run${r.earlier_runs === 1 ? '' : 's'} read (${parent}): ${listSome(fresh.map(why), 20)}`;
  }).join('\n');
}

module.exports = { FULL_EVENTS, WINDOW, WINDOW_DAYS, classify, recorded, describe, parseLog, normalize, slot, workflowKey };
