'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { falseForEvent, jobConditions } = require('../lib/workflow-if');

test('a job condition proves an event skip only when it is false for that event whatever its other terms are', () => {
  for (const [condition, event, expected] of [
    ["github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository", 'push', true],
    ["github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository", 'pull_request', false],
    ["${{ github.event_name != 'push' }}", 'push', true],
    ["${{ github.event_name != 'push' }}", 'schedule', false],
    ["!(github.event_name == 'push' || github.event_name == 'schedule')", 'schedule', true],
    ["github.event_name == 'PULL_REQUEST'", 'push', true],
    ["github.event_name == 'pull_request' || always()", 'push', false],
    ["needs.changes.outputs.code == 'true'", 'push', false],
    ["github.event_name == 'push' && needs.changes.outputs.code == 'true'", 'push', false],
    ["contains(github.event.head_commit.message, 'skip') && github.event_name == 'pull_request'", 'push', true],
    ["github.event_name == 'pull_request' && ${{ inputs.x }}", 'push', false],
    ['false', 'push', true],
    ["github.event_name == 'pull_request' &&", 'push', false],
    ['', 'push', false],
    [null, 'push', false],
  ]) assert.equal(falseForEvent(condition, event), expected, `${condition} on ${event}`);
});

test('job conditions are found by job name, with expressions as wildcards, or by job id with a matrix suffix', () => {
  const yml = `name: CI
on: [push]
# jobs: in a comment is not the jobs key
jobs:
  checks:
    name: checks (shared files)
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - if: always()
        run: echo
  test:
    name: 'test (\${{ matrix.os }}, node \${{ matrix.node }})'
    if: >-
      github.event_name != 'pull_request'
      || github.event.pull_request.head.repo.full_name != github.repository
  lint:
    runs-on: ubuntu-latest
  build:
    if: github.event_name == 'schedule'
`;
  assert.deepEqual(jobConditions(yml, 'checks (shared files)'), ["github.event_name == 'pull_request'"]);
  assert.deepEqual(jobConditions(yml, 'test (ubuntu-latest, node 26)'),
    ["github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository"]);
  assert.deepEqual(jobConditions(yml, 'build'), ["github.event_name == 'schedule'"]);
  assert.deepEqual(jobConditions(yml, 'build (x)'), ["github.event_name == 'schedule'"]);
  // A job without a condition, or no matching job, proves nothing.
  assert.equal(jobConditions(yml, 'lint'), null);
  assert.equal(jobConditions(yml, 'deploy'), null);
  assert.equal(jobConditions('name: x\n', 'checks (shared files)'), null);
});
