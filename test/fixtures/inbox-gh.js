'use strict';

const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.INBOX_GITHUB;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.calls.push(args);
let result;
if (data.fail || data.failEndpoint && args[1]?.includes(data.failEndpoint)) {
  console.error('GitHub unavailable');
  process.exitCode = 1;
} else if (args[0] === 'pr') {
  const pr = data.prs[args[2]];
  if (args[1] === 'merge') {
    if (args[args.indexOf('--match-head-commit') + 1] !== pr.headRefOid) throw new Error('head not pinned');
    pr.state = 'MERGED';
    pr.mergeCommit = { oid: pr.headRefOid };
  }
  result = pr;
} else if (/\/pulls\/\d+$/.test(args[1])) {
  const pr = data.prs[args[1].split('/').at(-1)];
  result = { head: { sha: pr.headRefOid }, base: { sha: pr.baseRefOid || 'b'.repeat(40) }, merge_commit_sha: pr.mergeRefOid || null };
} else if (args[1].includes('/git/commits/')) {
  const sha = args[1].split('/').at(-1);
  result = data.commits?.[sha] || { sha, parents: [] };
} else if (/\/issues\/\d+\/comments/.test(args[1])) {
  const number = /\/issues\/(\d+)\//.exec(args[1])[1];
  result = data.review_comments?.[number] || [];
  if (data.reviewDuringFetch) {
    const review = data.reviewDuringFetch;
    delete data.reviewDuringFetch;
    require('node:child_process').execFileSync(process.execPath, [
      require('node:path').join(__dirname, '..', '..', 'bin', 'tower-crane.js'),
      'evidence', review.task, '--type', 'review', '--ok', '--sha', review.sha,
      '--revision', String(review.revision), '--agent', 'replacement-reviewer',
    ], { stdio: 'pipe' });
  }
} else if (args[1].includes('/comments')) {
  result = data.comments || [];
} else if (args[1].includes('/code-scanning/')) {
  const ref = new URL(`https://api.github.com/${args[1]}`).searchParams.get('ref');
  const number = decodeURIComponent(args[1]).match(/refs\/pull\/(\d+)\//)?.[1];
  result = (data.alerts?.[number] || []).map((a) => ({ ...a,
    most_recent_instance: { ref: `refs/pull/${number}/head`, ...a.most_recent_instance },
  })).filter((a) => a.most_recent_instance.ref === ref);
} else {
  result = [{ name: 'test', suite: 1, id: 1, runs: 1, app: 'fixture',
    status: data.ci === 'pending' ? 'in_progress' : 'completed', conclusion: data.ci === 'pending' ? null : data.ci || 'success' }];
  if (args[1].includes('/check-runs') && data.revuto) result.push(data.revuto);
}
fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify(data));
fs.renameSync(`${file}.${process.pid}`, file);
if (Array.isArray(result)) {
  for (const row of result) console.log(JSON.stringify(row));
} else if (result !== undefined) console.log(JSON.stringify(result));
