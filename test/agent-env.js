'use strict';

const path = require('node:path');

const ACCOUNT_HOME = path.join(__dirname, 'fixtures', 'account-home.js');
const ACCOUNT_HOME_OPTION = `--require "${ACCOUNT_HOME.replace(/\\/g, '/')}"`;

// Agent dispatch strips the host's Node options. This module has no fixture
// lifecycle hooks; test/helpers.js exports this same builder for test files.
function fakeAgentEnv(env = {}) {
  const rest = String(env.NODE_OPTIONS ?? '').replace(ACCOUNT_HOME_OPTION, '').trim();
  return { ...env, NODE_OPTIONS: rest ? `${ACCOUNT_HOME_OPTION} ${rest}` : ACCOUNT_HOME_OPTION };
}

module.exports = { fakeAgentEnv, ACCOUNT_HOME };
