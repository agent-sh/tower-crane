'use strict';

// Loaded into every CLI the tests run, through NODE_OPTIONS (test/helpers.js
// baseEnv). lib/authority.js takes the default owner_config_dir from the
// account's home in the password database, which a fixture cannot set, so
// without this the tests would bind fixtures to the developer's real
// ~/.config/tower-crane and read the real owner key. Here the os module that
// lib/authority.js loads reports TC_ACCOUNT_HOME as that home. Only that
// module sees it: lib/gate-tmp.js reads the same home for a short socket
// path, which a deep fixture home would not give. Without TC_ACCOUNT_HOME
// the account has no home, so a stray call refuses instead of reaching the
// real one.

const Module = require('node:module');
const path = require('node:path');

const AUTHORITY = path.join('lib', 'authority.js');
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  const mod = load.call(this, request, parent, ...rest);
  if ((request !== 'node:os' && request !== 'os') || !parent?.filename?.endsWith(path.sep + AUTHORITY)) return mod;
  return {
    ...mod,
    userInfo(options) {
      const home = process.env.TC_ACCOUNT_HOME;
      if (!home) throw new Error('TC_ACCOUNT_HOME is unset: the test account has no home');
      return { ...mod.userInfo(options), homedir: home };
    },
  };
};
