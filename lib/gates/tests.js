'use strict';
// Prove keeps changed tests while reverting code; run-only checks the submitted head.
const fs = require('node:fs');
const path = require('node:path');
const { fail, short, tailLines, keepTail, stripEscapes, createRedactor, secretValue, how, killed, notFound, errText, git, shell, resolveCommit, mergeBase, baseTip, withWorktree, removeTree, listSome } = require('./common');
const gateTmp = require('../gate-tmp');
const testsPolicy = require('../tests-policy');
const { expand } = require('../tests-map');

const timeouts = require('../gate-timeouts');
const TAIL = 40;
const OUTPUT_TAIL_CHARS = 8192;
// Only the tail of the output is reported; this bounds what a verbose suite keeps in memory.
const KEEP_CHARS = 1 << 20;

function diagnosticRedactor(project, root) {
  const env = process.env;
  // Environment values are redacted only when they look like secrets (see secretValue). The gate
  // runs under the whole environment, where values such as NODE_ENV=test or MAX_THINKING_TOKENS=1
  // would rewrite ordinary words, numbers, command names and paths in the output.
  const secrets = Object.entries(env).filter(([name, value]) => secretValue(name, value));
  const envFiles = new Set();
  const addEnvironment = (values) => {
    for (const [name, value] of Object.entries(values || {})) {
      if (secretValue(name, value)) secrets.push([name, value]);
    }
  };
  const addSettings = (settings) => {
    if (!settings || typeof settings !== 'object') return;
    addEnvironment(settings.env);
    if (typeof settings.env_file === 'string' && settings.env_file.trim()) envFiles.add(settings.env_file);
  };
  addSettings(project);
  addEnvironment(project.tests?.host_env);

  try {
    const layers = require('../ladder').resolve(project, env);
    for (const entry of Object.values(layers.ladder || {})) {
      addSettings(entry.own);
      for (const fallback of entry.fallbacks || []) addSettings(fallback);
    }
  } catch {
    // Invalid user ladder settings must not stop a tests check from running.
  }

  const SpawnSettings = require('../spawn-settings');
  let home = require('node:os').homedir();
  try { home = require('../agents').origin(env).home; } catch {}
  for (const file of envFiles) {
    try {
      const settings = SpawnSettings.resolve({}, { env_file: file });
      const prepared = SpawnSettings.prepare(settings, home, root || process.cwd());
      addEnvironment(SpawnSettings.agentEnv({ ...prepared, env: {} }));
    } catch {
      // Unreadable environment files are not used by the gate process.
    }
  }
  return createRedactor(secrets);
}

// Test layouts across languages. Directory names and suffixes after a separator match in any
// case (test/, Tests/, MyApp.Tests/, foo_spec.rb); CamelCase forms need their capital
// (FooTest.java, AppTests/) so latest.js and contest.py stay code. A code file taken for a test
// is never reverted, which would let the gate pass without proof.
const DEFAULT_TESTS = [
  /(^|\/)(tests?|__tests?__|specs?)\//i, // test/, Tests/, __tests__/, spec/
  /(^|\/)[^/]+[._-](unit|integration|e2e|functional)?tests?\//i, // MyApp.Tests/, MyApp.UnitTests/, integration_test/
  /(^|\/)[^/]*[a-z0-9](Tests?|Specs?)\//, // AppTests/, androidTest/, integrationTest/
  /(^|\/|[._-])(tests?|specs?)\.[^/]+$/i, // foo.test.js, foo_test.go, foo_spec.rb, foo-spec.ts, test.js
  /(^|\/)test_[^/]+$/i, // test_foo.py, test_util.c
  /[a-z0-9](Tests?|Specs?|IT|TestCase)\.[^/.]+$/, // FooTest.java, FooTests.swift, FooTests.cs, FooSpec.scala, FooIT.java
  /(^|\/)Test[A-Z][^/]*\.[^/.]+$/, // TestFoo.java
];

// Fixtures and helpers load the tests; they are support code, so an edit to one is not coverage.
const SUPPORT_FILES = [
  /(^|\/)(fixtures?|__fixtures__|__mocks__|testdata)\//i,
  /(^|\/)helpers?\//i,
  /(^|[-_./])(helpers?|fixtures?)\.[^./]+$/i, // helpers.js, test_helper.rb, stack-fixture.js
  /(^|\/)conftest\.py$/,
];

function isSupportFile(p) {
  return SUPPORT_FILES.some((re) => re.test(p));
}

function isTestFile(p) {
  return DEFAULT_TESTS.some((re) => re.test(p)) && !isSupportFile(p);
}

function escapeRe(s) {
  return s.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
}

