'use strict';
// Per-harness confinement: what a worker rung on each harness gets (dry run).
const fs = require('node:fs');
const path = require('node:path');
const { H, rec, save } = require('./lib');

const h = H.makeRepo();
try {
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'x']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe\n' });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const n of ['claude', 'codex', 'opencode', 'agy', 'pi']) fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...h.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const set = (harness) => h.run(['ladder', 'set', 'medium', '--harness', harness, '--model', 'fixture', '--clear', 'profile', '--clear', 'effort', '--clear', 'args'], { env });
  for (const harness of ['claude', 'codex', 'opencode', 'agy', 'pi']) {
    const s = set(harness);
    const d = h.run(['spawn', '--task', 'T1', '--dry-run', '--json'], { env });
    let seen = d.stderr.trim();
    let shims = false;
    let brokered = false;
    if (d.code === 0) {
      const j = JSON.parse(d.stdout);
      shims = /\/bin["']?:/.test(d.stdout) || Object.keys(j.env || {}).some((k) => k.toUpperCase() === 'PATH');
      brokered = Object.keys(j.env || {}).includes('TOWER_CRANE_BROKER') || !!j.home?.agent_file;
      seen = `env keys: ${Object.keys(j.env || {}).join(', ')}; home: ${j.home ? j.home.path.replace(h.base, '<scratch>') : 'none'}; agent file: ${j.home?.agent_file ? path.basename(j.home.agent_file) : 'none'}`;
    }
    const sandboxed = ['claude', 'codex'].includes(harness);
    rec(`H-${harness}`, 'sandbox/shims', `ladder set medium --harness ${harness} (as owner: ladder.reach) then spawn --task T1 --dry-run`,
      sandboxed ? 'agent home with agent file, git/gh shims on PATH, sandbox settings' : 'documented: no sandbox, no broker, no shims; only the owner can move a worker here (ladder.reach)',
      `ladder set exit ${s.code}; ${seen}`, sandboxed ? (brokered ? 'held' : 'CONFIRMED') : 'by design');
    void shims;
  }
  const w = h.run(['ladder', 'set', 'medium', '--harness', 'opencode', '--model', 'fixture', '--agent', 'orchestrator'], { env: { ...env, TOWER_CRANE_AGENT: 'orchestrator' } });
  rec('H-reach', 'sandbox/authority', 'TOWER_CRANE_AGENT=orchestrator tower-crane ladder set medium --harness opencode', 'refused: owner-required ladder.reach (decision opened)',
    `exit ${w.code}; ${w.stderr.trim()}`, w.code !== 0 ? 'held' : 'CONFIRMED');
} finally {
  save('harnesses');
  fs.rmSync(h.base, { recursive: true, force: true });
}
