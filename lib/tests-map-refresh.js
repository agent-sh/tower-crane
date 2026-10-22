'use strict';

// `tests map refresh`: pins tests.map from a coverage map a full CI run built
// (scripts/tests-coverage-map.js), so crucial head runs select the suites that
// measurably run each changed file. Entries coverage cannot measure, globs and
// files V8 never runs (documentation, data), are declared by hand and kept.
const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const C = require('./gates/common');
const Coverage = require('./tests-coverage');
const Authority = require('./authority');
const { refuse, usage } = require('./util');
const { isDeepStrictEqual } = require('node:util');

const ARTIFACT = 'tests-coverage-map';
const FILE = 'tests-coverage-map.json';
const POLL_MS = 3600000;
const STALE_MS = 3 * 86400000;

function declared(source) {
  return /[?*{}[\]]/.test(source) || !Coverage.MEASURED.test(source);
}

async function download(ctx, project, run) {
  if (!project.repo) throw refuse('the project records no GitHub repository to download the coverage map from; pass --file FILE');
  const parent = require('./gate-tmp').root(project, ctx.env || process.env);
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'tests-map-'));
  try {
    const r = await C.gh(ghContext(ctx), ['run', 'download', String(run), '-R', project.repo, '-n', ARTIFACT, '-D', dir]);
    if (!r.ok) throw refuse(C.ghFailure(r, `gh run download ${run} -n ${ARTIFACT}`));
    try { return fs.readFileSync(path.join(dir, FILE), 'utf8'); } catch {
      throw refuse(`run ${run}'s ${ARTIFACT} artifact has no ${FILE}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parse(text) {
  let artifact;
  try { artifact = JSON.parse(text); } catch (e) { throw refuse(`the coverage map is not JSON: ${e.message}`); }
  const error = Coverage.artifactError(artifact);
  if (error) throw refuse(`the coverage map ${error}`);
  return artifact;
}

function pin(ctx, artifact, source, expected) {
  return S.mutate(ctx, 'tests map refresh', (st, emit) => {
    const who = Authority.enforce(ctx, st, ['tests.map'], { emit });
    // A manual pin or another follower can finish while the download is running.
    if (expected && (st.project.repo !== expected.project.repo || st.project.base !== expected.project.base
      || !isDeepStrictEqual(st.project.tests?.map, expected.project.tests?.map)
      || !isDeepStrictEqual(provenance(st), provenance(expected)))) return null;
    const kept = Object.entries(st.project.tests?.map || {}).filter(([source]) => declared(source));
    const map = Object.fromEntries([...Object.entries(artifact.map), ...kept].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    st.project.tests = { ...(st.project.tests || {}), map };
    const detail = { ...source, sha: artifact.sha,
      measured: Object.keys(artifact.map).length, declared: kept.length, tests: artifact.tests.length,
      ...(who === 'orchestrator' ? { authority: who } : {}) };
    emit(null, detail);
    return detail;
  });
}

async function refresh(ctx) {
  const f = ctx.flags;
  const run = f['from-run'];
  if ((run == null) === (f.file == null)) throw usage('tests map refresh needs --from-run RUN_ID or --file FILE');
  if (run != null && !/^\d+$/.test(run)) throw usage('--from-run needs a numeric workflow run id');
  const text = run != null ? await download(ctx, S.loadState(ctx.stateDir).project, run) : (() => {
    try { return fs.readFileSync(f.file, 'utf8'); } catch (e) { throw refuse(`cannot read ${f.file}: ${e.message}`); }
  })();
  const out = pin(ctx, parse(text), run != null ? { run: Number(run) } : { file: path.resolve(f.file) });
  return { data: out, text: `tests.map pinned from the coverage map built at ${C.short(out.sha)}${run != null ? ` (run ${run})` : ''}: `
    + `${out.measured} measured files over ${out.tests} test files, ${out.declared} declared entries kept` };
}

function provenance(st) {
  if (st.project.tests?.map == null) return null;
  const event = st.events.findLast((e) => e.cmd === 'tests map refresh'
    || e.cmd === 'project set' && Object.hasOwn(e.detail, 'tests-map') || e.cmd === 'init');
  return event ? { run: event.detail.run || null, sha: event.detail.sha || null,
    at: event.detail.built_at || event.at } : null;
}

function info(st, now = Date.now()) {
  const pin = provenance(st);
  if (!pin) return null;
  const age = Math.max(0, now - Date.parse(pin.at));
  return { ...pin, age_ms: age, stale: age > STALE_MS };
}

function ageText(age) {
  return age >= 86400000 ? `${Math.floor(age / 86400000)}d old`
    : age >= 3600000 ? `${Math.floor(age / 3600000)}h old` : `${Math.floor(age / 60000)}m old`;
}

function ghContext(ctx) {
  return { root: ctx.cwd || ctx.root || process.cwd(), exec: ctx.exec || C.treeExec, signal: ctx.automationSignal };
}

async function api(ctx, endpoint) {
  const r = await C.gh(ghContext(ctx), ['api', endpoint]);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh api ${endpoint}`));
  try { return JSON.parse(r.stdout); } catch { throw refuse(`invalid GitHub response for gh api ${endpoint}`); }
}

