'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file');

// Allocation and cleanup are under test; the benchmark suites need not run.
require('../../scripts/test-cost').measure = async () => {
  const dirs = fs.readFileSync(process.env.TC_SCRATCH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const scratch = dirs.find((dir) => path.basename(dir).startsWith('tower-crane-options-'));
  writeAtomic(process.env.TC_OPTIONS_STOP_LOG, JSON.stringify({
    scratch,
    fixture: fs.existsSync(path.join(scratch, 'options.test.cjs')),
    service: fs.existsSync(path.join(scratch, 'service.cjs')),
  }));
  throw new Error('option measurement stopped for scratch probe');
};
