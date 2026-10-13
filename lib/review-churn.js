'use strict';

const T = require('./tasks');
const { shaMatch } = require('./util');

function failures(task, events) {
  // Rework increments the actual revision by one. Stack retries may preserve
  // an older previous_revision for review context, skipping scope changes.
  const reworks = new Set(events.filter((e) => e.task === task.id && e.cmd === 'rework')
    .map((e) => e.detail.revision));
  const revisions = new Set([task.revision]);
  let revision = task.revision;
  while (revision > 1 && reworks.has(revision)) {
    revision -= 1;
    revisions.add(revision);
  }
  return task.evidence.filter((e) => {
    if (e.type !== 'review' || e.ok !== false || e.waived || !revisions.has(e.revision)) return false;
    // A later worker may have reviewed an earlier head. Independence belongs
    // to the submission the verdict checked, not to the latest submitter.
    const dispatch = events.findLastIndex((event) => event.task === task.id && event.cmd === 'spawn'
      && event.detail.role === 'reviewer' && event.detail.agent === e.agent && event.detail.revision === e.revision
      && event.at <= e.at && shaMatch(event.detail.sha, e.sha));
    const submit = events.findLast((event, index) => event.task === task.id && event.cmd === 'submit'
      && (dispatch >= 0 ? index < dispatch : event.at <= e.at) && shaMatch(event.detail.sha, e.sha));
    return T.eligibleGateEvidence({ ...task, submitted_by: submit?.agent || task.submitted_by }, e, events);
  });
}

function count(task, events) {
  return failures(task, events).length;
}

function history(task, events, project) {
  const seenLines = new Set();
  const seenLocations = new Set();
  let previous;
  const reviews = failures(task, events).map((e) => {
    const summary = e.summary || '';
    const acceptance_lines = [...new Set([...summary.matchAll(/\b(?:acceptance(?:\s+(?:item|line))?|AC)\s*#?\s*(\d+)\b/gi)]
      .map((m) => Number(m[1])).filter((n) => n > 0 && n <= task.acceptance.length))].sort((a, b) => a - b);
    const finding_locations = [...new Set([...summary.matchAll(/(?:^|\s|`)([\w./\\-]+:\d+(?:-\d+)?)(?=`|\s|$)/g)].map((m) => m[1]))];
    const new_acceptance_lines = acceptance_lines.filter((n) => !seenLines.has(n));
    const new_finding_locations = finding_locations.filter((s) => !seenLocations.has(s));
    // Free-text findings cannot establish scope unless they name acceptance
    // lines or finding locations. Keep that uncertainty visible.
    const scope_change = !previous ? 'first'
      : acceptance_lines.length && previous.acceptance_lines.length
        ? new_acceptance_lines.length ? 'added_acceptance_lines' : 'same_acceptance_lines'
        : finding_locations.length && previous.finding_locations.length
          ? new_finding_locations.length ? 'added_finding_locations' : 'same_finding_locations'
          : 'unknown';
    for (const n of acceptance_lines) seenLines.add(n);
    for (const s of finding_locations) seenLocations.add(s);
    previous = { at: e.at, sha: e.sha, revision: e.revision, reviewer: e.agent, ref: e.ref || null,
      findings: summary.replace(/\s+/g, ' ').trim(), acceptance_lines, new_acceptance_lines,
      finding_locations, new_finding_locations, scope_change };
    return previous;
  });
  return { revision: task.revision, count: reviews.length, churn_after: require('./reviewer').churnAfter(project), reviews };
}

module.exports = { count, history };
