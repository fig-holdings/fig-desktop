import { readJsonFile, writeRecord } from '../shared/atomic-json.ts'
import { contentText } from '../shared/message-text.js'

// Next-step hint: after a completed turn, one short line the user might send next, shown greyed in
// the empty composer and taken with Tab. It costs one small call on the session's own model.

export const system = 'You suggest the next message the user is likely to send to a coding agent. You see a few earlier '
  + 'exchanges for context, then the last one. Base the suggestion on the agent\'s last reply: if it asks the user something, '
  + 'answer it the way this user most likely would; if it proposes a next step, accept it in concrete words naming what to do; '
  + 'otherwise continue the work the conversation is clearly heading to. Reply with only that message: one short line in the '
  + 'language the user writes in, at most 60 characters, worded as the user talking to the agent. No quotes, labels or '
  + 'explanation. If no next step is clear, reply with nothing.'
const userLimit = 2000
const replyLimit = 6000
// Earlier completed exchanges given as context, each cut short: the last exchange carries the decision.
const earlierCount = 2
const earlierUserLimit = 400
const earlierReplyLimit = 800
const maxTokens = 400
const timeoutMs = 20_000

/** The model's reply as one composer line, or '' when it gave none. */
export function cleanSuggestion(text) {
  const line = text.split('\n').map(item => item.trim()).find(Boolean) ?? ''
  return line.replace(/^["'“‘「]+|["'”’」]+$/g, '').trim().slice(0, 120)
}

/** The prompt: up to two earlier exchanges in brief, then the last one in full (within the limits). */
export function exchangeInput(user, reply, earlier = []) {
  const context = earlier.slice(-earlierCount).map((item, index) =>
    `Earlier exchange ${index + 1}:\nUser: ${item.user.slice(0, earlierUserLimit)}\nAgent (end of reply): ${item.reply.slice(-earlierReplyLimit)}`)
  const last = `User's last message:\n${user.slice(0, userLimit)}\n\nAgent's reply:\n${reply.slice(-replyLimit)}`
  return context.length ? context.join('\n\n') + '\n\n---\n\n' + last : last
}

/**
 * `llm` is DSH's LLM service; `track` reads every session event. `next(sessionId)` answers for the
 * newest completed turn seen since this Host started, and shares one call per turn.
 */
export function nextStepService({ llm, path, limit = 512 }) {
  const sessions = new Map()
  let enabled

  async function load() {
    if (enabled === undefined) {
      enabled = (await readJsonFile(path))?.enabled !== false
    }
    return enabled
  }

  async function generate(record, signal) {
    const call = await llm.prepareCall({ provider: record.route.provider, model: record.route.model, maxTokens }, signal, (controls, model) => {
      const effort = model.reasoning?.efforts[0]?.id
      return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
    })
    const messages = [{ id: 'fig-next-step', role: 'user', source: { kind: 'fig-next-step' },
      content: [{ type: 'text', text: exchangeInput(record.user, record.reply, record.earlier) }] }]
    let text = ''
    for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'block-end' && chunk.block.type === 'text' && !text) text = chunk.block.text
      else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) throw new Error(chunk.reason.failure?.message ?? 'failed')
    }
    return cleanSuggestion(text)
  }

  return {
    track(session, event) {
      if (typeof session?.id !== 'string' || typeof event?.type !== 'string') return
      const record = sessions.get(session.id) ?? {}
      switch (event.type) {
        case 'request/header': {
          const config = event.data?.header?.config
          if (typeof config?.provider === 'string' && typeof config.model === 'string') record.route = { provider: config.provider, model: config.model }
          break
        }
        case 'user/message':
          if (event.data?.source?.kind !== 'user') return
          // The exchange that just finished becomes context for the next suggestion.
          if (record.user && record.reply) record.earlier = [...(record.earlier ?? []), { user: record.user, reply: record.reply }].slice(-earlierCount)
          record.user = contentText(event.data.content).slice(0, userLimit)
          record.reply = ''
          break
        case 'assistant/message': {
          const text = contentText(event.data?.message?.content)
          if (text) record.reply = text.slice(-replyLimit)
          break
        }
        case 'turn/start':
          record.ready = undefined
          record.pending?.abort()
          break
        case 'turn/end':
          record.ready = event.data?.reason?.kind === 'completed' && record.user && record.reply && record.route ? event.seq : undefined
          record.answer = undefined
          break
        default: return
      }
      // Most recently active sessions last; the oldest is forgotten past the limit.
      sessions.delete(session.id)
      sessions.set(session.id, record)
      if (sessions.size > limit) for (const [id, oldest] of sessions) {
        oldest.pending?.abort(); sessions.delete(id); break
      }
    },
    async next(sessionId) {
      const record = sessions.get(sessionId)
      if (record?.ready === undefined || !await load()) return null
      const turn = record.ready
      if (record.answer?.turn !== turn) {
        record.pending?.abort()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        record.pending = controller
        const text = generate(record, controller.signal)
          .catch(error => { if (!controller.signal.aborted) console.warn('[fig-composer] next-step hint failed:', error?.message ?? error); return '' })
          .finally(() => { clearTimeout(timer); if (record.pending === controller) record.pending = undefined })
        record.answer = { turn, text }
      }
      const text = await record.answer.text
      return record.ready === turn && text ? { turn, text } : null
    },
    async settings() {
      return { enabled: await load() }
    },
    async enable(value) {
      enabled = value === true
      await writeRecord(path, { version: 1, enabled })
      return { enabled }
    }
  }
}
