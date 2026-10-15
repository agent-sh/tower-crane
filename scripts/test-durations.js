#!/usr/bin/env node
'use strict';

// Refreshes test/durations.json, the per-file test times that test/run.js splits CI
// shards by, from the logs of finished CI runs:
//
//   node scripts/test-durations.js RUN_ID [RUN_ID...]
//
// It reads the `npm test` step of every `test (<os>, node <n>, shard <i>/<n>)` job,
// sums each top-level test's reported duration into the file that defines the test
// title, and averages a file over the jobs that ran it. Titles come from the test
// files in this checkout, so the table follows files that were split or renamed
// since the run. Each platform gets its own table: Windows and Linux differ in
// which files are slow. Needs `gh` signed in with read access to the repository.

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'durations.json');
const PLATFORMS = { 'ubuntu-latest': 'linux', 'windows-latest': 'win32', 'macos-latest': 'darwin' };

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The string and template literals of a call's first argument, from START to its
// top-level comma: `cond ? 'a' : 'b'` declares both titles. Each literal is a list of
// text parts that its interpolations separate.
function literals(text, start) {
  const out = [];
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let s = '';
      for (i++; i < text.length && text[i] !== c; i++) s += text[i] === '\\' ? text[++i] : text[i];
      if (!depth) out.push([s]);
    } else if (c === '`') {
      const parts = [''];
      for (i++; i < text.length && text[i] !== '`'; i++) {
        if (text[i] === '\\') parts[parts.length - 1] += text[++i];
        else if (text[i] === '$' && text[i + 1] === '{') {
          // Skip the interpolation, nested templates and all, by its braces.
          let braces = 0;
          for (i++; i < text.length; i++) {
            if (text[i] === '{') braces++;
            else if (text[i] === '}' && --braces === 0) break;
          }
          parts.push('');
        } else parts[parts.length - 1] += text[i];
      }
      if (!depth) out.push(parts);
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (!depth) break;
      depth--;
    } else if (c === ',' && !depth) break;
  }
  return out;
}

// Every title a test file declares with test() or describe(). An interpolation
// matches any text, so a title's weight is its literal text: the longest match wins.
function declarations(file, text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\w.$])(?:test|describe)\(/g)) {
    for (const parts of literals(text, m.index + m[0].length)) {
      const literal = parts.join('').length;
      if (literal) out.push({ file, literal, re: new RegExp(`^${parts.map(escape).join('.*')}$`) });
    }
  }
  return out;
}

function titles(root = ROOT) {
  const { testFiles } = require(path.join(root, 'test', 'run.js'));
  return testFiles().flatMap((file) => declarations(file, fs.readFileSync(path.join(root, file), 'utf8')));
}

// The top-level results of the `npm test` step in a job log, up to Node's repeated list of failures.
function results(log) {
  const out = [];
  let inStep = false;
  for (const line of log.split(/\r?\n/)) {
    const text = line.replace(/^\S+Z /, '');
    if (text.startsWith('##[group]Run ')) {
      inStep = text === '##[group]Run npm test';
      continue;
    }
    if (!inStep) continue;
    if (/^✖ failing tests:/.test(text)) break;
    const m = /^[✔✖﹣] (.*?) \(([\d.]+)ms\)(?: # .*)?$/.exec(text);
    if (m) out.push({ title: m[1].replace(/ # (?:SKIP|TODO).*$/, ''), ms: Number(m[2]) });
  }
  return out;
}

// Seconds per file for one job. A title goes to the file whose declaration matches it
// with the most literal text. A tie between files goes to the one this log shows by an
// unambiguous title; titles no file declares any more are dropped.
function fileTimes(log, declared) {
  const rows = results(log).map((r) => {
    const hits = declared.filter((d) => d.re.test(r.title));
    const best = Math.max(0, ...hits.map((d) => d.literal));
    return { ...r, files: [...new Set(hits.filter((d) => d.literal === best).map((d) => d.file))] };
  });
  const present = new Set(rows.filter((r) => r.files.length === 1).map((r) => r.files[0]));
  const times = {};
  let unmatched = 0;
  for (const row of rows) {
    const files = row.files.length > 1 ? row.files.filter((f) => present.has(f)) : row.files;
    if (files.length !== 1) {
      unmatched += row.ms;
      continue;
    }
    times[files[0]] = (times[files[0]] || 0) + row.ms / 1000;
  }
  return { times, unmatched: unmatched / 1000 };
}

function gh(args) {
  return cp.execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function repository() {
  const url = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository.url;
  return /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)[1];
}

function main(runs) {
  if (!runs.length || runs.some((id) => !/^\d+$/.test(id))) {
    console.error('usage: node scripts/test-durations.js RUN_ID [RUN_ID...]');
    process.exit(2);
  }
  const repo = repository();
  const declared = titles();
  const samples = {};
  for (const run of runs) {
    for (const job of JSON.parse(gh(['run', 'view', run, '-R', repo, '--json', 'jobs'])).jobs) {
      const m = /^test \(([^,]+), node \d+, shard \d+\/\d+\)$/.exec(job.name);
      if (!m || !PLATFORMS[m[1]] || job.conclusion !== 'success') continue;
      const log = gh(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.databaseId}/logs`]);
      const { times, unmatched } = fileTimes(log, declared);
      console.error(`${job.name} (run ${run}): ${Object.keys(times).length} files, ${unmatched.toFixed(0)} s unmatched`);
      const platform = (samples[PLATFORMS[m[1]]] ||= {});
      for (const [file, s] of Object.entries(times)) (platform[file] ||= []).push(s);
    }
  }
  const table = {};
  for (const platform of Object.keys(samples).sort()) {
    table[platform] = Object.fromEntries(Object.entries(samples[platform]).sort(([a], [b]) => a.localeCompare(b))
      .map(([file, list]) => [file, Math.round(10 * list.reduce((a, b) => a + b, 0) / list.length) / 10]));
  }
  if (!Object.keys(table).length) {
    console.error('no successful test jobs in those runs');
    process.exit(1);
  }
  fs.writeFileSync(OUT, `${JSON.stringify(table, null, 2)}\n`);
  console.error(`wrote ${path.relative(ROOT, OUT)}`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { declarations, results, fileTimes, titles };
