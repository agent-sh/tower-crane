'use strict';

// Test CLIs load this through NODE_OPTIONS or explicit --require args.
// lib/authority.js takes the default owner_config_dir from the
// account's home in the password database, which a fixture cannot set, so
// without this the tests would bind fixtures to the developer's real
// ~/.config/tower-crane and read the real owner key. Here the os module that
// lib/authority.js loads reports TC_ACCOUNT_HOME as that home. Only that
// module sees it: lib/gate-tmp.js reads the same home for a short socket
// path, which a deep fixture home would not give. Without TC_ACCOUNT_HOME
// the account has no home, so a stray call refuses instead of reaching the
// real one. A test that runs a gate on the default root sets TC_GATE_HOME,
// which lib/gate-tmp.js then sees as that home, so its fallback root is a
// fixture and not the developer's real cache.

const Module = require('node:module');
const path = require('node:path');
globalThis[Symbol.for('tower-crane.test-fixture')] = true;

// Every CLI fails when it resolves the user ladder file outside the test roots.
// Every CLI's write draws its sketch before it returns.
require('./render-inline');
require('./user-config-guard');
require('./no-fsync');

const AUTHORITY = path.join('lib', 'authority.js');
const GATE_TMP = path.join('lib', 'gate-tmp.js');
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  const mod = load.call(this, request, parent, ...rest);
  if (request !== 'node:os' && request !== 'os') return mod;
  const from = parent?.filename ?? '';
  if (from.endsWith(path.sep + AUTHORITY)) {
    return {
      ...mod,
      userInfo(options) {
        const home = process.env.TC_ACCOUNT_HOME;
        if (!home) throw new Error('TC_ACCOUNT_HOME is unset: the test account has no home');
        return { ...mod.userInfo(options), homedir: home };
      },
    };
  }
  if (from.endsWith(path.sep + GATE_TMP)) {
    return {
      ...mod,
      userInfo(options) {
        const home = process.env.TC_GATE_HOME;
        return home ? { ...mod.userInfo(options), homedir: home } : mod.userInfo(options);
      },
    };
  }
  return mod;
};
