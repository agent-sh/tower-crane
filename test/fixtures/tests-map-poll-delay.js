'use strict';

const path = require('node:path');
const { writeAtomic } = require('../atomic-file');
const S = require('../../lib/state');
const mutate = S.mutate;
let delayed = false;

// Advance time at the locked callback boundary to reproduce a delayed follower.
S.mutate = (ctx, cmd, fn, ...args) => mutate(ctx, cmd, (st, ...rest) => {
  if (cmd === 'tests map poll' && !delayed && process.env.TC_MAP_POLL_DELAY) {
    delayed = true;
    const delay = JSON.parse(process.env.TC_MAP_POLL_DELAY);
    writeAtomic(process.env.HOOK_CLOCK_FILE, String(delay.now));
    if (delay.read_at != null) S.writeAtomic(path.join(ctx.stateDir, 'tests-map-cache.json'),
      JSON.stringify({ repo: st.project.repo, base: st.project.base, read_at: delay.read_at }));
  }
  return fn(st, ...rest);
}, ...args);