// A glob over repository paths: `*` and `?` stay inside one directory, `**/` spans any number
// of directories (none included), `{a,b}` is either, and a trailing `/` takes all beneath.
function globSource(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{' && g.indexOf('}', i) > i) {
      const end = g.indexOf('}', i);
      re += `(?:${g.slice(i + 1, end).split(',').map(globSource).join('|')})`;
      i = end;
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

function globToRegExp(glob) {
  const g = glob.trim().replace(/^\.\//, '');
  return new RegExp(`^${globSource(g)}${g.endsWith('/') ? '.*' : ''}$`);
}

// project.json tests.paths, when set, replaces the default layouts with the owner's globs.
function testMatcher(project) {
  const t = project.tests;
  const defaults = { match: isTestFile, source: 'the default test layouts' };
  if (t == null) return defaults;
  const paths = typeof t === 'object' && !Array.isArray(t) ? t.paths : [];
  if (paths == null) return defaults;
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && p.trim())) {
    return { error: 'project.json tests.paths must be a non-empty array of globs; set it with tower-crane project set --tests-paths \'["src/test/**","**/*Test.java"]\', or use --tests-paths null to restore the default test layouts' };
  }
  const res = paths.map(globToRegExp);
  return { match: (p) => res.some((re) => re.test(p)), source: 'project.json tests.paths' };
}

// The default keep set is package metadata and lockfiles that describe the build.
// Executable build files such as Makefiles and Gradle scripts need an explicit tests.keep glob.
const DEFAULT_BUILD_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb', 'cargo.toml', 'cargo.lock',
  'go.mod', 'go.sum', 'go.work', 'go.work.sum', 'pyproject.toml', 'setup.cfg',
  'pipfile', 'pipfile.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'pylock.toml',
  'pom.xml', 'gradle.lockfile', 'composer.json', 'composer.lock', 'gemfile.lock',
  'podfile.lock', 'pubspec.yaml', 'pubspec.lock', 'mix.lock', 'package.resolved',
  'nuget.config', 'packages.config', 'packages.lock.json', 'deno.json', 'deno.jsonc',
  'deno.lock', 'environment.yml', 'environment.yaml', 'pixi.toml', 'pixi.lock',
  'cmakepresets.json', 'cmakeuserpresets.json', 'jsconfig.json',
]);

function isDefaultBuildFile(p) {
  const name = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  return DEFAULT_BUILD_FILES.has(name)
    || /^requirements.*\.txt$/.test(name)
    || /^tsconfig.*\.json$/.test(name);
}

function keepMatcher(project) {
  const t = project.tests;
  const keep = t && typeof t === 'object' && !Array.isArray(t) ? t.keep : null;
  if (keep == null) return { match: isDefaultBuildFile, source: 'default manifests and lockfiles' };
  if (!Array.isArray(keep) || !keep.every((p) => typeof p === 'string' && p.trim())) {
    return {
      error: 'project.json tests.keep must be an array of globs; set it with tower-crane project set --tests-keep \'["Makefile","**/*.gradle"]\', or use --tests-keep null to clear the override',
    };
  }
  const res = keep.map(globToRegExp);
  return {
    match: (p) => isDefaultBuildFile(p) || res.some((re) => re.test(p)),
    source: 'default manifests and lockfiles plus project.json tests.keep',
  };
}

// Files the commit changed against the merge base, as {status, path}. Renames show up as a
// delete plus an add, so each side is reverted on its own terms.
async function changedFiles(ctx, root, from, to) {
  const r = await git(ctx, root, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', from, to]);
  if (!r.ok) return null;
  const parts = r.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] });
  return files;
}

function cmdLine(cmd) {
  return `\`${cmd}\``;
}

function boundedOutputTail(text, lines = TAIL, chars = OUTPUT_TAIL_CHARS) {
  let outputTail = tailLines(text, lines);
  if (outputTail.length > chars) {
    const marker = '[earlier output omitted]';
    const content = tailLines(outputTail.slice(-(chars - marker.length - 1)), lines - 1);
    outputTail = `${marker}\n${content}`;
  }
  return outputTail;
}

function testFailure(r, redact) {
  // Escapes come out first so the patterns see plain lines. Redacted before anything is cut: a cut
  // through a token would leave a fragment the patterns miss.
  const raw = r.output != null ? r.output : [r.stdout, r.stderr].filter(Boolean).join('\n');
  const out = redact(stripEscapes(raw));
  const names = [];
  const seen = new Set();
  for (const line of out.split(/\r?\n/)) {
    const spec = /^\s*✖\s+(.+?)\s*$/.exec(line);
    const tap = /^\s*not ok(?:\s+\d+)?(?:\s+-\s*|\s+)(.+?)\s*$/.exec(line);
    // Spec durations vary between runs; only the test name identifies a matching base failure.
    let name = spec?.[1].replace(/\s+\([\d.]+m?s\)$/, '');
    if (name && /^(?:failing tests\b|test at\b)/i.test(name)) name = null;
    name ||= tap?.[1];
    if (name && !seen.has(name)) {
      names.push(name);
      seen.add(name);
    }
  }
  return { names, output_tail: boundedOutputTail(out) };
}