function cacheFile(ctx) {
  return path.join(ctx.stateDir, 'tests-map-cache.json');
}

function cache(ctx) {
  try { return JSON.parse(fs.readFileSync(cacheFile(ctx), 'utf8')) || {}; } catch { return {}; }
}

// Reserve the hourly read before networking, including failures. All wait hosts
// share this receipt, so hook traffic and concurrent followers cannot multiply polls.
async function automatic(ctx) {
  const st = S.loadState(ctx.stateDir);
  const { repo, base } = st.project;
  if (!repo || !base || st.project.tests?.map == null || ctx.automationSignal?.aborted) return false;
  const same = (c) => c.repo === repo && c.base === base;
  const fresh = (c, now = Date.now()) => same(c) && Number.isFinite(Date.parse(c.read_at))
    && Date.parse(c.read_at) <= now && now - Date.parse(c.read_at) < POLL_MS;
  if (fresh(cache(ctx))) return false;
  let receipt;
  const reserved = S.mutate(ctx, 'tests map poll', (current) => {
    const now = Date.now();
    if (fresh(cache(ctx), now) || current.project.repo !== repo || current.project.base !== base
      || current.project.tests?.map == null) return false;
    receipt = { repo, base, read_at: new Date(now).toISOString() };
    S.writeAtomic(cacheFile(ctx), JSON.stringify(receipt));
    return true;
  });
  if (!reserved) return false;
  try {
    const before = provenance(st);
    const listing = await api(ctx, `repos/${repo}/actions/runs?branch=${encodeURIComponent(base)}&per_page=100`);
    if (!Array.isArray(listing.workflow_runs)) throw refuse('invalid GitHub workflow runs response');
    const runs = listing.workflow_runs.filter((r) => Number.isSafeInteger(r.id) && r.id > 0
      && ['schedule', 'workflow_dispatch'].includes(r.event) && r.head_branch === base
      && r.status === 'completed' && r.conclusion === 'success'
      && /^[a-f0-9]{40,64}$/.test(r.head_sha) && Number.isFinite(Date.parse(r.created_at)))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
    for (const run of runs) {
      if (run.id === before?.run || C.sameSha(run.head_sha, before?.sha || '')
        || (before?.run && run.id < before.run)) continue;
      if (before?.sha) {
        const comparison = await api(ctx, `repos/${repo}/compare/${before.sha}...${run.head_sha}?per_page=1`);
        if (comparison.status !== 'ahead') continue;
      }
      const artifacts = await api(ctx, `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
      if (!Array.isArray(artifacts.artifacts)) throw refuse('invalid GitHub artifacts response');
      if (!artifacts.artifacts.some((a) => a.name === ARTIFACT && a.expired === false)) continue;
      const artifact = parse(await download(ctx, st.project, run.id));
      if (!C.sameSha(artifact.sha, run.head_sha)) throw refuse(`run ${run.id}'s coverage map sha does not match its head`);
      return !!pin(ctx, artifact, { run: run.id, built_at: run.created_at, base, automatic: true }, st);
    }
    return false;
  } catch (e) {
    S.mutate(ctx, 'tests map poll', () => {
      if (isDeepStrictEqual(cache(ctx), receipt))
        S.writeAtomic(cacheFile(ctx), JSON.stringify({ ...receipt, error: e.message }));
    });
    throw e;
  }
}

module.exports = { refresh, declared, automatic, info, ageText };
