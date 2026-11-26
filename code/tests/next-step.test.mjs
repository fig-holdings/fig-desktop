import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanSuggestion, exchangeInput, nextStepService, system } from '../harness/composer/next-step.js'
import { tempDir } from './helpers/temp-dir.mjs'

const session = { id: 'session-1' }
const path = async t => join(await tempDir(t, 'fig-next-step-'), 'fig', 'next-step.json')

// A stand-in for DSH's llm service: records each call and streams the given reply.
function fakeLlm(reply = '跑一下测试', { fail = false, efforts = ['low', 'high'] } = {}) {
  const calls = []
  return {
    calls,
    async prepareCall(config, signal, configure) {
      const controls = configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: efforts.map(id => ({ id })) } })
      return {
        config: { ...config, ...controls },
        async * stream(options) {
          calls.push(options)
          if (fail) throw new Error('offline')
          yield { type: 'text-delta', index: 0, text: reply.slice(0, 2) }
          yield { type: 'text-delta', index: 0, text: reply.slice(2) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
  }
}

function turn(service, { provider = 'deepseek', model = 'deepseek-v4-pro', user = '把登录页改成深色', reply = '已改好登录页。', end = 'completed', seq = 9 } = {}) {
  service.track(session, { type: 'turn/start', seq: seq - 4 })
  service.track(session, { type: 'user/message', seq: seq - 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } })
  service.track(session, { type: 'request/header', seq: seq - 2, data: { header: { config: { provider, model } } } })
  service.track(session, { type: 'assistant/message', seq: seq - 1, data: { message: { content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: reply }] } } })
  service.track(session, { type: 'turn/end', seq, data: { reason: { kind: end } } })
}

test('a completed turn gets one hint from the session model, shared by repeated asks', async t => {
  const llm = fakeLlm('“跑一下测试”\n多余的第二行')
  const service = nextStepService({ llm, path: await path(t) })
  turn(service)
  const [first, second] = await Promise.all([service.next(session.id), service.next(session.id)])
  assert.deepEqual(first, { turn: 9, text: '跑一下测试' })
  assert.deepEqual(second, first)
  assert.equal(llm.calls.length, 1)
  const [call] = llm.calls
  assert.equal(call.provider, 'deepseek')
  assert.equal(call.model, 'deepseek-v4-pro')
  assert.equal(call.reasoningEffort, 'low', 'the least reasoning effort the model offers')
  assert.equal(call.system, system)
  assert.match(call.messages[0].content[0].text, /把登录页改成深色[\s\S]*已改好登录页/)
})

test('no hint for an unfinished or unseen turn, a new turn, a failure, or when turned off', async t => {
  const llm = fakeLlm()
  const file = await path(t)
  const service = nextStepService({ llm, path: file })
  assert.equal(await service.next('session-unknown'), null)
  turn(service, { end: 'aborted' })
  assert.equal(await service.next(session.id), null)
  turn(service, { seq: 20 })
  service.track(session, { type: 'turn/start', seq: 21 })
  assert.equal(await service.next(session.id), null, 'a turn in progress has no hint')

  const failing = nextStepService({ llm: fakeLlm('x', { fail: true }), path: await path(t) })
  turn(failing)
  assert.equal(await failing.next(session.id), null)

  assert.deepEqual(await service.enable(false), { enabled: false })
  assert.deepEqual(await nextStepService({ llm, path: file }).settings(), { enabled: false }, 'the switch survives a restart')
  turn(service, { seq: 30 })
  assert.equal(await service.next(session.id), null)
  assert.equal(llm.calls.length, 0)
})

test('a suggestion becomes one composer line', () => {
  assert.equal(cleanSuggestion('\n  "提交并开 PR"  \nmore'), '提交并开 PR')
  assert.equal(cleanSuggestion('   '), '')
  assert.equal(cleanSuggestion('a'.repeat(300)).length, 120)
})

test('only the truncated exchange is kept, and the session table stays bounded', async t => {
  const llm = fakeLlm()
  const service = nextStepService({ llm, path: await path(t), limit: 2 })
  turn(service, { user: 'u'.repeat(3000), reply: 'head-' + 'r'.repeat(7000) + '-tail' })
  assert.ok(await service.next(session.id))
  const text = llm.calls[0].messages[0].content[0].text
  assert.match(text, /-tail$/); assert.doesNotMatch(text, /head-/)
  for (const id of ['session-2', 'session-3']) service.track({ id }, { type: 'turn/start', seq: 1 })
  assert.equal(await service.next(session.id), null, 'the least recently active session is forgotten past the limit')
})

test('the prompt carries two earlier exchanges in brief before the last one', async t => {
  const llm = fakeLlm()
  const service = nextStepService({ llm, path: await path(t) })
  turn(service, { user: '第一问', reply: '第一答', seq: 9 })
  turn(service, { user: '第二问', reply: 'x'.repeat(900) + '第二答', seq: 19 })
  turn(service, { user: '第三问', reply: '第三答', seq: 29 })
  turn(service, { user: '把登录页改成深色', reply: '已改好，要我跑测试吗？', seq: 39 })
  assert.ok(await service.next(session.id))
  const text = llm.calls[0].messages[0].content[0].text
  assert.doesNotMatch(text, /第一问/, 'only the two most recent earlier exchanges')
  assert.match(text, /Earlier exchange 1:\nUser: 第二问\nAgent \(end of reply\): x{0,800}第二答/)
  assert.match(text, /Earlier exchange 2:\nUser: 第三问/)
  assert.match(text, /---\n\nUser's last message:\n把登录页改成深色\n\nAgent's reply:\n已改好，要我跑测试吗？$/)
  assert.equal(exchangeInput('u', 'r'), "User's last message:\nu\n\nAgent's reply:\nr", 'no earlier exchange, no context block')
})
