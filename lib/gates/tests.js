'use strict';
// Prove keeps changed tests while reverting code; run-only checks the submitted head.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail, short, tailLines, stripEscapes, stripFor, redactJoined, joinOutputs, createRedactor, secretValue, how, killed, notFound, errText, git, shell, resolveCommit, mergeBase, baseTip, withWorktree, removeTree, listSome } = require('./common');
const gateTmp = require('../gate-tmp');
const testsPolicy = require('../tests-policy');
const { expand } = require('../tests-map');
const BaseTests = require('./tests-base');
const NativeCrash = require('../native-crash');

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
  const out = redactJoined(r, redact);
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
// failure, and each of the first three runs one more command per host-only file. Each of those
// commands can rerun its failing files once. The base can run one command per failing file.
// Run-only runs the head and the base. None runs no test command; gate-runs adds each probe's
// separate timeout budget.
function plannedCommands(project, kind, hostFiles = 0, baseFiles = 1) {
  const policy = testsPolicy.resolve(project, kind);
  if (policy.error || policy.mode === 'none') return 0;
  const run = 2 * (1 + hostFiles);
  // A caller can spend a command budget joining a holder that dies, then run itself.
  const baseBudgets = 2 * baseFiles;
  if (policy.mode === 'run-only') return run + baseBudgets;
  return run + (policy.expensive ? run : 0) + run + baseBudgets;
}

function baseFileCount(project, root, sha) {
  if (!root || !sha) return 1;
  const matcher = testMatcher(project);
  if (matcher.error) return 1;
  const result = require('../commands').spawnSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', '-z', sha], {
    encoding: 'utf8', maxBuffer: Infinity, timeout: 60000, windowsHide: true,
  });
  const files = result.status === 0 ? result.stdout.split('\0')
    : checkoutFiles(root, project.tests?.paths || ['**/']);
  return Math.max(1, files.filter((file) => file && matcher.match(file) && !isSupportFile(file)).length);
}

