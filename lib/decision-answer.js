'use strict';

function format(decision, heading = `decision ${decision.id} answered: ${decision.answer}`) {
  if (!decision.note) return heading;
  const lines = decision.note.split(/\r\n|\r|\n/).length;
  const choiceLine = decision.answer.split(/\r\n|\r|\n/)[0];
  const notice = lines > 1 || decision.note.length > choiceLine.length
    ? ` (answer has a note with ${lines} lines)` : '';
  const firstBreak = heading.search(/[\r\n]/);
  const end = firstBreak < 0 ? heading.length : firstBreak;
  return `${heading.slice(0, end)}${notice}${heading.slice(end)}\nOrchestrator note:\n${decision.note}`;
}

function section(decisions, task) {
  const answered = decisions.filter((d) => d.status === 'answered' && d.blocks.includes(task));
  return answered.length ? [
    `## Decision answers ${task}`,
    ...answered.map((d) => format(d)),
  ].join('\n\n') : '';
}

module.exports = { format, section };
