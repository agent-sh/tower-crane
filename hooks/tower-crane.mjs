// Tower Crane for Claude Code: pushes orchestrator wake-ups into the session.
// One child, tower-crane wait --follow, prints a line of ids per event; this
// module turns those lines into prompts, so the session never polls. A push
// names events only: the session reads current findings with tower-crane inbox.

const TOOL = 'mcp__tower-crane__watch'
const COMMAND = 'tower-crane-watch'

// The same text lib/events.js notice() gives spawned harness homes.
function notice(rows, agent) {
  const lines = rows.map(w => `- ${w.id}: ${w.type}${w.decision ? ` ${w.decision}` : ''}${w.task ? ` ${w.task}` : ''} from ${w.agent}`)
  const last = rows.at(-1)
  return [
    `Tower Crane: ${rows.length} new event${rows.length === 1 ? '' : 's'} for ${agent}.`,
    ...lines,
    `Run \`tower-crane inbox\` for findings and resolving commands.${last?.offset ? ` Cursor: ${last.offset}.` : ''}`,
  ].join('\n')
}

// One module instance per session load: what it watches and what waits.
const live = { watch: null, pending: [], steered: [], submitting: false, turn: null }

// A prompt queues until the session is idle and resolves as its turn
// starts, so what arrives meanwhile goes out together in the next one.
async function flush($) {
  if (live.submitting) return
  live.submitting = true
  try {
    while (live.pending.length && live.watch) {
      const batch = live.pending.splice(0)
      await $.prompt.submit({ text: notice(batch, live.watch.agent) })
    }
  } finally {
    live.submitting = false
  }
}

// A steer joins the running turn at its next model request. A turn that
// makes no further request never read it, so turn.complete queues it again.
async function deliver($, w) {
  if (w.steer && live.turn) {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: notice([w], live.watch.agent) }] } })
    if (!appended?.deny) {
      live.steered.push({ w, step: live.turn.steps })
      return
    }
  }
  live.pending.push(w)
  void flush($)
}

async function follow($, current, child) {
  let buffer = ''
  let stderr = ''
  try {
    for await (const { stream, text } of child) {
      if (live.watch !== current) break
      if (stream === 'stderr') {
        stderr = (stderr + text).slice(-2000)
        continue
      }
      buffer += text
      let end
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let w
        try {
          w = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof w.offset === 'number') current.cursor = String(w.offset)
        if (w.type !== 'ready' && w.id) await deliver($, w)
      }
    }
  } catch (e) {
    stderr ||= String(e?.message || e)
  }
  if (live.watch !== current) return
  live.watch = null
  const why = stderr.trim().split('\n').at(-1)
  $.ui.toast(`Tower Crane stopped watching${why ? `: ${why}` : ''}. Run /${COMMAND} to resume.`)
}

async function arm($, input = {}) {
  const agent = input.agent || (await $.env.get('TOWER_CRANE_AGENT')) || 'orchestrator'
  const state = input.state || (await $.env.get('TOWER_CRANE_STATE')) || ''
  const after = input.after !== undefined && input.after !== '' ? String(input.after) : live.watch?.cursor || 'now'
  const argv = ['node', `${$.plugin.root}/bin/tower-crane.js`, 'wait', '--follow', '--inbox', '--after', after, '--agent', agent, ...(state ? ['--state', state] : [])]
  const current = { agent, cursor: after }
  live.watch = current
  void follow($, current, $.process.spawn({ argv }))
  $.ui.status(`tower-crane: watching for ${agent}`)
  return `Tower Crane pushes events for ${agent} after ${after} into this session as they arrive. Run \`tower-crane inbox\` on each wake for findings and resolving commands.`
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'watch',
      description: 'Tower Crane orchestrator: push every orchestrator event (submits, reviews, worker exits and stalls, worker messages, decisions, owner comments, CI, conflicts) into this session as it arrives. Call once after the startup cursor; it replaces background tower-crane wait.',
      inputSchema: {
        type: 'object',
        properties: {
          after: { type: 'string', description: 'cursor from tower-crane wait --timeout 0, or an event id (default: now, or where the last watch stopped)' },
          agent: { type: 'string', description: 'identity to wake (default TOWER_CRANE_AGENT, else orchestrator)' },
          state: { type: 'string', description: 'state directory (default TOWER_CRANE_STATE or the one found from the working directory)' },
        },
      },
    })
    await $.command.register({ name: COMMAND, description: 'Push Tower Crane orchestrator events into this session', argumentHint: '[cursor]' })
    if ((await $.env.get('TOWER_CRANE_AGENT')) === 'orchestrator') await arm($)
    return started
  })

  on('tool.call', { tool: TOOL }, async ($, e) => ({ result: await arm($, e) }))
    .catch(() => ({ deny: 'Tower Crane could not start its event watch; run tower-crane wait in the background instead.' }))

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await arm($, { after: e.args.trim() }) }))
    .catch(() => ({ text: 'Tower Crane could not start its event watch; run tower-crane wait in the background instead.' }))

  on('turn.start', ($, e, next) => {
    live.turn = { id: e.turnId, steps: 0 }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (live.turn && e.turnId === live.turn.id) live.turn.steps += 1
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (live.turn && e.turnId === live.turn.id) {
      const unread = live.steered.filter(s => s.step >= live.turn.steps).map(s => s.w)
      live.steered = []
      live.turn = null
      if (unread.length && live.watch) {
        live.pending.unshift(...unread)
        void flush($)
      }
    }
    return done
  })

  on('session.end', ($, e, next) => {
    live.watch = null
    return next(e)
  })
}
