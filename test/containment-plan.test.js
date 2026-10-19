'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { harnessArgv } = require('./containment-plan');

test('harness assertions preserve arguments across containment backends', () => {
  const runner = path.join(__dirname, '..', 'lib', 'containment-runner.js');
  const limits = '{"tasks_max":64,"memory_max_bytes":536870912,"fleet":false}';
  const unit = 'tower-crane-123-0123456789abcdef.scope';
  const prompt = 'first line\n"quoted" %PATH% $VAR\nlast line\\';
  for (const harness of [
    ['claude', '-p', prompt],
    ['codex', 'exec', '-p', 'fixture', 'resume', 'recorded-id', prompt],
    [process.execPath, 'fixture.cjs', prompt, ''],
    ['pi', '-p', 'containment-runner.js', prompt],
  ]) {
    for (const prefix of [
      [],
      [process.execPath, runner, limits, `@${unit}:agents.slice`, unit],
      [process.execPath, runner, limits, '/sys/fs/cgroup/agents.slice/parent.scope', unit],
      ['systemd-run', '--user', '--scope', '-p', 'MemoryMax=536870912', '--', process.execPath, runner, limits, '', unit],
    ]) assert.deepEqual(harnessArgv([...prefix, ...harness]), harness, JSON.stringify(prefix));
  }
});