// The gate-run lease asks a gate module for this, when it exports it, before the lease's write.
function plan(project, root, task) {
  const policy = testsPolicy.resolve(project, task.kind || 'code');
  if (policy.error || policy.mode === 'none') return 0;
  return plannedCommands(project, task.kind || 'code', hostFileCount(project, root, task.sha), baseFileCount(project, root, task.sha));
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
  const output = stripFor(redact, result.output ?? `${result.stdout}\n${result.stderr}`);
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
async function testShell(ctx, command, opts) {
  const env = { ...(opts.env ?? process.env), TOWER_CRANE_SANDBOX: '0' };
  delete env.TOWER_CRANE_HOST_ONLY;
  delete env.NODE_TEST_CONTEXT;
  return { ...await shell(ctx, command, { ...opts, env }), testCwd: opts.cwd };
}

function interrupted(run) {
  return killed(run) || run.error?.code === 'ABORT_ERR';
}

// Wait shutdown can abort a command without a signal on Windows.
function crashed(run) {
  return { ...(interrupted(run) ? { runner_crash: true } : {}),
    ...(run.resource_reason ? { resource_reason: run.resource_reason, containment: run.containment } : {}) };
}

function probeFailureFlags(run) {
  const { runner_crash, ...resources } = crashed(run);
  // A probe deadline is a measurement failure; other interruptions get the suite's retry.
  return !run.timedOut && runner_crash ? { runner_crash, ...resources } : { worker_failure: true, ...resources };
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
  // A merged hotfix has no worker to send it to, and a host-only test the base fails the same way (sameFailure) fails
  // for the host, not the change, so both are reported as infrastructure and wait for main's or the host's fix.
  // A base rerun killed by a signal or stopped by the deadline never checked which names fail there, so it settles nothing either.
  const verdict = (run, main) => (main.infrastructure ? { infrastructure_failure: true }
    : main.flags.main_failure || main.flags.base_rerun_killed || main.flags.base_rerun_timed_out ? {} : confirmed(run));
  // What the worker does next, unless the failure is not the change's to fix.
  const fixIt = (main) => (main.infrastructure ? '' : 'Make the tests pass at the submitted commit, then submit the new sha.');
  // A command that is not installed failed before the change was tested: the pinned command is wrong.
  const notInstalled = (run, key) => (notFound(run) ? { config_failure: { key } } : {});
  const res = (ok, summary, extra = {}) => safeResult({ ok, summary, sha, ...extra }, redact);
  const full = await resolveCommit(ctx, root, sha);
  if (!full) return res(false, `commit ${sha} is not in ${root}; fetch it (git fetch origin ${task.branch || '<branch>'}) and run the gate again`);
  const probes = task.host_probes ?? [];
  if (!Array.isArray(probes) || !probes.every((cmd) => typeof cmd === 'string' && cmd.trim() && !cmd.includes('\0'))) {
    return res(false, 'task host_probes must be an array of non-blank commands without NUL bytes', { worker_failure: true });
  }
  const probeMinutes = timeouts.minutes(project, 'host_probe');
  const probeReceipt = [];
  const runProbes = async (dir, scratchEnv) => {
    for (const command of probes) {
      const env = { ...scratchEnv, ...project.tests?.host_env };
      delete env.TOWER_CRANE_TEST_EXCLUDE;
      log(redact(`check tests: host probe at ${short(full)}: ${command}`));
      const started = performance.now();
      const probe = await testShell(ctx, command, { cwd: dir, env, timeout: Math.round(probeMinutes * 60000), keep: KEEP_CHARS });
      const result = {
        command: redact(command),
        command_sha256: createHash('sha256').update(command).digest('hex'),
        status: probe.status ?? null, signal: probe.signal || null, timed_out: !!probe.timedOut,
        duration_ms: Math.round(performance.now() - started), timeout_min: probeMinutes,
        output_tail: boundedOutputTail(redactJoined(probe, redact)),
      };
      probeReceipt.push(result);
      if (!probe.ok) {
        const reason = probe.timedOut ? `timed out after ${probeMinutes} min` : probe.error ? redact(probe.error.message) : how(probe);
        return res(false, `Host probe \`${result.command}\` at ${short(full)}: ${reason}.\n${result.output_tail}`,
          probeFailureFlags(probe));
      }
    }
    return null;
  };
  // A test that also fails on the base branch is not this change's doing. Its files run at the newest base,
  // and each name that fails there too is recorded, so automation retries once and the worker links the existing failure.
  // The newest base of a merged hotfix contains the merge, so a hotfix reruns at the merge's first parent instead.
  // A host-only failure is the host's only when the base fails each shared name with the same first error line,
  // normalized as lib/gates/main-red.js compares CI failures. A file the task changed runs other code at the base,
  // where a generic line (a timeout, a data dump, a bare assertion header) can be another failure, so it does not count.
  const sameFailure = async (headRun, baseRun, baseSha, file, names) => {
    const MainRed = require('./main-red');
    const errors = (r) => new Map(MainRed.parseLog(redactJoined(r, redact)).map((t) => [t.name, t.error]));
    const head = errors(headRun);
    const atBase = errors(baseRun);
    const changed = !(await git(ctx, root, ['diff', '--quiet', '--no-ext-diff', baseSha, full, '--', file])).ok;
    return names.every((name) => {
      const line = MainRed.normalize(head.get(name));
      return line != null && line === MainRed.normalize(atBase.get(name)) && !(changed && MainRed.generic(head.get(name)));
    });
  };
  const onBase = async (command, failure, headRun) => {
    const hostCommand = !!headRun.hostFile;
    const names = failure.test_failure?.names || [];
    const baseSha = !names.length ? null
      : task.hotfix ? await resolveCommit(ctx, root, task.hotfix.base_sha || `${task.hotfix.merge_sha || sha}^1`)
        : await baseTip(ctx, root, project.base);
    if (!baseSha) return { flags: {}, note: '' };
    const started = Date.now();
    // Generated suites can report more files than the lease's tracked-file count.
    // Their selected commands share the original full base command's budget.
    const baseDeadline = started + timeout;
    const baseTimeout = () => ({ ok: false, status: null, signal: null, timedOut: true, stdout: '', stderr: '', output: '' });
    let files = hostCommand ? [headRun.hostFile]
      : BaseTests.failingFiles(redactJoined(headRun, redact), names, headRun.testCwd || root);
    const template = selected.policy.tests_proof_cmd;
    let fallback = files ? null : 'failing test locations are unknown';
    if (files && !hostCommand && !template?.includes('{tests}')) {
      files = null;
      fallback = 'the pinned runner has no file selector';
    }
    // The selector can build generated tests. Git trees cannot prove a reported
    // file will be absent after that build, even when the task first tracks it.
    const common = await git(ctx, root, ['rev-parse', '--git-common-dir']);
    const cacheRoot = path.join(gateTmp.root(project, ctx.tmpEnv), 'tests-base-cache',
      BaseTests.hash(common.ok ? path.resolve(root, common.stdout.trim()) : root));
    const receipt = { base: baseSha, mode: files ? 'files' : 'full', files: files || [],
      ...(fallback ? { fallback } : {}), results: [] };
    baseReceipt = receipt;
    const jobs = files ? files.map((file) => ({ file, command: hostCommand ? command : expand(template, [file]) }))
      : [{ file: null, command }];
    let base = { ok: true, status: 0, stdout: '', stderr: '', output: '' };
    const baseNames = new Set();
    for (const job of jobs) {
      const begin = Date.now();
      const remaining = baseDeadline - begin;
      if (remaining <= 0) {
        base = { ...base, ...baseTimeout() };
        break;
      }
      const cached = await BaseTests.cached({
        root: cacheRoot, sha: baseSha, command: [command, job.command],
        settingsHash: BaseTests.settings(project, hostCommand, ctx.tmpEnv), file: job.file,
        timeout: remaining, signal: ctx.signal,
        snapshot: (r) => ({ ok: r.ok, status: r.status, signal: null, stdout: '', stderr: '', output: redactJoined(r, redact) }),
        run: () => withWorktree(gateContext, root, baseSha, async (dir, scratchEnv) => {
          const budget = baseDeadline - Date.now();
          if (budget <= 0) return baseTimeout();
          log(redact(`check tests: base ${short(baseSha)} ${job.file || '(full command)'}: running ${job.command}`));
          const env = { ...scratchEnv, TOWER_CRANE_TEST_EXCLUDE: JSON.stringify(project.tests?.host_only ?? []) };
          if (hostCommand) {
            Object.assign(env, project.tests?.host_env);
            delete env.TOWER_CRANE_TEST_EXCLUDE;
            return hostShell(job.command, { cwd: dir, env, timeout: budget, keep: KEEP_CHARS });
          }
          return testShell(ctx, job.command, { cwd: dir, env, timeout: budget, keep: KEEP_CHARS });
        }),
      });
      receipt.results.push({ file: job.file, command: redact(job.command), cached: cached.cached, duration_ms: Date.now() - begin });
      for (const name of testFailure(cached.result, redact).names) baseNames.add(name);
      log(redact(`check tests: base ${short(baseSha)} ${job.file || '(full command)'}: ${cached.cached ? 'cached' : 'uncached'}`));
      base = { ...cached.result, ok: base.ok && cached.result.ok, ...joinOutputs(base, cached.result, KEEP_CHARS) };
      if (cached.result.timedOut || killed(cached.result) || cached.result.error || cached.result.status == null) break;
    }
    receipt.duration_ms = Date.now() - started;
    const baseNote = `Base rerun at ${short(baseSha)}: ${files ? files.join(', ') : `full command (${fallback})`}; `
      + `${receipt.results.filter((r) => r.cached).length} cached, ${receipt.results.filter((r) => !r.cached).length} attempted; ${receipt.duration_ms} ms.\n`;
    if (base.ok) return { flags: {}, note: baseNote };
    if (base.ok) return { flags: {}, note: '' };
    // The deadline stops the run with SIGTERM, so this test comes before the signal one.
    if (base.timedOut) {
      return { flags: { base_rerun_timed_out: { base: short(baseSha), minutes } },
        note: `${baseNote}Base rerun at ${short(baseSha)} timed out after ${minutes} min; shared failures were not checked.\n` };
    }
    if (killed(base)) {
      return { flags: { base_rerun_killed: { base: short(baseSha), signal: base.signal || null, status: base.status ?? null } },
        note: `${baseNote}Base rerun at ${short(baseSha)} was killed (${base.signal || `exit ${base.status}`}); shared failures were not checked.\n` };
    }
    const shared = [...baseNames].filter((name) => names.includes(name));
    if (!shared.length) return { flags: {}, note: baseNote };
    // Only a run whose every failing name also fails on the base is not this change's; any new name keeps the verdict.
    const flags = shared.length === names.length ? { main_failure: { base: short(baseSha), names: shared } } : {};
    const where = task.hotfix ? `${short(baseSha)}, the merge's first parent` : short(baseSha);
    const infrastructure = !!flags.main_failure
      && (!!task.hotfix || (hostCommand && await sameFailure(headRun, base, baseSha, headRun.hostFile, shared)));
    // Both commits are fixed, so a deterministic failure that predates the merge fails there forever; the owner's waiver ends it.
    const next = task.hotfix && flags.main_failure
      ? `Infrastructure: the hotfix stays submitted and opens no follow-up. Rerun tower-crane check tests ${task.id} when the environment recovers. `
        + `If these tests fail at ${short(baseSha)} every time, they failed before the merge: the owner can accept with tower-crane accept ${task.id} --waive tests --reason R.`
      : infrastructure
        ? `Infrastructure: the host-only test fails with the same error at ${short(baseSha)}, so the task stays submitted and is not reworked. `
          + `Fix it on ${project.base} or in the host environment; automation reruns the gate when ${project.base} moves, and tower-crane gates retry ${task.id} reruns it now. `
          + `If it cannot pass on this host, the owner can accept with tower-crane accept ${task.id} --waive tests --reason R.`
        : 'Link the existing failure rather than fixing unrelated code.';
    return { flags, infrastructure,
      note: `${baseNote}Also fails on ${project.base} at ${where}: ${shared.join(', ')}. ${next}\n` };
  };
  if (policy.mode === 'none') {
    if (!probes.length) return res(true, `Tests gate mode none (${policy.source}); verified submitted commit ${short(full)}. No test command ran.`);
    const envError = hostEnvError(project.tests?.host_env);
    if (envError) return res(false, `project.json tests.host_env ${envError}`);
    const out = await withWorktree(gateContext, root, full, async (dir, env) =>
      await runProbes(dir, env) || res(true, `Tests gate mode none (${policy.source}); verified submitted commit ${short(full)}. No test command ran; ${probes.length} host probes passed.`));
    return safeResult({ ...out, sha, receipt: { host_probes: probeReceipt } }, redact);
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
  // A failing head, scoped proof or host-only command reruns its failing files once in the same
  // checkout (docs/state.md#gate-reruns): a test that fails once and then passes is recorded as
  // flaky and does not send the task to rework, and one that fails twice keeps its verdict. No
  // relevance is read from the diff, since shared code can break a test in a file the change never
  // touches. A reverted run is meant to fail, so it reruns only when every failing test there shows
  // a native crash (lib/native-crash.js), which proves nothing either way. Each command reruns at
  // most once, which plannedCommands counts. Every crash seen is recorded as native_crash, so status
  // counts the ones that still failed too. Where apport keeps cores, each command runs with a raised
  // core limit, and a crashed child's core is read with gdb under the task's scratch; ctx.cores
  // replaces that setup in process.
  const cores = ctx.cores ?? (ctx.stateDir ? { dir: NativeCrash.coreDir(),
    keep: path.join(task.scratch || require('../agents').taskCache({ stateDir: ctx.stateDir, task: task.id, env: process.env }), 'native-cores') } : {});
  const reruns = { crashes: [], notes: [], runs: [], flaky: [] };
  const crashRun = async (start) => {
    const started = Date.now();
    const r = await start(cores.dir ? { cores: true } : {});
    const failed = !(r.ok || r.timedOut || killed(r) || r.error);
    const found = failed ? NativeCrash.find(redactJoined(r, redact), testFailure(r, redact).names) : { crashes: [], every: false };
    if (cores.dir) await NativeCrash.collect(found.crashes, { ...cores, since: started, timeout });
    reruns.crashes.push(...found.crashes);
    return { r, found, duration_ms: Date.now() - started };
  };
  const described = (crashes) => crashes.map((c) => `${c.test} (${c.signal}${c.pid != null ? `, pid ${c.pid}` : ''})${c.stack ? `, core stack ${c.stack[0]}`
    : c.core_error ? `, core not read: ${c.core_error}${c.core_file ? ` (kept at ${c.core_file})` : ''}` : ''}`).join('; ');
  // One record per test that failed on its own in the first run, with both runs' receipts.
  const flakyTests = (first, again, step, plan, command, cwd) => {
    const output = redactJoined(first.r, redact);
    const names = NativeCrash.leaves(output, testFailure(first.r, redact).names);
    const where = BaseTests.failingLocations(output, names, cwd);
    const errors = new Map(require('./main-red').parseLog(output).map((t) => [t.name, t.error]));
    const crashed = new Set(first.found.crashes.map((c) => c.test));
    const runOf = (run, cmd) => ({ command: redact(cmd), status: run.r.status ?? null, signal: run.r.signal || null, duration_ms: run.duration_ms });
    return (names.length ? names : [null]).map((name) => {
      const files = name == null ? null : where?.get(name);
      return {
        test: name == null ? (plan.files.join(' ') || redact(command)) : files?.length === 1 ? `${files[0]} > ${name}` : name,
        step, ...(files?.length ? { files } : {}), ...(crashed.has(name) ? { native_crash: true } : {}),
        first_failure: { ...runOf(first, command), error: (name != null && errors.get(name)) || null,
          excerpt: (name != null && NativeCrash.excerpt(output, name)) || boundedOutputTail(output, NativeCrash.EXCERPT_LINES, NativeCrash.EXCERPT_CHARS) },
        rerun: runOf(again, plan.command),
      };
    });
  };
  const rerunFailed = async (first, step, command, retry) => {
    const { r: failed, found } = first;
    if (!Number.isInteger(failed.status) || [0, 126, 127, 9009].includes(failed.status)
      || failed.timedOut || failed.error || killed(failed) || notFound(failed)) return failed;
    const at = found.crashes.length ? `Native crash: ${described(found.crashes)}. ` : '';
    if (step === 'reverted' && !(found.crashes.length && found.every)) {
      if (found.crashes.length) reruns.notes.push(`${at}Other tests in the run failed without one, so it was not rerun.`);
      return failed;
    }
    const plan = retry(redactJoined(failed, redact), testFailure(failed, redact).names, failed);
    const what = plan.files.length ? plan.files.join(', ') : `the whole command (${plan.reason})`;
    log(redact(`check tests: ${step} failed; rerunning ${what} once: ${plan.command}`));
    const again = await crashRun(plan.run);
    reruns.runs.push({ step, files: plan.files, ok: again.r.ok === true });
    if (again.r.ok) {
      const flaky = step === 'reverted' ? [] : flakyTests(first, again, step, plan, command, plan.cwd);
      reruns.flaky.push(...flaky);
      reruns.notes.push(`${at}Rerun: reran ${what} once in the same checkout: exit 0${flaky.length
        ? `; flaky: ${flaky.map((f) => f.test).join(', ')}` : ', so the crash is not the change\'s'}.`);
      return again.r;
    }
    const twice = again.found.crashes;
    reruns.notes.push(`${at}Rerun: reran ${what} once in the same checkout: ${how(again.r)}${twice.length ? `, native crash again: ${described(twice)}` : ''}; the failure stands.`);
    return failed;
  };
  const withReruns = (out) => (reruns.crashes.length || reruns.notes.length ? { ...out,
    summary: `${out.summary}\n${reruns.notes.join('\n')}`,
    ...(reruns.crashes.length ? { native_crash: reruns.crashes } : {}),
    ...(reruns.flaky.length ? { flaky: reruns.flaky } : {}) } : out);
  const rerunTemplate = selected.policy.tests_proof_cmd || '';
  let baseReceipt = null;
  const receiptWithHosts = (receipt = {}) => ({ ...receipt,
    ...(hostGlobs.length ? { host_only: hostReceipt } : {}),
    ...(probes.length ? { host_probes: probeReceipt } : {}),
    ...(baseReceipt ? { base_rerun: baseReceipt } : {}),
    ...(reruns.runs.length ? { reruns: reruns.runs } : {}) });
  const testRun = async (command, opts, files = hostFiles, record = false, step = 'head') => {
    const ordinaryEnv = { ...opts.env, TOWER_CRANE_TEST_EXCLUDE: JSON.stringify(hostGlobs) };
    const start = (cmd) => (more) => testShell(ctx, cmd, { ...opts, env: ordinaryEnv, ...more });
    const ordinary = await rerunFailed(await crashRun(start(command)), step, command, (output, names, failed) => {
      const failing = BaseTests.failingFiles(output, names, opts.cwd);
      // The kept tail can miss a failure printed before it, which a rerun of the named files would
      // never repeat.
      const reason = failed.truncated ? `the first run's output was cut to its last ${KEEP_CHARS} characters`
        : !failing ? 'the failing test locations are unknown'
        : !rerunTemplate.includes('{tests}') ? 'the pinned runner has no file selector (gates.tests_proof_cmd with {tests})' : null;
      if (reason) return { files: [], reason, command, cwd: opts.cwd, run: start(command) };
      const rerun = expand(rerunTemplate, failing);
      return { files: failing, command: rerun, cwd: opts.cwd, run: start(rerun) };
    });
    if (!ordinary.ok) return ordinary;
    let joined = { output: ordinary.output ?? `${ordinary.stdout}\n${ordinary.stderr}`, runs: ordinary.runs };
    for (const file of files.filter((file) => hostFiles.includes(file))) {
      const hostCommand = expand(hostTemplate, [file]);
      const env = { ...opts.env, ...project.tests?.host_env };
      delete env.TOWER_CRANE_TEST_EXCLUDE;
      log(redact(`check tests: host-only ${file}: ${hostCommand}`));
      const run = (more) => hostShell(hostCommand, { ...opts, env, ...more });
      const host = await rerunFailed(await crashRun(run), step === 'reverted' ? step : 'host', hostCommand,
        () => ({ files: [file], command: hostCommand, cwd: opts.cwd, run }));
      const counts = hostCounts(host);
      if (record) {
        const reasons = counts.skipped > 0 ? skipReasons(host, redact) : [];
        hostReceipt.results.push({ file, ...counts, ...(reasons.length ? { skip_reasons: reasons } : {}) });
        if (counts.ran > 0) hostReceipt.run.push(file);
        if (counts.skipped > 0) hostReceipt.skipped.push(file);
        if (counts.ran === null || counts.ran + counts.skipped === 0) hostReceipt.unreported.push(file);
      }
      joined = joinOutputs(joined, host, KEEP_CHARS);
      if (!host.ok) return { ...host, ...joined, command: hostCommand, hostFile: file, missing: notFound(host) };
    }
    return { ...ordinary, ...joined };
  };
  // The task's changed tests at head under V8 coverage (lib/tests-coverage.js): each gap, a changed
  // file no tests.map entry covers, must be among the files they ran. It runs the proof template on
  // the changed tests, never the head command, so a native crash rerun inside it is a proof step.
  const coverageRun = async (dir, env, tests, gaps) => {
    const paths = tests.map((f) => f.path);
    const command = expand(selected.policy.tests_proof_cmd, paths);
    const scratch = fs.mkdtempSync(path.join(env.TMPDIR || require('node:os').tmpdir(), 'coverage-'));
    try {
      log(redact(`check tests: coverage of ${paths.join(', ')} for ${gaps.join(', ')}: ${command}`));
      const run = await testRun(command, { cwd: dir, env: { ...env, NODE_V8_COVERAGE: scratch }, timeout, keep: KEEP_CHARS }, paths, false, 'proof');
      if (!run.ok) return { run, command };
      const ran = require('../tests-coverage').ranIn(scratch, dir);
      return { run, command, missed: gaps.filter((file) => !ran.has(file)) };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };
  // A coverage run that failed, or the gaps it left; null when it ran every gap.
  const coverageFailure = async (coverage, tests, where) => {
    const { run, command } = coverage;
    if (run.timedOut) return { ...timeouts.failure(run, minutes, run.command ?? command, where, redact), sha };
    if (!run.ok) {
      const failure = failedRun(run.command ?? command, run, where, redact);
      const main = await onBase(run.command ?? command, failure, run);
      return res(false, `${failure.summary}\n${main.note}`.trimEnd(), { test_failure: failure.test_failure, ...verdict(run, main), ...crashed(run),
        ...notInstalled(run, 'tests_proof_cmd'), ...main.flags });
    }
    return coverage.missed.length ? res(false, gapText(coverage.missed, tests), task.hotfix ? { confirmed_failure: true } : { worker_failure: true }) : null;
  };
  // crucialRun, in crucial mode, is {selection, tests}: the head runs the selection, and the changed
  // tests run again under coverage when the change has gaps.
  const runOnly = async (mode, receipt, crucialRun = null) => {
    const command = crucialRun?.selection.command || cmd;
    const out = await withWorktree(gateContext, root, full, async (dir, env) => {
      log(redact(`check tests: running ${command} at ${short(full)} (mode ${mode})`));
      const head = await testRun(command, { cwd: dir, env, timeout, keep: KEEP_CHARS }, hostFiles, true);
      if (head.timedOut) return { ...timeouts.failure(head, minutes, head.command ?? command, `at ${short(full)}`, redact), sha };
      if (!head.ok) {
        const failure = failedRun(head.command ?? command, head, `at ${short(full)}`, redact);
        const main = await onBase(head.command ?? command, failure, head);
        return res(false, `${failure.summary}\n${main.note}${fixIt(main)}`.trimEnd(), {
          test_failure: failure.test_failure,
          ...verdict(head, main),
          ...crashed(head),
          ...notInstalled(head, head.command || crucialRun ? 'tests_proof_cmd' : 'tests_cmd'),
          ...main.flags,
        });
      }
      const gaps = crucialRun?.selection.gaps || [];
      if (gaps.length) {
        const failed = await coverageFailure(await coverageRun(dir, env, crucialRun.tests, gaps), crucialRun.tests, `coverage run at ${short(full)}`);
        if (failed) return failed;
      }
      const probeFailure = await runProbes(dir, env);
      if (probeFailure) return probeFailure;
      const selection = crucialRun ? `\nHead suite mode crucial: ${crucialRun.selection.reason}.${gaps.length ? ` ${coveredText(gaps)}` : ''}` : '';
      return res(true, `${cmdLine(command)} at ${short(full)}: exit 0\nTests gate mode ${mode} (${policy.source}); no revert run.${selection}${receipt ? `\nChanged files: ${receipt.changed_files.join(', ')}` : ''}`);
    });
    return safeResult({ ...withReruns(out), sha, ...(receipt || hostGlobs.length || probes.length || baseReceipt || reruns.runs.length ? { receipt: receiptWithHosts(receipt) } : {}) }, redact);
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
  const selectHead = async () => {
    const tracked = await git(ctx, root, ['ls-tree', '-r', '--name-only', '-z', full]);
    if (!tracked.ok) return { error: 'could not list test files at the submitted head' };
    return require('../tests-map').select(project, changed, (p) => isTest(p) && !isSupportFile(p), new Set(tracked.stdout.split('\0')), globToRegExp, task);
  };
  // Crucial mode selects before the test-only shortcut, which would otherwise run the full suite.
  const crucial = require('../gate-commands').crucialMode(project);
  let headSelection = crucial ? await selectHead() : null;
  const selectionFailure = (selection) => res(false, selection.error,
    selection.mode === 'crucial' ? { config_failure: { key: 'tests_crucial' } } : {});
  if (headSelection?.error) return selectionFailure(headSelection);
  const gaps = headSelection?.gaps || [];
  const untested = () => res(false, gapText(gaps, []), task.hotfix ? { confirmed_failure: true } : { worker_failure: true });
  if (changed.length > 0 && revert.length === 0) {
    if (gaps.length && !tests.length) return untested();
    return runOnly('run-only (test-only diff)', {
      mode: 'run-only (test-only diff)', changed_files: changed.map((f) => f.path),
      ...(crucial ? selectionReceipt(headSelection, gaps.length ? tests : null)
        : { head_mode: 'full', head_reason: 'test-only diff runs the pinned head suite' }),
    }, crucial ? { selection: headSelection, tests } : null);
  }
  if (kind === 'code' && tests.length === 0) {
    return res(false, `no test covers this change: ${short(full)} changes ${listSome(changed.map((f) => f.path))} against ${against} and adds or changes no test file (by ${matcher.source}). Add a test that fails without the change, commit it, and submit the new sha. If the project keeps its tests elsewhere, set their globs with tower-crane project set --tests-paths '["src/test/**","**/*Test.java"]'.`, task.hotfix ? { confirmed_failure: true } : { worker_failure: true });
  }
  if (gaps.length && !tests.length) return untested();

  const scoped = policy.expensive && tests.length > 0 && revert.length > 0;
  const proofTemplate = selected.policy.tests_proof_cmd || '';
  if (scoped && !proofTemplate.includes('{tests}')) {
    return res(false, 'tests.expensive in prove mode requires pinned gates.tests_proof_cmd containing {tests}; the orchestrator pins it with project set --tests-proof-cmd CMD', { config_failure: { key: 'tests_proof_cmd' } });
  }
  const proofCmd = scoped ? expand(proofTemplate, tests.map((f) => f.path)) : cmd;
  headSelection ||= await selectHead();
  if (headSelection.error) return selectionFailure(headSelection);
  const headCmd = headSelection.command || cmd;
  const headSummary = `Head suite mode ${headSelection.mode}: ${headSelection.reason}.`;
  const out = await withWorktree(gateContext, root, full, async (dir, env) => {
    const steps = [headSummary];
    log(redact(`check tests: ${headSummary} Running ${headCmd} at ${short(full)}`));
    const head = await testRun(headCmd, { cwd: dir, env, timeout, keep: KEEP_CHARS }, hostFiles, true);
    if (head.timedOut) return { ...timeouts.failure(head, minutes, head.command ?? headCmd, `at ${short(full)}`, redact), sha };
    if (!head.ok) {
      const failure = failedRun(head.command ?? headCmd, head, `at ${short(full)}`, redact);
      const main = await onBase(head.command ?? headCmd, failure, head);
      return res(false, `${headSummary}\n${failure.summary}\n${main.note}${fixIt(main)}`.trimEnd(), {
        test_failure: failure.test_failure,
        ...verdict(head, main),
        ...crashed(head),
        ...notInstalled(head, head.command || headSelection.command ? 'tests_proof_cmd' : 'tests_cmd'),
        ...main.flags,
      });
    }
    steps.push(`1. ${cmdLine(headCmd)} at ${short(full)}: exit 0`);
    const probeFailure = await runProbes(dir, env);
    if (probeFailure) return probeFailure;

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
    if (scoped && gaps.length) {
      const failed = await coverageFailure(await coverageRun(dir, env, tests, gaps), tests, `scoped proof at ${short(full)}`);
      if (failed) return failed;
      steps.push(`Scoped proof at ${short(full)} under coverage: ${cmdLine(proofCmd)}: exit 0. ${coveredText(gaps)}`);
    } else if (scoped) {
      log(redact(`check tests: scoped proof ${proofCmd} at ${short(full)}`));
      const proofHead = await testRun(proofCmd, { cwd: dir, env, timeout, keep: KEEP_CHARS }, tests.map((f) => f.path), false, 'proof');
      if (proofHead.timedOut) return { ...timeouts.failure(proofHead, minutes, proofHead.command ?? proofCmd, `scoped proof at ${short(full)}`, redact), sha };
      if (!proofHead.ok) {
        const failure = failedRun(proofHead.command ?? proofCmd, proofHead, `scoped proof at ${short(full)}`, redact);
        const main = await onBase(proofHead.command ?? proofCmd, failure, proofHead);
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
    const without = await testRun(proofCmd, { cwd: dir, env, timeout, keep: KEEP_CHARS }, scoped ? tests.map((f) => f.path) : hostFiles, false, 'reverted');
    if (without.timedOut) return { ...timeouts.failure(without, minutes, without.command ?? proofCmd, `with ${revertSummary}`, redact), sha };
    if (without.ok) {
      steps.push(`2. ${cmdLine(proofCmd)} with ${revertSummary}: exit 0`);
      return res(false, `tests pass without the change; they do not prove it.\n${steps.join('\n')}\n${testList}\nWrite a test that fails when the change is reverted, commit it, and submit the new sha.`,
        task.hotfix ? { confirmed_failure: true } : {});
    }
    steps.push(`2. ${cmdLine(proofCmd)} with ${revertSummary}: ${how(without)}`);
    // A run killed by a signal did not reach its assertions, so it proves nothing either way.
    if (interrupted(without)) return res(false, `${steps.join('\n')}\n${testList}\nThe reverted run was interrupted, so it does not show the tests fail without the change.`, crashed(without));
    return res(true, `${steps.join('\n')}\n${testList}\nThe tests pass with the change and fail without it, against ${against}.${scoped ? ' tests.expensive kept a scoped proof.' : ''}`);
  });
  return safeResult({ ...withReruns(out), sha, receipt: receiptWithHosts({
    mode: 'prove', changed_files: changed.map((f) => f.path),
    ...(crucial ? selectionReceipt(headSelection, null) : {
      head_mode: headSelection.mode, head_reason: headSelection.reason,
      ...(headSelection.tests ? { head_tests: headSelection.tests } : {}),
    }),
    ...(scoped ? { proof_tests: tests.map((f) => f.path) } : {}),
  }) }, redact);
}

// The merge queue's head check in crucial mode runs what the tests gate selects for the change the
// task brings onto tip (tip...head), not the full suite. Null outside crucial mode and where the
// task's effective tests mode is not prove, since the tests gate then runs no selection either.
async function queueSelection(ctx, root, project, tip, head, kind) {
  if (!require('../gate-commands').crucialMode(project) || testsPolicy.resolve(project, kind || 'code').mode !== 'prove') return null;
  const matcher = testMatcher(project);
  if (matcher.error) return { error: matcher.error };
  const mb = await git(ctx, root, ['merge-base', tip, head]);
  const changed = mb.ok ? await changedFiles(ctx, root, mb.stdout.trim(), head) : null;
  if (!changed) return { error: `could not list the files ${short(head)} changes against ${short(tip)}` };
  const tracked = await git(ctx, root, ['ls-tree', '-r', '--name-only', '-z', head]);
  if (!tracked.ok) return { error: `could not list test files at ${short(head)}` };
  return require('../tests-map').select(project, changed, (p) => matcher.match(p) && !isSupportFile(p),
    new Set(tracked.stdout.split('\0')), globToRegExp, null);
}

// The receipt fields of a crucial head selection. proofTests, when given, are the changed tests a
// coverage run expanded the proof template with.
function selectionReceipt(selection, proofTests) {
  return { head_mode: selection.mode, head_reason: selection.reason, head_tests: selection.tests,
    ...(selection.gaps.length ? { coverage_gaps: selection.gaps } : {}),
    ...(selection.dropped ? { mapped_missing: selection.dropped } : {}),
    ...(proofTests ? { proof_tests: proofTests.map((f) => f.path) } : {}) };
}

function gapText(gaps, tests) {
  const files = listSome(gaps);
  const why = tests.length
    ? `and the task's changed tests (${listSome(tests.map((f) => f.path))}) do not run ${gaps.length === 1 ? 'it' : 'them'}`
    : 'and the task changes no test that could run it';
  return `coverage gap: no tests.map entry covers ${files}, ${why}. Add or change a test that runs each of these files, commit it, and submit the new sha. `
    + 'A file no test can run, such as documentation or data, needs a declared entry instead: the orchestrator adds it with tower-crane project set --tests-map.';
}

function coveredText(gaps) {
  return `Coverage: the changed tests ran ${listSome(gaps)}, which no tests.map entry covers.`;
}

module.exports = { run, plan, plannedCommands, queueSelection, hostFileCount, diagnosticRedactor, boundedOutputTail, isTestFile, isSupportFile, testMatcher, globToRegExp, hostEnvError, hostCounts, skipReasons, hostTestMatcher, probeFailureFlags };
