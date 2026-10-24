'use strict';

// A fake host for the host governor (lib/governor.js): the /proc files and the
// cgroup tree it reads, under a directory TOWER_CRANE_HOST_ROOT names. Every
// CLI a test starts reads one, so no test depends on this machine's load.

const fs = require('node:fs');
const path = require('node:path');

const GiB = 1024 ** 3;
const SLICE = 'tests.slice';

// limit and used are the shared slice's, in GiB; cache is page cache inside
// used that the governor does not count.
// cores, when given, writes a /proc/stat listing that many CPUs whose times
// never move, so the test-thread budget reads its cores there and its other
// work from the load.
function writeHost(dir, { limit = 64, used = 1, cache = 0, high = null, memorySome = 0, memoryFull = 0, cpuSome = 0, load = 0, oomKill = 0, cores = null } = {}) {
  const write = (rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  };
  const kb = (gib) => Math.round(gib * GiB / 1024);
  const bytes = (gib) => String(Math.round(gib * GiB));
  // The host has room to spare, so the slice is the binding level.
  write('proc/meminfo', `MemTotal: ${kb(limit * 4)} kB\nMemFree: ${kb(limit * 3)} kB\nMemAvailable: ${kb(limit * 4 - used)} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`);
  write('proc/pressure/memory', `some avg10=${memorySome.toFixed(2)} avg60=0.00 avg300=0.00 total=0\nfull avg10=${memoryFull.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`);
  write('proc/pressure/cpu', `some avg10=${cpuSome.toFixed(2)} avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
  write('proc/loadavg', `${load.toFixed(2)} 0.00 0.00 1/100 1\n`);
  if (cores) write('proc/stat', `cpu  100 0 100 1000 0 0 0 0 0 0\n${Array.from({ length: cores }, (_, i) => `cpu${i} 10 0 10 100 0 0 0 0 0 0\n`).join('')}`);
  write('proc/self/cgroup', `0::/${SLICE}/run.scope\n`);
  const slice = `sys/fs/cgroup/${SLICE}`;
  write(`${slice}/memory.current`, `${bytes(used)}\n`);
  write(`${slice}/memory.max`, `${bytes(limit)}\n`);
  write(`${slice}/memory.high`, high == null ? 'max\n' : `${bytes(high)}\n`);
  write(`${slice}/memory.stat`, `anon ${bytes(used - cache)}\nactive_file 0\ninactive_file ${bytes(cache)}\n`);
  write(`${slice}/memory.events`, `low 0\nhigh 0\nmax 0\noom 0\noom_kill ${oomKill}\n`);
  write(`${slice}/run.scope/memory.current`, `${bytes(used)}\n`);
  write(`${slice}/run.scope/memory.max`, 'max\n');
  write(`${slice}/run.scope/memory.high`, 'max\n');
  write(`${slice}/run.scope/memory.stat`, `anon ${bytes(used - cache)}\nactive_file 0\ninactive_file ${bytes(cache)}\n`);
  return dir;
}

module.exports = { writeHost, GiB, SLICE };