function failedRun(cmd, r, where, redact) {
  const failure = testFailure(r, redact);
  const names = failure.names.length
    ? `Failing tests:\n${failure.names.map((name) => `- ${name}`).join('\n')}`
    : 'Failing tests: none identified';
  const output = failure.output_tail || '(empty output)';
  return {
    test_failure: failure,
    summary: `${cmdLine(redact(cmd))} ${redact(where)}: ${redact(how(r))}.\n${names}\nOutput tail (last ${TAIL} lines, max ${OUTPUT_TAIL_CHARS} characters):\n${output}`,
  };
}

function safeResult(result, redact) {
  if (!result || typeof result !== 'object') return result;
  const safe = { ...result };
  if (typeof safe.summary === 'string') safe.summary = redact(safe.summary);
  if (safe.test_failure) {
    safe.test_failure = {
      ...safe.test_failure,
      names: (safe.test_failure.names || []).map(redact),
      output_tail: boundedOutputTail(redact(safe.test_failure.output_tail || '')),
    };
  }
  return safe;
}

function hostEnvError(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([name, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof v !== 'string' || v.includes('\0'))) {
    return 'must be a JSON map of environment names to string values or null';
  }
  return null;
}

// Directory layouts also match documentation and data. Separate host commands need a source or
// test-format suffix; projects with other formats select them explicitly through tests.paths.
const HOST_TEST_SUFFIX = /\.(?:[cm]?js|jsx|tsx?|py|rb|php|go|rs|java|kts?|cs|fsx?|vb|swift|dart|c|cc|cpp|cxx|m|mm|r|jl|lua|pl|t|sh|bash|zsh|ps1|bat|cmd|bats|exs?|erl|clj[cs]?|scala|hs|ml|groovy|feature|robot|wast|wat)$/i;

function hostTestMatcher(project) {
  const matcher = testMatcher(project);
  if (matcher.error) return matcher;
  const explicit = project.tests?.paths != null;
  return { ...matcher, match: (file) => matcher.match(file) && !isSupportFile(file) && (explicit || HOST_TEST_SUFFIX.test(file)) };
}

// Host-only files tracked at sha, selected as the gate selects them. A listing that fails twice
// (a slow or loaded host) falls back to the matching files in the checkout on disk, so the lease
// deadline still counts them; counting none would leave it short by three commands per file.
function hostFileCount(project, root, sha, list = (args) => require('../commands').spawnSync('git', args, {
  encoding: 'utf8', maxBuffer: Infinity, timeout: 60000, windowsHide: true,
})) {
  const globs = project.tests?.host_only;
  if (!root || !sha || !Array.isArray(globs) || !globs.length || !globs.every((p) => typeof p === 'string' && p.trim())) return 0;
  const matcher = hostTestMatcher(project);
  if (matcher.error) return 0;
  const isHost = (file) => globs.some((g) => globToRegExp(g).test(file)) && matcher.match(file);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = list(['-C', root, 'ls-tree', '-r', '--name-only', '-z', sha]);
    if (r.status === 0) return r.stdout.split('\0').filter((file) => file && isHost(file)).length;
  }
  return checkoutFiles(root, globs).filter(isHost).length;
}

