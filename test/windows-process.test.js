'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { startTime } = require('./windows-process');
const { detachedAlive } = require('./helpers');

for (const [name, output, expected] of [
  ['vanished process', '', 'exited'],
  ['matching creation time', '133000000000000000', 'running'],
  ['reused PID', '133000000000000001', 'exited'],
]) {
  test(`Windows process probe: ${name}`, (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    const query = t.mock.method(cp, 'execFileSync', () => output);
    const child = { pid: 1234, startTime: '133000000000000000' };
    assert.equal(detachedAlive(child) ? 'running' : 'exited', expected);
    assert.equal(query.mock.callCount(), 1, 'one query reads the process and its creation time');
  });
}

// A tracked child without a creation time is the process with its PID only if
// that process started no later than its record, give or take a few clock ticks.
const recordedAt = 1760000000000;
const filetime = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
for (const [name, started, expected] of [
  ['started before its record', recordedAt - 5, 'running'],
  ['started within clock tolerance of its record', recordedAt + 50, 'running'],
  ['started after its record, a reused PID', recordedAt + 1000, 'exited'],
]) {
  test(`Windows process probe by record time: ${name}`, (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    t.mock.method(cp, 'execFileSync', () => filetime(started));
    assert.equal(detachedAlive({ pid: 1234, kind: 'monitor', recordedAt }) ? 'running' : 'exited', expected);
  });
}

test('Windows process probe keeps query failures visible', (t) => {
  const error = new Error('PowerShell failed');
  t.mock.method(cp, 'execFileSync', () => { throw error; });
  assert.throws(() => startTime(1234), (caught) => caught === error);
});

// The real script runs with GetProcessById replaced by a process that is
// gone, exiting or alive, so each outcome is reached on purpose.
for (const [name, processStub, expected] of [
  ['vanished process', "throw [System.ArgumentException]::new('process exited')", null],
  ['null StartTime', '$process = [pscustomobject]@{ Id = 1234; Handle = 1; StartTime = $null }', null],
  ['exiting StartTime getter', `
$process = [pscustomobject]@{ Id = 1234; Handle = 1 }
$process | Add-Member -MemberType ScriptProperty -Name StartTime -Value { throw [System.InvalidOperationException]::new('process exited') }
`, null],
  ['live process', '$process = [pscustomobject]@{ Id = 1234; Handle = 1; StartTime = [datetime]::FromFileTimeUtc(133000000000000000) }', '133000000000000000'],
]) {
  test(`PowerShell probe tolerates ${name}`, {
    skip: process.platform !== 'win32' && 'requires Windows PowerShell',
  }, (t) => {
    const execFileSync = cp.execFileSync;
    t.mock.method(cp, 'execFileSync', (command, args, options) => {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const stubbed = script.replace(
        '$process = [System.Diagnostics.Process]::GetProcessById(1234)',
        `${processStub}\n$process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}`,
      );
      assert.notEqual(stubbed, script);
      return execFileSync(command, [...args.slice(0, -1), Buffer.from(stubbed, 'utf16le').toString('base64')], options);
    });
    assert.equal(startTime(1234), expected);
  });
}
