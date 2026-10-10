'use strict';

// Shared by the stack-*.test.js files. Only GitHub is stubbed (fixtures/stack-gh.js);
// worktrees, commits, fetches and the bare remote are real.

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, copyRepo, BIN } = require('./helpers');

function worker(f) {
  const script = path.join(f.h.base, 'worker.js');
  fs.writeFileSync(script, `const fs = require('node:fs');
const cp = require('node:child_process');
const bin = ${JSON.stringify(BIN)};
const task = process.env.TOWER_CRANE_TASK;
const cli = (args) => cp.execFileSync(process.execPath, [bin, ...args], {encoding: 'utf8'});
const git = (args) => cp.execFileSync('git', args, {encoding: 'utf8'}).trim();
cli(['claim', task]);
const state = JSON.parse(cli(['task', 'show', task, '--json']));
fs.writeFileSync(task + '.txt', task + '\\n');
git(['add', task + '.txt']);
git(['commit', '-qm', task]);
git(['push', 'origin', state.branch]);
const sha = git(['rev-parse', 'HEAD']);
const file = process.env.TEST_STACK_DATA;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.prs[12] = {number: 12, state: 'OPEN', headRefOid: sha, headRefName: state.branch,
  baseRefName: state.stack.base, isCrossRepository: false, autoMergeRequest: null};
fs.writeFileSync(file, JSON.stringify(data));
process.stdout.write(cli(['submit', task, '--sha', sha, '--pr', '12']));
`);
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
}

// Each test gets its own copy of a repository built once per file, since
// building it costs about 30 processes and the copy two: setup() starts with
// a bare remote, T1 submitted as PR 11 from its worktree and T2 depending on
// it; stacked() adds T2 submitted as PR 12 on T1's branch and linked.
const templates = {};
test.after(async () => { for (const t of Object.values(templates)) await t.h.cleanup(); });

function template(name) {
  if (!templates[name]) {
    if (name === 'stacked') {
      const f = copy(null, template('lower'));
      templates[name] = { ...f, upper: upper(f) };
    } else {
      const h = makeRepo();
      const remote = path.join(h.base, 'remote.git');
      h.git(['init', '--bare', remote]);
      h.git(['remote', 'add', 'origin', remote]);
      h.git(['push', 'origin', 'main']);
      h.init(['--repo', 'acme/app']);
      fs.writeFileSync(path.join(h.base, 'github.json'), JSON.stringify({ repo: h.repo, prs: {}, calls: [], order: [], linked: false }));
      const f = fixture(h);
      f.add('lower');
      const lower = h.json(['worktree', 'T1']);
      const sha = f.submit('T1', 11, lower);
      f.add('upper', 'T1');
      templates[name] = { ...f, lower, sha };
    }
  }
  return templates[name];
}

// Copies a template and moves what names its directory: the remote URL,
// worktree links, worktree events and the gh stub's recorded paths.
function copy(t, from) {
  const h = copyRepo(t, from.h.base);
  // Both separators, since git reports Windows paths with forward slashes.
  const forms = (p) => [p, p.replaceAll('\\', '/')].map((s) => JSON.stringify(s).slice(1, -1));
  const [olds, news] = [forms(from.h.base), forms(h.base)];
  for (const file of [path.join(h.state, 'events.jsonl'), path.join(h.base, 'github.json')]) {
    let text = fs.readFileSync(file, 'utf8');
    olds.forEach((old, i) => { text = text.split(old).join(news[i]); });
    fs.writeFileSync(file, text);
  }
  h.git(['remote', 'set-url', 'origin', path.join(h.base, 'remote.git')]);
  const worktrees = path.join(h.base, 'repo-worktrees');
  h.git(['worktree', 'repair', ...fs.readdirSync(worktrees).map((name) => path.join(worktrees, name))]);
  const moved = (wt) => ({ ...wt, path: path.join(h.base, path.relative(from.h.base, wt.path)) });
  const f = { ...fixture(h), lower: moved(from.lower), sha: from.sha };
  if (from.upper) f.upper = { ...from.upper, wt: moved(from.upper.wt) };
  return f;
}

const setup = (t) => copy(t, template('lower'));
const stacked = (t) => copy(t, template('stacked'));

function fixture(h) {
  const file = path.join(h.base, 'github.json');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (fn) => { const d = read(); fn(d); fs.writeFileSync(file, JSON.stringify(d)); };
  h.env.TEST_STACK_DATA = file;
  h.env.NODE_OPTIONS = `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'stack-gh.js'))}`;
  const add = (title, dep) => {
    const task = h.json(['task', 'add', '--title', title, '--kind', 'docs', '--acceptance', 'works', ...(dep ? ['--dep', dep] : [])]);
    h.ok(['brief', 'set', task.id, '-'], { input: `# ${task.id}\n\n## Worker\nBuild the change.\n` });
    return task.id;
  };
  const submit = (id, pr, wt) => {
    fs.writeFileSync(path.join(wt.path, `${id}.txt`), `${id}\n`);
    h.git(['add', `${id}.txt`], wt.path);
    h.git(['commit', '-qm', id], wt.path);
    h.git(['push', 'origin', wt.branch], wt.path);
    const sha = h.git(['rev-parse', 'HEAD'], wt.path);
    write((d) => { d.prs[pr] = { number: pr, state: 'OPEN', headRefOid: sha, headRefName: wt.branch,
      baseRefName: h.json(['task', 'show', id]).stack?.base || 'main', isCrossRepository: false, autoMergeRequest: null }; });
    h.ok(['claim', id, '--agent', `worker-${id}`]);
    h.ok(['submit', id, '--sha', sha, '--branch', wt.branch, '--pr', String(pr), '--agent', `worker-${id}`]);
    return sha;
  };
  const accept = (id) => h.ok(['accept', id, '--waive', 'review', '--waive', 'ci', '--reason', 'offline stack fixture']);
  return { h, read, write, add, submit, accept };
}

function upper(f) {
  const wt = f.h.json(['worktree', 'T2']);
  const sha = f.submit('T2', 12, wt);
  f.h.ok(['stack', 'link', 'T2']);
  return { wt, sha };
}

function resubmit(f, rewrite) {
  f.h.ok(['rework', 'T1', '--reason', 'more lower work']);
  fs.writeFileSync(path.join(f.lower.path, 'T1b.txt'), 'T1b\n');
  f.h.git(['add', 'T1b.txt'], f.lower.path);
  f.h.git(rewrite ? ['commit', '--amend', '-qm', 'T1 rewritten'] : ['commit', '-qm', 'T1 more'], f.lower.path);
  f.h.git(['push', 'origin', `${rewrite ? '+' : ''}${f.lower.branch}`], f.lower.path);
  const sha = f.h.git(['rev-parse', 'HEAD'], f.lower.path);
  f.write((d) => { d.prs[11].headRefOid = sha; });
  f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
  f.h.ok(['submit', 'T1', '--sha', sha, '--branch', f.lower.branch, '--pr', '11', '--agent', 'worker-T1']);
  return sha;
}

module.exports = { worker, setup, stacked, upper, resubmit };
