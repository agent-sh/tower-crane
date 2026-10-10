'use strict';

// node --test --test-global-setup=test/global-setup.js: one clean git seed for
// the whole run, passed to every test file through the environment.
const { createRepoSeed, cleanupRepoSeed } = require('./repo-seed');

let seed;

module.exports.globalSetup = function globalSetup() {
  seed = createRepoSeed();
  process.env.TC_TEST_REPO_SEED = seed.repo;
};

module.exports.globalTeardown = function globalTeardown() {
  if (seed) cleanupRepoSeed(seed);
};
