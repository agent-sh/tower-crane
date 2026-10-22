'use strict';

// V8 coverage, as NODE_V8_COVERAGE writes it, read as the repository files a run executed. Every
// node process writes its own profile when it exits, and child processes inherit the variable, so
// a test that runs the CLI counts the code the CLI ran.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// Files V8 coverage can see run. A map entry for any other file is declared, not measured.
const MEASURED = /\.[cm]?[jt]sx?$/;

function roots(root) {
  const out = [path.resolve(root)];
  try { out.push(fs.realpathSync(root)); } catch {}
  return [...new Set(out)];
}

// A script ran when any of its ranges counted a call; a module that loaded ran its top level.
function ran(script) {
  return (script.functions || []).some((f) => (f.ranges || []).some((r) => r.count > 0));
}

function relative(url, bases) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  let file;
  try { file = fileURLToPath(url); } catch { return null; }
  for (const base of bases) {
    const rel = path.relative(base, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const posix = rel.split(path.sep).join('/');
      return posix.split('/').includes('node_modules') ? null : posix;
    }
  }
  return null;
}

// Adds the repository files one profile ran to `into`. An unreadable or partial profile, such as
// one a killed process left, adds nothing.
function addProfile(file, root, into = new Set(), bases = roots(root)) {
  let profile;
  try { profile = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return into; }
  for (const script of profile?.result || []) {
    if (!ran(script)) continue;
    const rel = relative(script.url, bases);
    if (rel) into.add(rel);
  }
  return into;
}

function profiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => /^coverage-.*\.json$/.test(f)).map((f) => path.join(dir, f)); } catch { return []; }
}

// The repository files every profile in dir ran.
function ranIn(dir, root) {
  const bases = roots(root);
  const out = new Set();
  for (const file of profiles(dir)) addProfile(file, root, out, bases);
  return out;
}

// A coverage map run keeps each test file's profiles apart: lib/tests-coverage-scope.js, loaded
// into every test file process, points that file's children at raw/<slug>/ and names the file in
// names/<slug>; the test file's own profile goes to runner/ and pids/<pid> names its slug. Each
// file's profiles are folded into sets/<slug>.json, the repository files it ran, and deleted, so
// the profiles a whole suite writes (about 300 KB per process) never sit on disk together.
const SCOPE_ENV = 'TC_TEST_COVERAGE_SCOPE';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function fold(dir, slug, root, extra = []) {
  const setFile = path.join(dir, 'sets', `${slug}.json`);
  const files = new Set(readJson(setFile, []));
  const bases = roots(root);
  const read = [...profiles(path.join(dir, 'raw', slug)), ...extra];
  for (const file of read) addProfile(file, root, files, bases);
  fs.mkdirSync(path.dirname(setFile), { recursive: true });
  fs.writeFileSync(`${setFile}.tmp`, JSON.stringify([...files].sort()));
  fs.renameSync(`${setFile}.tmp`, setFile);
  for (const file of read) fs.rmSync(file, { force: true });
}

// Folds what is left, the test files' own profiles and those of children that outlived them, and
// returns the map: each repository file to the test files that ran any of its code.
function collect(dir, root, sha) {
  const names = new Map();
  for (const slug of fs.readdirSync(path.join(dir, 'names'), { throwIfNoEntry: false }) || []) {
    names.set(slug, fs.readFileSync(path.join(dir, 'names', slug), 'utf8'));
  }
  const own = new Map();
  for (const file of profiles(path.join(dir, 'runner'))) {
    const pid = /^coverage-(\d+)-/.exec(path.basename(file))?.[1];
    let slug = null;
    try { slug = fs.readFileSync(path.join(dir, 'pids', pid), 'utf8'); } catch {}
    if (slug && names.has(slug)) own.set(slug, [...(own.get(slug) || []), file]);
  }
  for (const slug of names.keys()) fold(dir, slug, root, own.get(slug) || []);
  const tests = [...names.values()].sort();
  const map = {};
  for (const [slug, test] of names) {
    for (const file of readJson(path.join(dir, 'sets', `${slug}.json`), [])) {
      if (file === test || tests.includes(file)) continue;
      (map[file] ||= []).push(test);
    }
  }
  return normalize({ sha, tests, map });
}

function normalize({ sha, tests, map }) {
  const sorted = {};
  for (const file of Object.keys(map).sort()) sorted[file] = [...new Set(map[file])].sort();
  return { sha, tests: [...new Set(tests)].sort(), map: sorted };
}

// One map from the maps of several shards of one run.
function merge(parts) {
  const shas = [...new Set(parts.map((p) => p.sha))];
  if (shas.length !== 1) throw new Error(`coverage maps come from different commits: ${shas.join(', ')}`);
  const tests = parts.flatMap((p) => p.tests);
  const map = {};
  for (const part of parts) {
    for (const [file, suites] of Object.entries(part.map)) {
      if (tests.includes(file)) continue;
      map[file] = [...(map[file] || []), ...suites];
    }
  }
  return normalize({ sha: shas[0], tests, map });
}

function artifactError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be a JSON object {sha, tests, map}';
  if (typeof value.sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(value.sha)) return 'sha must be the full commit id the map was built at';
  if (!Array.isArray(value.tests) || !value.tests.every((t) => typeof t === 'string')) return 'tests must be an array of test paths';
  const TestsMap = require('./tests-map');
  if (value.map == null || TestsMap.settingError(value.map)) return `map ${TestsMap.settingError(value.map) || 'is missing'}`;
  if (Object.keys(value.map).some((source) => /[?*{}[\]]/.test(source))) return 'map sources must be literal paths';
  return null;
}

module.exports = { MEASURED, SCOPE_ENV, ranIn, addProfile, profiles, roots, fold, collect, merge, artifactError };
