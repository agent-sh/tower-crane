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

const ARTIFACT = 'tests-coverage-map';
const FILE = 'tests-coverage-map.json';

function declared(source) {
  return /[?*{}[\]]/.test(source) || !Coverage.MEASURED.test(source);
}

async function download(ctx, project, run) {
  if (!project.repo) throw refuse('the project records no GitHub repository to download the coverage map from; pass --file FILE');
  const parent = require('./gate-tmp').root(project, ctx.env || process.env);
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'tests-map-'));
  try {
    const r = await C.gh({ root: ctx.cwd || process.cwd() }, ['run', 'download', run, '-R', project.repo, '-n', ARTIFACT, '-D', dir]);
    if (!r.ok) throw refuse(C.ghFailure(r, `gh run download ${run} -n ${ARTIFACT}`));
    try { return fs.readFileSync(path.join(dir, FILE), 'utf8'); } catch {
      throw refuse(`run ${run}'s ${ARTIFACT} artifact has no ${FILE}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function refresh(ctx) {
  const f = ctx.flags;
  const run = f['from-run'];
  if ((run == null) === (f.file == null)) throw usage('tests map refresh needs --from-run RUN_ID or --file FILE');
  if (run != null && !/^\d+$/.test(run)) throw usage('--from-run needs a numeric workflow run id');
  const text = run != null ? await download(ctx, S.loadState(ctx.stateDir).project, run) : (() => {
    try { return fs.readFileSync(f.file, 'utf8'); } catch (e) { throw refuse(`cannot read ${f.file}: ${e.message}`); }
  })();
  let artifact;
  try { artifact = JSON.parse(text); } catch (e) { throw refuse(`the coverage map is not JSON: ${e.message}`); }
  const error = Coverage.artifactError(artifact);
  if (error) throw refuse(`the coverage map ${error}`);
  const out = S.mutate(ctx, 'tests map refresh', (st, emit) => {
    const who = Authority.enforce(ctx, st, ['tests.map'], { emit });
    const kept = Object.entries(st.project.tests?.map || {}).filter(([source]) => declared(source));
    const map = Object.fromEntries([...Object.entries(artifact.map), ...kept].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    st.project.tests = { ...(st.project.tests || {}), map };
    const detail = { ...(run != null ? { run: Number(run) } : { file: path.resolve(f.file) }), sha: artifact.sha,
      measured: Object.keys(artifact.map).length, declared: kept.length, tests: artifact.tests.length,
      ...(who === 'orchestrator' ? { authority: who } : {}) };
    emit(null, detail);
    return detail;
  });
  return { data: out, text: `tests.map pinned from the coverage map built at ${C.short(out.sha)}${run != null ? ` (run ${run})` : ''}: `
    + `${out.measured} measured files over ${out.tests} test files, ${out.declared} declared entries kept` };
}

module.exports = { refresh, declared };