// Files under each glob's fixed leading directories, relative to root with forward slashes.
// Dependency and git directories hold no project tests and can be large, so they are skipped.
function checkoutFiles(root, globs) {
  const found = new Set();
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const file = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') walk(file);
      else if (e.isFile()) found.add(file);
    }
  };
  const starts = new Set(globs.map((g) => {
    const parts = g.trim().replace(/^\.\//, '').split('/');
    const wild = parts.findIndex((part) => /[*?{]/.test(part));
    return (wild === -1 ? parts.slice(0, -1) : parts.slice(0, wild)).join('/');
  }));
  for (const start of starts) walk(start);
  return [...found];
}

// The most timed commands one run starts, each allowed the full per-command timeout. Prove runs
// the head, the scoped proof under tests.expensive, the reverted run and a base rerun after a
// failure, and each of the first three runs one more command per host-only file. Run-only runs
// the head and the base rerun. None runs nothing.
function plannedCommands(project, kind, hostFiles = 0) {
  const policy = testsPolicy.resolve(project, kind);
  if (policy.error || policy.mode === 'none') return 0;
  const run = 1 + hostFiles;
  if (policy.mode === 'run-only') return run + 1;
  return run + (policy.expensive ? run : 0) + run + 1;
}

// The gate-run lease asks a gate module for this, when it exports it, before the lease's write.
function plan(project, root, task) {
  return plannedCommands(project, task.kind || 'code', hostFileCount(project, root, task.sha));
}

// TAP and Node's spec reporter expose final case counts. Exit zero alone is not execution proof.
function hostCounts(result) {
  const output = stripEscapes(result.output ?? `${result.stdout}\n${result.stderr}`);
  const counts = {};
  for (const match of output.matchAll(/^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm)) {
    counts[match[1]] = Number(match[2]);
  }
  if (!['tests', 'pass', 'fail', 'skipped'].every((key) => key in counts)) return { ran: null, skipped: null };
  const ran = counts.pass + counts.fail + (counts.cancelled || 0);
  const skipped = counts.skipped + (counts.todo || 0);
  return ran + skipped === counts.tests ? { ran, skipped } : { ran: null, skipped: null };
}

// Why a host-only file skipped, from its TAP `# SKIP reason` or spec `﹣ name # reason` lines: a missing
// opt-in in tests.host_env reads differently from a harness that is not installed. Redacted and bounded,
// since the receipt and its event keep them.
const SKIP_REASONS = 5;
const SKIP_REASON_CHARS = 200;
function skipReasons(result, redact) {
  const output = stripEscapes(result.output ?? `${result.stdout}\n${result.stderr}`);
  const reasons = [];
  for (const match of output.matchAll(/^\s*(?:(?:not )?ok \d+\b.*?#\s*SKIP\b[:\s]*|﹣ .*?\(\d[\d.]*m?s\)\s*#\s*)(.*?)\s*$/gim)) {
    // Redact before the cut, so a secret split at the limit cannot pass the redactor in pieces.
    const reason = redact(match[1]).slice(0, SKIP_REASON_CHARS);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
    if (reasons.length === SKIP_REASONS) break;
  }
  return reasons;
}

// Gate commands run outside the sandbox. The ordinary suite excludes host-only files; their
// separate commands clear the exclusion and receive host_env.
// opts.env, when given, is the gate's scratch environment and already holds process.env.
function testShell(ctx, command, opts) {
  const env = { ...(opts.env ?? process.env), TOWER_CRANE_SANDBOX: '0' };
  delete env.TOWER_CRANE_HOST_ONLY;
  delete env.NODE_TEST_CONTEXT;
  return shell(ctx, command, { ...opts, env });
}

async function run(ctx) {
  const { root, task, project } = ctx;
  const redact = diagnosticRedactor(project, root);
  const args = ctx.args || {};
  const log = ctx.log || (() => {});
  const gateContext = { ...ctx, log: (message) => log(redact(message)) };
  const kind = task.kind || 'code';
  const policy = testsPolicy.resolve(project, kind);
  if (policy.error) return safeResult(fail(policy.error), redact);
  const selected = require('../gate-commands').select(project, 'tests', args, policy.mode);
  if (selected.error) return safeResult(fail(selected.error, selected.config ? { config_failure: selected.config } : {}), redact);
  const cmd = selected.command;
  if (!task.sha) return safeResult(fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`), redact);
  const minutes = args.timeout == null ? timeouts.minutes(project, 'tests') : Number(args.timeout);
  if (!timeouts.valid(minutes)) return safeResult(fail(`--timeout must be a positive number of minutes within Node's timer range, got ${args.timeout}`), redact);
  const timeout = Math.round(minutes * 60 * 1000);
  const sha = task.sha;
  // A test command that ran and exited nonzero is a quality failure; a missing command, a timeout or a
  // signal is not, so it does not count toward escalation.
  const confirmed = (run) => (Number.isInteger(run.status) && ![0, 126, 127, 9009].includes(run.status)
    && !run.error && !killed(run) && !notFound(run) ? { confirmed_failure: true } : {});
  // A failure that also fails on the base is not the change's verdict: it retries like an infrastructure failure.
  // A merged hotfix has no worker to send it to, so it is reported as infrastructure and waits for main's fix.
  // A base rerun killed by a signal or stopped by the deadline never checked which names fail there, so it settles nothing either.
  const verdict = (run, main) => (main.flags.main_failure && task.hotfix ? { infrastructure_failure: true }
    : main.flags.main_failure || main.flags.base_rerun_killed || main.flags.base_rerun_timed_out ? {} : confirmed(run));
  // The automation retries a killed run once, the same as a timeout.
  const crashed = (run) => (killed(run) ? { runner_crash: true } : {});
  // A command that is not installed failed before the change was tested: the pinned command is wrong.
  const notInstalled = (run, key) => (notFound(run) ? { config_failure: { key } } : {});
  const res = (ok, summary, extra = {}) => safeResult({ ok, summary, sha, ...extra }, redact);
  const full = await resolveCommit(ctx, root, sha);
  if (!full) return res(false, `commit ${sha} is not in ${root}; fetch it (git fetch origin ${task.branch || '<branch>'}) and run the gate again`);
  // A test that also fails on the base branch is not this change's doing. The same command runs at the newest base,
  // and each name that fails there too is recorded, so automation retries once and the worker links the existing failure.
  // The newest base of a merged hotfix contains the merge, so a hotfix reruns at the merge's first parent instead.
  const onBase = async (command, failure, hostCommand = false) => {
    const names = failure.test_failure?.names || [];
    const baseSha = !names.length ? null
      : task.hotfix ? task.hotfix.base_sha || await resolveCommit(ctx, root, `${task.hotfix.merge_sha || sha}^1`)
        : await baseTip(ctx, root, project.base);
    if (!baseSha) return { flags: {}, note: '' };
    const base = await withWorktree(gateContext, root, baseSha, async (dir, scratchEnv) => {
      log(redact(`check tests: ${command} at ${short(baseSha)} (base, for the failing names)`));
      const env = { ...scratchEnv, TOWER_CRANE_TEST_EXCLUDE: JSON.stringify(project.tests?.host_only ?? []) };
      if (hostCommand) {
        Object.assign(env, project.tests?.host_env);
        delete env.TOWER_CRANE_TEST_EXCLUDE;
        return hostShell(command, { cwd: dir, env, timeout, keep: KEEP_CHARS });
      }
      return testShell(ctx, command, { cwd: dir, env, timeout, keep: KEEP_CHARS });
    });
    if (base.ok) return { flags: {}, note: '' };
    // The deadline stops the run with SIGTERM, so this test comes before the signal one.
    if (base.timedOut) {
      return { flags: { base_rerun_timed_out: { base: short(baseSha), minutes } },
        note: `Base rerun at ${short(baseSha)} timed out after ${minutes} min; shared failures were not checked.\n` };
    }
    if (killed(base)) {
      return { flags: { base_rerun_killed: { base: short(baseSha), signal: base.signal || null, status: base.status ?? null } },
        note: `Base rerun at ${short(baseSha)} was killed (${base.signal || `exit ${base.status}`}); shared failures were not checked.\n` };
    }
    const shared = testFailure(base, redact).names.filter((name) => names.includes(name));
    if (!shared.length) return { flags: {}, note: '' };
    // Only a run whose every failing name also fails on the base is not this change's; any new name keeps the verdict.
    const flags = shared.length === names.length ? { main_failure: { base: short(baseSha), names: shared } } : {};
    const where = task.hotfix ? `${short(baseSha)}, the merge's first parent` : short(baseSha);
    // Both commits are fixed, so a deterministic failure that predates the merge fails there forever; the owner's waiver ends it.
    const next = task.hotfix && flags.main_failure
      ? `Infrastructure: the hotfix stays submitted and opens no follow-up. Rerun tower-crane check tests ${task.id} when the environment recovers. `
        + `If these tests fail at ${short(baseSha)} every time, they failed before the merge: the owner can accept with tower-crane accept ${task.id} --waive tests --reason R.`
      : 'Link the existing failure rather than fixing unrelated code.';
    return { flags,
      note: `Also fails on ${project.base} at ${where}: ${shared.join(', ')}. ${next}\n` };
  };
  if (policy.mode === 'none') {
    return res(true, `Tests gate mode none (${policy.source}); verified submitted commit ${short(full)}. No test command ran.`);
  }
  const envError = hostEnvError(project.tests?.host_env);
  if (envError) return res(false, `project.json tests.host_env ${envError}`);
  const hostGlobs = project.tests?.host_only ?? [];
  if (!Array.isArray(hostGlobs) || !hostGlobs.every((p) => typeof p === 'string' && p.trim())) {
    return res(false, 'project.json tests.host_only must be an array of non-blank globs');
  }
  const hostMatchers = hostGlobs.map(globToRegExp);
  const isHost = (file) => hostMatchers.some((re) => re.test(file));
  let hostFiles = [];
  const hostReceipt = { run: [], skipped: [], unreported: [], results: [] };
  const hostTemplate = selected.policy.tests_proof_cmd || '';
  if (hostGlobs.length) {
    if (!hostTemplate.includes('{tests}')) return res(false, 'tests.host_only requires pinned gates.tests_proof_cmd containing {tests} for the separate host-only run',
      { config_failure: { key: 'tests_proof_cmd' } });
    const matcher = hostTestMatcher(project);
    if (matcher.error) return res(false, matcher.error);
    const tracked = await git(ctx, root, ['ls-tree', '-r', '--name-only', '-z', full]);
    if (!tracked.ok) return res(false, 'could not list host-only test files at the submitted head');
    hostFiles = tracked.stdout.split('\0').filter((file) => file && isHost(file) && matcher.match(file));
  }
  // A host-only command can start a live harness whose sandbox socket goes in TMPDIR, and a deep
  // gate scratch pushes that socket past the Unix path limit (lib/gate-tmp.js). Each such command
  // then gets a short TMPDIR of its own, unless tests.host_env names one. With no short base
  // writable, the gate refuses before running anything.
  let hostTmpBase = null;
  const tmpRoot = gateTmp.resolve(project, ctx.tmpEnv);
  if (hostFiles.length && process.platform === 'linux' && project.tests?.host_env?.TMPDIR == null
    && !gateTmp.harnessFits(path.join(tmpRoot.root, 'tower-crane-XXXXXX', 'tmp'))) {
    hostTmpBase = gateTmp.shortBase(ctx.tmpEnv ?? process.env);
    if (!hostTmpBase) {
      return res(false, `host-only tests need a TMPDIR of at most ${gateTmp.HARNESS_TMPDIR_MAX} bytes for the sandbox socket of a live harness; `
        + `the gate scratch under ${tmpRoot.root} (${tmpRoot.source}) is longer, and no short directory (${gateTmp.shortBases(ctx.tmpEnv ?? process.env).join(', ') || 'none'}) is writable. `
        + `Set gates.tmp_root or TOWER_CRANE_TMP to a shorter directory, or name a short TMPDIR in tests.host_env.`,
      { config_failure: { key: 'tmp_root' } });
    }
  }
  const hostShell = async (command, opts) => {
    if (!hostTmpBase || gateTmp.harnessFits(opts.env.TMPDIR)) return testShell(ctx, command, opts);
    let dir;
    try {
      dir = gateTmp.harnessTmp(hostTmpBase);
    } catch (e) {
      const message = `cannot create a short TMPDIR under ${hostTmpBase}: ${e.message}`;
      return { ok: false, status: null, signal: null, error: new Error(message), stdout: '', stderr: message, output: message };
    }
    log(redact(`check tests: host-only TMPDIR ${dir}, since the gate scratch ${opts.env.TMPDIR} is over ${gateTmp.HARNESS_TMPDIR_MAX} bytes`));
    try {
      return await testShell(ctx, command, { ...opts, env: { ...opts.env, TMPDIR: dir, TMP: dir, TEMP: dir } });
    } finally {
      removeTree(ctx, dir);
    }
  };
  const receiptWithHosts = (receipt = {}) => hostGlobs.length ? { ...receipt, host_only: hostReceipt } : receipt;
  const testRun = async (command, opts, files = hostFiles, record = false) => {
    const ordinaryEnv = { ...opts.env, TOWER_CRANE_TEST_EXCLUDE: JSON.stringify(hostGlobs) };
    const ordinary = await testShell(ctx, command, { ...opts, env: ordinaryEnv });
    if (!ordinary.ok) return ordinary;
    let output = ordinary.output ?? `${ordinary.stdout}\n${ordinary.stderr}`;
    for (const file of files.filter((file) => hostFiles.includes(file))) {
      const hostCommand = expand(hostTemplate, [file]);
      const env = { ...opts.env, ...project.tests?.host_env };
      delete env.TOWER_CRANE_TEST_EXCLUDE;
      log(redact(`check tests: host-only ${file}: ${hostCommand}`));
      const host = await hostShell(hostCommand, { ...opts, env });
      const counts = hostCounts(host);
      if (record) {
        const reasons = counts.skipped > 0 ? skipReasons(host, redact) : [];
        hostReceipt.results.push({ file, ...counts, ...(reasons.length ? { skip_reasons: reasons } : {}) });
        if (counts.ran > 0) hostReceipt.run.push(file);
        if (counts.skipped > 0) hostReceipt.skipped.push(file);
        if (counts.ran === null || counts.ran + counts.skipped === 0) hostReceipt.unreported.push(file);
      }
      output = keepTail(`${output}\n${host.output ?? `${host.stdout}\n${host.stderr}`}`, KEEP_CHARS);
      if (!host.ok) return { ...host, output, command: hostCommand, missing: notFound(host) };
    }
    return { ...ordinary, output };
  };
  const runOnly = async (mode, receipt) => {
    const out = await withWorktree(gateContext, root, full, async (dir, env) => {
      log(redact(`check tests: running ${cmd} at ${short(full)} (mode ${mode})`));
      const head = await testRun(cmd, { cwd: dir, env, timeout, keep: KEEP_CHARS }, hostFiles, true);
      if (head.timedOut) return { ...timeouts.failure(head, minutes, head.command ?? cmd, `at ${short(full)}`, redact), sha };
      if (!head.ok) {
        const failure = failedRun(head.command ?? cmd, head, `at ${short(full)}`, redact);
        const main = await onBase(head.command ?? cmd, failure, !!head.command);
        return res(false, `${failure.summary}\n${main.note}Make the tests pass at the submitted commit, then submit the new sha.`, {
          test_failure: failure.test_failure,
          ...verdict(head, main),
          ...crashed(head),
          ...notInstalled(head, head.command ? 'tests_proof_cmd' : 'tests_cmd'),
          ...main.flags,
        });
      }
      return res(true, `${cmdLine(cmd)} at ${short(full)}: exit 0\nTests gate mode ${mode} (${policy.source}); no revert run.${receipt ? `\nChanged files: ${receipt.changed_files.join(', ')}` : ''}`);
    });
    return safeResult({ ...out, sha, ...(receipt || hostGlobs.length ? { receipt: receiptWithHosts(receipt) } : {}) }, redact);
  };
  if (policy.mode === 'run-only') return runOnly('run-only');
  if (!project.base) return safeResult(fail('project.json has no base branch; set "base" (for example "main")'), redact);
  const matcher = testMatcher(project);
  if (matcher.error) return safeResult(fail(matcher.error), redact);
  const isTest = matcher.match;
  const keeper = keepMatcher(project);
  if (keeper.error) return safeResult(fail(keeper.error), redact);
  const keepBuildFile = keeper.match;
  const mb = await mergeBase(ctx, root, project.base, full, task);
  if (!mb) return res(false, `no merge base between ${project.base} and ${short(full)}; fetch ${project.base} (git fetch origin ${project.base}) and run the gate again`);
  const changed = await changedFiles(ctx, root, mb.sha, full);
  if (!changed) return res(false, `could not list the files ${short(full)} changed against ${mb.ref}; check the repository at ${root}`);

  // A deleted test guards nothing, so only added or changed tests count as the task's tests.
  const tests = changed.filter((f) => isTest(f.path) && f.status !== 'D');
  const nonTest = changed.filter((f) => !isTest(f.path));
  const buildFiles = nonTest.filter((f) => keepBuildFile(f.path));
  const against = `${mb.ref} (merge base ${short(mb.sha)})`;

  if (kind === 'code' && changed.length === 0) {
    return res(false, `${short(full)} has no changes against ${against}; submit the commit that holds the change`, { worker_failure: true });
  }
  const revert = nonTest.filter((f) => !keepBuildFile(f.path));
  if (changed.length > 0 && revert.length === 0) {
    return runOnly('run-only (test-only diff)', {
      mode: 'run-only (test-only diff)', changed_files: changed.map((f) => f.path),
      head_mode: 'full', head_reason: 'test-only diff runs the pinned head suite',
    });
  }
  if (kind === 'code' && tests.length === 0) {
    return res(false, `no test covers this change: ${short(full)} changes ${listSome(changed.map((f) => f.path))} against ${against} and adds or changes no test file (by ${matcher.source}). Add a test that fails without the change, commit it, and submit the new sha. If the project keeps its tests elsewhere, set their globs with tower-crane project set --tests-paths '["src/test/**","**/*Test.java"]'.`, task.hotfix ? { confirmed_failure: true } : { worker_failure: true });
  }

  const scoped = policy.expensive && tests.length > 0 && revert.length > 0;
  const proofTemplate = selected.policy.tests_proof_cmd || '';
  if (scoped && !proofTemplate.includes('{tests}')) {
    return res(false, 'tests.expensive in prove mode requires pinned gates.tests_proof_cmd containing {tests}; the orchestrator pins it with project set --tests-proof-cmd CMD', { config_failure: { key: 'tests_proof_cmd' } });
  }
  const proofCmd = scoped ? expand(proofTemplate, tests.map((f) => f.path)) : cmd;
  const tracked = await git(ctx, root, ['ls-tree', '-r', '--name-only', '-z', full]);
  if (!tracked.ok) return res(false, 'could not list test files at the submitted head');
  const headSelection = require('../tests-map').select(project, changed, (p) => isTest(p) && !isSupportFile(p), new Set(tracked.stdout.split('\0')), globToRegExp, task);
  const headCmd = headSelection.command || cmd;
  const headSummary = `Head suite mode ${headSelection.mode}: ${headSelection.reason}.`;
  const out = await withWorktree(gateContext, root, full, async (dir, env) => {
    const steps = [headSummary];
    log(redact(`check tests: ${headSummary} Running ${headCmd} at ${short(full)}`));
    const head = await testRun(headCmd, { cwd: dir, env, timeout, keep: KEEP_CHARS }, hostFiles, true);
    if (head.timedOut) return { ...timeouts.failure(head, minutes, head.command ?? headCmd, `at ${short(full)}`, redact), sha };
    if (!head.ok) {
      const failure = failedRun(head.command ?? headCmd, head, `at ${short(full)}`, redact);
      const main = await onBase(head.command ?? headCmd, failure, !!head.command);
      return res(false, `${headSummary}\n${failure.summary}\n${main.note}Make the tests pass at the submitted commit, then submit the new sha.`, {
        test_failure: failure.test_failure,
        ...verdict(head, main),
        ...crashed(head),
        ...notInstalled(head, head.command || headSelection.command ? 'tests_proof_cmd' : 'tests_cmd'),
        ...main.flags,
      });
    }
    steps.push(`1. ${cmdLine(headCmd)} at ${short(full)}: exit 0`);

    const unprovedHostTests = tests.filter((f) => hostFiles.includes(f.path) && !hostReceipt.run.includes(f.path));
    if (unprovedHostTests.length) {
      const results = unprovedHostTests.map((f) => hostReceipt.results.find((r) => r.file === f.path));
      const counted = results.map((r, i) => `${unprovedHostTests[i].path}: ${r?.ran == null ? 'no readable case counts'
        : `${r.ran} ran, ${r.skipped} skipped`}${r?.skip_reasons ? `; skipped because: ${r.skip_reasons.join('; ')}` : ''}`);
      const optIns = Object.keys(project.tests?.host_env ?? {});
      // A merged hotfix has no worker to send this to: when every file reported only skips, the host's
      // opt-ins decide, so it waits for the orchestrator's tests.host_env like a missing pin.
      const hostSetting = task.hotfix && results.every((r) => r?.ran === 0 && r.skipped > 0);
      return res(false, [`changed host-only tests skipped or did not report executed cases; they do not prove the change: ${unprovedHostTests.map((f) => f.path).join(', ')}`,
        ...counted,
        `tests.host_env gives host-only commands ${optIns.length ? optIns.join(', ') : 'no variables'}. Set the opt-ins the skip reasons name with tower-crane project set --tests-host-env JSON, then run tower-crane gates retry ${task.id}.`].join('\n'),
      hostSetting ? { config_failure: { key: 'tests_host_env' } } : {});
    }
    if (tests.length === 0) {
      return res(true, `${steps.join('\n')}\nTask kind ${kind} changes no test file, so there is nothing to run without the change.`);
    }
    const testList = `Tests: ${listSome(tests.map((f) => f.path))}`;
    const kept = buildFiles.length
      ? `Build files kept at submitted sha ${short(full)}: ${buildFiles.map((f) => f.path).join(', ')}`
      : '';
    if (scoped) {
      log(redact(`check tests: scoped proof ${proofCmd} at ${short(full)}`));
      const proofHead = await testRun(proofCmd, { cwd: dir, env, timeout, keep: KEEP_CHARS }, tests.map((f) => f.path));
      if (proofHead.timedOut) return { ...timeouts.failure(proofHead, minutes, proofHead.command ?? proofCmd, `scoped proof at ${short(full)}`, redact), sha };
      if (!proofHead.ok) {
        const failure = failedRun(proofHead.command ?? proofCmd, proofHead, `scoped proof at ${short(full)}`, redact);
        const main = await onBase(proofHead.command ?? proofCmd, failure, !!proofHead.command);
        return res(false, `${failure.summary}\n${main.note}`.trimEnd(), { test_failure: failure.test_failure, ...verdict(proofHead, main), ...crashed(proofHead),
          ...notInstalled(proofHead, 'tests_proof_cmd'), ...main.flags });
      }
      steps.push(`Scoped proof at ${short(full)}: ${cmdLine(proofCmd)}: exit 0`);
    }
    const restore = revert.filter((f) => f.status !== 'A').map((f) => f.path);
    const remove = revert.filter((f) => f.status === 'A').map((f) => f.path);
    if (restore.length) {
      const r = await git(ctx, dir, ['--literal-pathspecs', 'checkout', mb.sha, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: restore.join('\0'), env });
      if (!r.ok) return res(false, `could not restore ${listSome(restore)} to ${short(mb.sha)}: ${errText(r)}`);
    }
    if (remove.length) {
      const r = await git(ctx, dir, ['--literal-pathspecs', 'rm', '-q', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: remove.join('\0'), env });
      if (!r.ok) return res(false, `could not remove ${listSome(remove)} added by the task: ${errText(r)}`);
    }
    const revertedPaths = ` (${listSome(revert.map((f) => f.path))})`;
    const reverted = `${revert.length} non-test file${revert.length === 1 ? '' : 's'} reverted to ${short(mb.sha)}${revertedPaths}`;
    const revertSummary = [reverted, kept].filter(Boolean).join('; ');
    log(redact(`check tests: running ${proofCmd} with ${revertSummary}`));
    const without = await testRun(proofCmd, { cwd: dir, env, timeout, keep: KEEP_CHARS }, scoped ? tests.map((f) => f.path) : hostFiles);
    if (without.timedOut) return { ...timeouts.failure(without, minutes, without.command ?? proofCmd, `with ${revertSummary}`, redact), sha };
    if (without.ok) {
      steps.push(`2. ${cmdLine(proofCmd)} with ${revertSummary}: exit 0`);
      return res(false, `tests pass without the change; they do not prove it.\n${steps.join('\n')}\n${testList}\nWrite a test that fails when the change is reverted, commit it, and submit the new sha.`,
        task.hotfix ? { confirmed_failure: true } : {});
    }
    steps.push(`2. ${cmdLine(proofCmd)} with ${revertSummary}: ${how(without)}`);
    // A run killed by a signal did not reach its assertions, so it proves nothing either way.
    if (killed(without)) return res(false, `${steps.join('\n')}\n${testList}\nThe reverted run was interrupted, so it does not show the tests fail without the change.`, { runner_crash: true });
    return res(true, `${steps.join('\n')}\n${testList}\nThe tests pass with the change and fail without it, against ${against}.${scoped ? ' tests.expensive kept a scoped proof.' : ''}`);
  });
  return safeResult({ ...out, sha, receipt: receiptWithHosts({
    mode: 'prove', changed_files: changed.map((f) => f.path),
    head_mode: headSelection.mode, head_reason: headSelection.reason,
    ...(headSelection.tests ? { head_tests: headSelection.tests } : {}),
    ...(scoped ? { proof_tests: tests.map((f) => f.path) } : {}),
  }) }, redact);
}

module.exports = { run, plan, plannedCommands, hostFileCount, diagnosticRedactor, boundedOutputTail, isTestFile, isSupportFile, testMatcher, globToRegExp, hostEnvError, hostCounts, skipReasons, hostTestMatcher };
