'use strict';

// node --test --test-global-setup=test/global-setup.js: one clean git seed for
// the whole run, passed to every test file through the environment.
const path = require('node:path');
const { createRepoSeed, cleanupRepoSeed } = require('./repo-seed');
const { writeHost } = require('./host');

let seed;

module.exports.globalSetup = function globalSetup() {
  seed = createRepoSeed();
  process.env.TC_TEST_REPO_SEED = seed.repo;
  // A CLI started with the runner's own environment reads a fake host with
  // room to spare too, so the runner's load never defers a test's work.
  process.env.TOWER_CRANE_HOST_ROOT = writeHost(path.join(seed.base, 'host'));
};

module.exports.globalTeardown = function globalTeardown() {
  if (seed) cleanupRepoSeed(seed);
};
