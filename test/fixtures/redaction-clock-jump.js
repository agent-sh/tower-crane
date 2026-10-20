'use strict';

const { performance } = require('node:perf_hooks');
const now = performance.now.bind(performance);
let calls = 0;
// A descheduled scan can use its whole deadline between two clock readings.
performance.now = () => now() + 60000 * calls++;
