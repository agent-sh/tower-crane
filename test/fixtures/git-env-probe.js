'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOOK_GIT_ENV_REPORT, JSON.stringify({
  args,
  ownerKeyPresent: Object.hasOwn(process.env, 'TOWER_CRANE_OWNER_KEY'),
}) + '\n');
const result = spawnSync('git', args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
