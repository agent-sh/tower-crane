'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { makeProjectRepo, BIN, ROOT, run } = require('./helpers');

test('Windows CI runs ancestry regressions without the one-time PR base probe', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(workflow, /probe-windows-ancestry\.js/);
});

test('Windows provider discovery reaches owner authority without individual parent lookups', (t) => {
  const h = makeProjectRepo(t);
  const result = run(['project', 'set', '--merge-admin', 'true'], {
    cwd: h.repo,
    pre: ['--require', path.join(__dirname, 'fixtures', 'windows-ancestry.js')],
    env: { ...h.env, TOWER_CRANE_AGENT: 'orchestrator', ANCESTRY_PROVIDER_SNAPSHOT: '1' },
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /merge\.admin is owner-required; opened D1/);
  assert.equal(h.readState('project.json').merge?.admin, undefined);
  assert.equal(h.readState('decisions.json').decisions.length, 1);
  assert.equal(h.readState('tasks.json').orchestrator_lease.pid, process.pid);
});

test('Windows orchestrator discovery waits for one snapshot and binds the persistent caller', {
  skip: process.platform !== 'win32' && 'requires PowerShell and Windows process discovery',
}, async (t) => {
  const h = makeProjectRepo(t);
  const file = (name) => path.join(h.base, name);
  const gate = `Local\\tower-crane-${crypto.randomUUID()}`;
  const rows = [
    { ProcessId: process.pid, ParentProcessId: 123456, Name: 'cmd.exe', CommandLine: 'cmd.exe /c node tower-crane.js' },
    { ProcessId: 123456, ParentProcessId: 123457, Name: 'pwsh.exe', CommandLine: 'pwsh.exe -Command node tower-crane.js' },
    { ProcessId: 123457, ParentProcessId: 0, Name: 'node.exe', CommandLine: 'node harness.js' },
    { ProcessId: 123458, ParentProcessId: 0, Name: 'unrelated.exe', CommandLine: 'x'.repeat(1024 * 1024) },
  ].map(row => ({ ...row, CreationDate: '2026-10-12T00:00:00Z' }));
  fs.writeFileSync(file('rows.json'), JSON.stringify(rows));
  // Watch before starting the CLI. Readiness is a file signal; release is a
  // native event, and command completion is the child process's close signal.
  const watcher = fs.watch(h.base);
  t.after(() => watcher.close());
  const ready = new Promise(resolve => {
    const check = () => { if (fs.existsSync(file('ready'))) resolve(); };
    watcher.on('change', check);
    check();
  });
  const child = cp.spawn(process.execPath, [
    '--require', path.join(__dirname, 'fixtures', 'windows-ancestry.js'),
    BIN, 'task', 'add', '--title', 'Snapshot caller', '--acceptance', 'works',
  ], { cwd: h.repo, env: {
    ...h.env, TOWER_CRANE_AGENT: 'orchestrator', ANCESTRY_GATE: gate,
    ANCESTRY_ROWS: file('rows.json'), ANCESTRY_CALLS: file('calls'),
    ANCESTRY_READY: file('ready'), ANCESTRY_OPTIONS: file('options.json'),
  } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await Promise.race([ready, closed.then(code => { throw new Error(`CLI exited before snapshot readiness: ${code}: ${stderr}`); })]);
  watcher.close();
  const signal = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$gate=[Threading.EventWaitHandle]::OpenExisting($env:ANCESTRY_GATE); try { $null=$gate.Set() } finally { $gate.Dispose() }',
  ], { env: { ...h.env, ANCESTRY_GATE: gate }, windowsHide: true });
  const signaled = await new Promise((resolve, reject) => {
    signal.once('error', reject);
    signal.once('close', resolve);
  });
  assert.equal(signaled, 0, 'snapshot release signal failed');
  assert.equal(await closed, 0, stderr);
  assert.match(stdout, /T1/);
  assert.equal(fs.readFileSync(file('calls'), 'utf8').split('query').length - 1, 1,
    'discovery must use one consistent snapshot, not a CIM round trip per parent');
  assert.equal(h.readState('tasks.json').orchestrator_lease.pid, 123457);
  assert.equal(JSON.parse(fs.readFileSync(file('options.json'))).timeout, 60000);
});
