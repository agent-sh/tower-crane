'use strict';

// A write hands the sketch to a renderer process of its own and returns
// (lib/render.js later). In a test process the write waits for that process
// instead, so a test reads the sketch of the write it just made and no
// renderer outlives its fixture. HOOK_ASYNC_RENDER=1 leaves the renderer
// running on its own, as the CLI does.

const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

// Any test process that writes starts one: a CLI command, a supervisor.
if (!process.env.HOOK_ASYNC_RENDER && ['tower-crane.js', 'spawn-monitor.js'].includes(path.basename(process.argv[1] || ''))) {
  const spawn = cp.spawn;
  cp.spawn = function renderInline(command, args, options) {
    if (!Array.isArray(args) || path.basename(String(args[0] || '')) !== 'render-worker.js') return spawn.call(this, command, args, options);
    const r = cp.spawnSync(command, args, { ...options, detached: false, stdio: 'ignore' });
    return Object.assign(new EventEmitter(), { pid: r.pid, exitCode: r.status, unref() {} });
  };
}
