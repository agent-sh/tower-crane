'use strict';

const fs = require('node:fs');
const { updateJson, readPublished } = require('../atomic-file');
const args = process.argv.slice(2);
const file = process.env.INBOX_GITHUB;
if (/^repos\/[^/]+\/[^/]+\/branches\//.test(args[1] || '')) {
  const data = JSON.parse(readPublished(file, 'utf8'));
  console.log(JSON.stringify({ sha: data.main_head || data.main_runs?.[0]?.head_sha || data.prs?.[7]?.headRefOid }));
  return;
}
// Base CI reads run alongside the PR reads, so they only append to their own call log
// and never rewrite the shared file a concurrent PR read updates.
if (/^repos\/[^/]+\/[^/]+\/actions\//.test(args[1] || '')) {
  const data = JSON.parse(readPublished(file, 'utf8'));
  fs.appendFileSync(`${file}.actions`, `${JSON.stringify(args)}\n`);
  const endpoint = args[1];
  const id = endpoint.split('/')[5];
  const print = (rows) => { for (const row of rows) console.log(JSON.stringify(row)); };
  if (data.fail || data.failActions) {
    console.error('GitHub unavailable');
    process.exitCode = 1;
  } else if (endpoint.includes('/actions/runs?')) print(data.main_runs || []);
  else if (endpoint.includes('/actions/workflows')) {
    print(data.workflows || [...new Set((data.main_runs || []).map((r) => r.workflow_id))].map((w) => ({ id: w, state: 'active' })));
  } else if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs/.test(endpoint)) print(data.jobs?.[`${id}/${endpoint.split('/')[7]}`] || data.jobs?.[id] || []);
  else if (/\/actions\/jobs\/\d+\/logs$/.test(endpoint)) {
    const text = data.logs?.[id];
    if (text === undefined) {
      console.error('HTTP 410: logs expired');
      process.exitCode = 1;
    } else if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text) && !args.includes('--allow-escape-sequences')) {
      console.error('the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway');
      process.exitCode = 1;
    } else process.stdout.write(text);
  }
  return;
}
// PR reads change the shared file under updateJson, so concurrent calls keep each other's changes.
let result;
let failed = false;
let review = null;
updateJson(file, (data) => {
  data.calls.push(args);
  answer(data);
  return data;
});
// The review lands while this fetch is in flight, after the lock is released: the
// evidence command may run gh, which takes the same lock.
if (review) {
  require('node:child_process').execFileSync(process.execPath, [
    require('node:path').join(__dirname, '..', '..', 'bin', 'tower-crane.js'),
    'evidence', review.task, '--type', 'review', '--ok', '--sha', review.sha,
    '--revision', String(review.revision), '--agent', 'replacement-reviewer',
  ], { env: require('../agent-env').fakeAgentEnv(process.env), stdio: 'pipe' });
}
if (failed) {
  console.error('GitHub unavailable');
  process.exitCode = 1;
} else if (Array.isArray(result)) {
  for (const row of result) console.log(JSON.stringify(row));
} else if (result !== undefined) console.log(JSON.stringify(result));

function answer(data) {
  if (data.fail || data.failEndpoint && args[1]?.includes(data.failEndpoint)) {
    failed = true;
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
      review = data.reviewDuringFetch;
      delete data.reviewDuringFetch;
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
}
