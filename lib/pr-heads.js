'use strict';

const C = require('./gates/common');

// Workflow reruns and multiple workflows at one head are one publication, not more pushes.
function countHeads(runs, { sha, branch, pr, previous }) {
  const since = previous ? Date.parse(previous.at) : null;
  const heads = new Set();
  if (!C.sameSha(sha, previous?.detail.sha)) heads.add(sha.toLowerCase());
  for (const run of runs) {
    if (!run || typeof run.head_branch !== 'string' || typeof run.event !== 'string') {
      throw new Error('invalid entry in PR head history');
    }
    if (run.head_branch !== branch || !['push', 'pull_request'].includes(run.event)) continue;
    if (run.pull_requests?.length && !run.pull_requests.some((p) => p.number === pr)) continue;
    if (!/^[a-f0-9]{40,64}$/i.test(run.head_sha || '')) throw new Error('invalid head SHA in PR head history');
    const at = Date.parse(run.created_at);
    if (!Number.isFinite(at)) throw new Error('invalid timestamp in PR head history');
    if (since !== null && at < since || C.sameSha(run.head_sha, previous?.detail.sha)) continue;
    heads.add(run.head_sha.toLowerCase());
  }
  return heads.size;
}

// GitHub's timeline omits ordinary pushes. Actions runs retain the PR heads they observed,
// including heads replaced before submit; the current PR head also counts before CI starts.
async function read(ctx, project, { task, sha, pr, events }) {
  if (!pr || !project.repo || project.ci?.local != null) return { count: null };
  try {
    const pull = await C.gh(ctx, ['pr', 'view', String(pr), '-R', project.repo, '--json', 'headRefName,headRefOid']);
    if (!pull.ok) throw new Error(C.ghFailure(pull, `gh pr view ${pr}`));
    const { headRefName: branch, headRefOid: head } = JSON.parse(pull.stdout);
    if (typeof branch !== 'string' || !branch || !/^[a-f0-9]{40,64}$/i.test(head || '') || !C.sameSha(head, sha)) {
      throw new Error('PR head history does not match the submitted head');
    }
    const previous = events.findLast((e) => e.cmd === 'submit' && e.task === task.id
      && e.detail.pr === pr && (!e.detail.branch || e.detail.branch === branch));
    // Ask GitHub from the whole second; countHeads applies the exact submit boundary.
    const since = previous ? new Date(previous.at).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
    const created = since ? `&created=${encodeURIComponent(`>=${since}`)}` : '';
    const endpoint = `repos/${project.repo}/actions/runs?branch=${encodeURIComponent(branch)}${created}&per_page=100`;
    const history = await C.gh(ctx, ['api', endpoint, '--paginate', '--jq',
      '.workflow_runs[] | {head_sha, head_branch, event, created_at, pull_requests}']);
    if (!history.ok) throw new Error(C.ghFailure(history, `gh api ${endpoint}`));
    const runs = history.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    return { count: countHeads(runs, { sha, branch, pr, previous }) };
  } catch (e) {
    if (/is not allowed by this agent's agent file/.test(e.message)) {
      return { count: null, note: "this agent's gh policy refuses PR head history; pushes_since_last_submit is unavailable" };
    }
    return { count: null, error: C.stripEscapes(e.message) };
  }
}

function warning({ count, error }) {
  if (error) return `warning: pushes_since_last_submit unavailable: ${error}`;
  if (count > 1) return `warning: ${count} observed pushed heads since the last submit; inspect the history for delayed runs or engine or orchestrator pushes`;
  return null;
}

module.exports = { countHeads, read, warning };
