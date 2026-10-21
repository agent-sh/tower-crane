'use strict';

const assert = require('node:assert/strict');
const { dispatch } = require('../helpers');

// The live sandbox probe and its CPU launcher regression use the same dispatch contract.
async function run(t, h, options) {
  const pending = dispatch(t, h, { args: ['spawn', '--task', 'T1', '--wait'], ...options });
  const result = await pending.run;
  assert.equal(result.code, 0, `gate probe dispatch exited ${result.code}: ${result.stderr}`);
}

module.exports = { run };
