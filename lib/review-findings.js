'use strict';

const C = require('./gates/common');
const { refuse } = require('./util');

const finding = (line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[^\]]+\]\s+)?`?[\w./\\-]+:\d+(?:-\d+)?`?\s+-\s+\S/.test(line);

function count(body = '') {
  const text = body.replace(/```[\s\S]*?```/g, '');
  const lines = text.split(/\r?\n/).filter(finding).length;
  const stated = /\b(\d+)\s+(?:blocking\s+)?(?:findings?|blockers?)\b/i.exec(text)
    || /\bblocking\s*:\s*(\d+)\b/i.exec(text);
  return lines || stated ? Math.max(lines, stated ? Number(stated[1]) : 0) : null;
}

function atHead(body, sha) {
  if (typeof body !== 'string' || !body.trimStart().startsWith('Review (Tower Crane')) return false;
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex(finding);
  const header = (first < 0 ? lines : lines.slice(0, first)).join('\n');
  return (header.match(/\b[a-f0-9]{7,64}\b/gi) || []).some((commit) => C.sameSha(commit, sha));
}

function target(ctx, st, task, review) {
  let repo = st.project.repo;
  let pr = task.pr;
  let commentId = null;
  if (review.ref) {
    let url;
    try { url = new URL(review.ref); } catch { throw refuse('review ref is not a GitHub comment URL'); }
    const host = ctx.env?.GH_HOST || 'github.com';
    const match = /^\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.host !== host || !match
      || url.hash && !/^#issuecomment-\d+$/.test(url.hash)) {
      throw refuse('review ref must identify a PR or issue comment on the configured GitHub host');
    }
    if (repo && repo.toLowerCase() !== match[1].toLowerCase()
      || pr && pr !== Number(match[2])) throw refuse('review ref does not match the task repository and PR');
    repo ||= match[1];
    pr ||= Number(match[2]);
    commentId = /^#issuecomment-(\d+)$/.exec(url.hash)?.[1] || null;
  }
  if (!repo || !pr) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some((part) => ['.', '..'].includes(part))) {
    throw refuse('review repository must be owner/name');
  }
  return { repo, pr, commentId };
}

async function resolve(ctx, st, task, review) {
  const fallback = { body: review.summary || '', ref: review.ref || null,
    finding_count: count(review.summary), source: 'evidence' };
  const where = target(ctx, st, task, review);
  if (!where) return fallback;
  const endpoint = `repos/${where.repo}/issues/${where.pr}/comments?per_page=100`;
  const result = await C.gh({ root: ctx.cwd }, ['api', endpoint, '--paginate', '--jq', '.[]']);
  if (!result.ok) throw refuse(C.ghFailure(result, `fetch review comments for ${task.id}`));
  let comments;
  try { comments = result.stdout.split('\n').filter((line) => line.trim()).flatMap((line) => JSON.parse(line)); }
  catch { throw refuse(`cannot read review comments for ${task.id}`); }
  if (where.commentId && !comments.some((c) => String(c?.id) === where.commentId && atHead(c?.body, task.sha))) {
    throw refuse(`${task.id}: linked review comment does not identify ${task.sha}; repair its review ref or comment`);
  }
  const comment = comments.findLast((c) => atHead(c?.body, task.sha));
  if (!comment) {
    if (review.ref) throw refuse(`${task.id}: no Review (Tower Crane) comment at ${task.sha}; keep the task submitted and repair its review ref or comment`);
    return fallback;
  }
  if (/\b(?:no|zero|0) blocking (?:findings|issues)\b|\bblocking\s*:\s*0\b|\bverdict\s*:\s*(?:pass|ok)\b/i.test(comment.body)) {
    throw refuse(`${task.id}: the latest comment at ${task.sha} reports no blocking review; refresh its evidence`);
  }
  return { body: comment.body, ref: comment.html_url || review.ref || null,
    finding_count: count(comment.body), source: 'comment' };
}

module.exports = { count, resolve };
