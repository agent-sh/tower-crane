'use strict';

const C = require('./gates/common');
const { refuse, usage } = require('./util');
const path = require('node:path');

function parse(value) {
  let findings;
  try { findings = JSON.parse(value); } catch { throw usage('--findings must be a JSON array'); }
  if (!Array.isArray(findings) || !findings.length || !findings.every((f) => f && typeof f === 'object'
    && ['kind', 'path', 'claim'].every((key) => typeof f[key] === 'string' && f[key].trim())
    && Object.keys(f).every((key) => ['kind', 'path', 'claim'].includes(key)))) {
    throw usage('--findings needs every blocker as {kind, path, claim} in a non-empty JSON array');
  }
  return findings;
}

function changelogPath(file) {
  return file === 'CHANGELOG.md' || typeof file === 'string' && /^changelog\.d\/[\w.-]+\.md$/.test(file);
}

// The reviewer labels every blocker; missing or mixed metadata stays a full review.
function proseOnly(findings) {
  return Array.isArray(findings) && findings.length > 0 && findings.every((f) =>
    f?.kind === 'false-claim' && (f.path === 'PR body' || changelogPath(f.path))
    && typeof f.claim === 'string' && !!f.claim.trim());
}

// An area is a file. Locations such as `PR body` name prose outside the
// tree, and a repeated prose correction is not a design problem.
const fileArea = (area) => typeof area === 'string' && !/\s/.test(area) && !['.', '..'].includes(area);

function areas(body = '', findings) {
  if (Array.isArray(findings) && findings.length) {
    return [...new Set(findings.map((f) => path.posix.normalize(f.path.trim().replace(/\\/g, '/'))))]
      .filter(fileArea).sort();
  }
  const text = (body || '').replace(/```[\s\S]*?```/g, '').replace(/\*\*|`/g, '');
  const found = new Set();
  const label = /^\s*(?:#{1,6}\s*)?blocking(?:\s+findings)?\s*(?::|$)/i;
  const structured = /^\s*Review \(Tower Crane/m.test(text) || text.split(/\r?\n/).some((line) => label.test(line));
  let blocking = !structured;
  let sectionLevel = 0;
  let detail = null;
  let findingIndent = 0;
  const add = (line) => {
    const match = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[^\]]+\]\s+)?((?:\.?[\\/])?[\w.-]+(?:[\\/][\w.-]+)*):\d+(?:-\d+)?\s+-\s+\S/.exec(line);
    if (!match) return;
    const indent = /^\s*/.exec(line)[0].length;
    const listed = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
    if (detail && (indent > findingIndent || detail === 'subsection' && !listed)) return;
    detail = null;
    findingIndent = indent;
    found.add(path.posix.normalize(match[1].replace(/\\/g, '/')));
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^\s*(#{1,6})\s+/.exec(line);
    if (label.test(line)) {
      blocking = true;
      sectionLevel = heading?.[1].length || 0;
      detail = null;
    } else if (/^\s*(?:#{1,6}\s*)?(?:follow[- ]?ups|non[- ]?blocking)\b/i.test(line)) {
      blocking = false;
    } else if (heading) {
      if (blocking && sectionLevel && heading[1].length > sectionLevel) detail = 'subsection';
      else blocking = false;
    } else if (/^\s*(?:steps to reproduce|repro(?:duction)?(?: steps)?|verification|tests|checks)\s*:/i.test(line)) {
      detail = 'label';
    }
    if (!blocking) continue;
    const summary = /^\s*\d+\s+(?:blocking\s+)?(?:findings?|blockers?)\s*:\s*(.*)$/i.exec(line);
    if (summary) summary[1].split(/;\s*/).forEach(add);
    else add(line);
  }
  return [...found].sort();
}

function repeatedAreas(task, events) {
  // A hold needs two failed reviews; skip the event scan for the many tasks without them.
  if ((task.evidence || []).filter((e) => e.type === 'review' && e.ok === false).length < 2) return [];
  // `events` is the log or a snapshot's indexed reads of it (st.log); only the task's own events count.
  const ruling = require('./tasks').taskEvents(events, task.id, ['task note', 'task update']).findLast((e) => e.cmd === 'task note' && e.detail.kind === 'scope-ruling'
    || e.cmd === 'task update' && e.detail.closed_acceptance === true);
  const counts = new Map();
  const reviews = [];
  for (const review of task.evidence.slice(ruling?.detail.review_after || 0)) {
    if (review.type !== 'review' || review.ok !== false
      || review.revision < (ruling?.detail.revision || 0)
      || !require('./tasks').eligibleGateEvidence(task, review, events)) continue;
    // Reviewers re-dispatched at an unchanged head judge the same commit, so
    // one (commit, revision) is one failure however many reviewers fail it.
    let verdict = reviews.find((v) => v.revision === review.revision && C.sameSha(v.sha, review.sha));
    if (!verdict) {
      verdict = { revision: review.revision, sha: review.sha, seen: new Set() };
      reviews.push(verdict);
    }
    const seen = verdict.seen;
    for (const area of review.areas || areas(review.summary, review.findings)) {
      if (!fileArea(area) || seen.has(area)) continue;
      seen.add(area);
      counts.set(area, (counts.get(area) || 0) + 1);
    }
  }
  return [...counts].filter(([, count]) => count >= 2).map(([area]) => area).sort();
}

function redesign(task, events) {
  const repeated = repeatedAreas(task, events);
  return repeated.length ? {
    areas: repeated,
    reason: `${repeated.join(', ')}: two failed reviews in the same area; narrow acceptance to a closed list with task update --closed-acceptance, or record a design change with task note --kind scope-ruling`,
  } : null;
}

const finding = (line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[^\]]+\]\s+)?`?[\w./\\-]+:\d+(?:-\d+)?`?\s+-\s+\S/.test(line);

// Only the orchestrator can correct a PR body on a submitted task. In-repo
// prose needs a new head, so it goes through rework and its next review.
function bodyOnly(findings) {
  return proseOnly(findings) && findings.every((f) => f.path === 'PR body');
}

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

module.exports = { count, resolve, parse, proseOnly, bodyOnly, changelogPath, areas, repeatedAreas, redesign };
