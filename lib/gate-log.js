'use strict';
const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const T = require('./tasks');
const Logs = require('./gates/test-log');
const { refuse, usage } = require('./util');

function log(ctx) {
  const type = ctx.flags.type ?? 'tests';
  if (type !== 'tests') throw usage('gate log supports --type tests');
  const phase = ctx.flags.run ?? 'head';
  if (!['head', 'base', 'scoped', 'reverted'].includes(phase)) throw usage('gate log --run must be head, base, scoped or reverted');
  const st = S.loadState(ctx.stateDir);
  const task = T.getTask(st, ctx.pos[0]);
  // Rework advances the revision; the failed run remains the task's latest log.
  const evidence = task.evidence.findLast((e) => e.type === type && T.eligibleGateEvidence(task, e, st.events)
    && e.receipt?.test_logs?.length);
  if (!evidence) throw refuse(`${task.id} has no stored tests log; rerun the tests gate to create one`);
  const refs = evidence.receipt.test_logs.filter((r) => r.phase === phase);
  if (!refs.length) throw refuse(`${task.id} has no ${phase} tests log in its latest run`);
  const prefix = `logs/tests-${task.id}-`;
  const texts = refs.map((ref) => {
    if (!ref.log) throw refuse(`could not save ${task.id}'s ${phase} tests log: ${ref.log_error || 'unknown error'}`);
    if (!ref.log.startsWith(prefix) || ref.log.split('/').some((p) => p === '..')
      || path.extname(ref.log) !== '.log') throw refuse('invalid tests log path in evidence');
    const file = path.join(ctx.stateDir, ref.log);
    let fd;
    try {
      const root = fs.realpathSync(path.join(ctx.stateDir, 'logs'));
      if (!fs.realpathSync(file).startsWith(root + path.sep)) throw refuse('tests log is outside the log directory');
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > Logs.LOG_BYTES) throw refuse('invalid stored tests log');
      const bytes = Buffer.alloc(Logs.LOG_BYTES);
      return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw refuse(`stored tests log ${ref.log} is missing or was pruned; rerun the gate`);
      throw e;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
  const selected = ctx.flags.test;
  const hasTest = selected !== undefined;
  const block = hasTest && texts.flatMap(Logs.blocks).find((b) => b.name === selected);
  if (hasTest && !block) throw refuse(`no failing test named ${JSON.stringify(selected)} in ${task.id}'s ${phase} log`);
  const text = hasTest ? block.block : texts.join('\n');
  return { data: { task: task.id, type, run: phase, logs: refs, ...(hasTest ? { test: selected } : {}), output: text }, text };
}

module.exports = { log };
