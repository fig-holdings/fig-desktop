import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { uiText } from '../harness/shared/ui-text'
import { forMain, sideChatService } from '../harness/side-chat/side-chat.js'
import { knownChats, parseSideChatAddress, sideChatAddress } from '../harness/side-chat/client-side-chat.js'
import { tempDir } from './helpers/temp-dir.mjs'

const reply = (id, text) => ({ type: 'assistant/message', data: { message: { id, role: 'assistant', content: [{ type: 'text', text }] } } })
// DSH 0.2.2-rc.1 pages carry each event as `{ type: 'event', event }`.
const records = events => events.map(event => ({ type: 'event', event }))
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fakeController({ running = false } = {}) {
  const prompts = []
  return {
    prompts,
    state: async ({ sessionId }) => ({ cursor: 42, running: sessionId === 'main' && running, queue: [], pendingInput: [] }),
    projections: async () => ({ kind: 'sequenced', values: { todos: [{ status: 'in_progress', content: 'alpha' }, { status: 'pending', content: 'beta' }] } }),
    events: async ({ address }) => ({ hasMore: false, records: records(address.sessionId === 'child'
      ? [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'ask' }] } }, reply('m1', 'Tell main: SIDE-1')]
      : [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'build it' }] } },
        { type: 'user/message', data: { source: { kind: 'fig-workspace-instructions' }, content: [{ type: 'text', text: 'injected rules' }] } },
        { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' } }, reply('x', 'working')].map((event, seq) => ({ ...event, seq }))) }),
    prompt: async request => { prompts.push(request); return { accepted: true } }
  }
}

test('side chat addresses round-trip and refuse other resources', () => {
  const address = sideChatAddress('main id', 'child/1')
  assert.deepEqual(parseSideChatAddress(address), { main: 'main id', child: 'child/1' })
  assert.equal(parseSideChatAddress('dsh-resource://subagentchat/session/a?parent=b&mode=one-shot'), undefined)
  assert.equal(parseSideChatAddress('dsh-resource://figsidechat/session/a'), undefined, 'A main Session is required')
  assert.equal(parseSideChatAddress('not a url'), undefined)
})

test('a picked reply requires a registered side chat and an idle main Session', async t => {
  const dir = await tempDir(t, 'fig-side-chat-')
  const path = join(dir, 'side-chats.json')
  const running = fakeController({ running: true })
  const service = sideChatService(path, () => running)
  await assert.rejects(service.send({ requestId: id(1), child: 'child', messageId: 'm1' }), /UNKNOWN_SIDE_CHAT/)
  await service.register({ child: 'child', main: 'main' })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { schema: 1, chats: { child: 'main' } })
  assert.equal(service.mainOf('child'), 'main')
  await assert.rejects(service.send({ requestId: id(2), child: 'child', messageId: 'm1' }), /MAIN_RUNNING/)
  assert.deepEqual(running.prompts, [])
  await assert.rejects(service.send({ requestId: id(3), child: 'child', messageId: 'missing' }), /REPLY_NOT_FOUND/)
  const idle = fakeController()
  const reloaded = sideChatService(path, () => idle)
  assert.deepEqual(await reloaded.list(), { chats: ['child'] }, 'Registrations survive a Host restart')
  assert.deepEqual(await reloaded.send({ requestId: id(4), child: 'child', messageId: 'm1' }), { main: 'main', mode: 'queue' })
  assert.equal(idle.prompts[0].sessionId, 'main')
  assert.equal(idle.prompts[0].content[0].text, uiText('（来自侧边聊天）', '(From the side chat)') + '\nTell main: SIDE-1')
  await assert.rejects(reloaded.register({ child: 'same', main: 'same' }), /BAD_SIDE_CHAT/)
})

test('confirmation rechecks current queue, input and availability; a cold session is accepted', async t => {
  const dir = await tempDir(t, 'fig-side-chat-check-')
  const controller = fakeController()
  const service = sideChatService(join(dir, 'chat.json'), () => controller)
  await service.register({ main: 'main', child: 'child' })
  const payload = {child: 'child', messageId: 'm1', requestId: id(50)}
  assert.ok((await service.draft(payload)).text)
  controller.state = async () => ({running: true, queue: [], pendingInput: []})
  await assert.rejects(service.send({ requestId: id(5), ...payload, text: 'edited'}), /MAIN_RUNNING/)
  controller.state = async () => ({running: false, queue: [{id: 'new'}], pendingInput: []})
  await assert.rejects(service.send(payload), /MAIN_QUEUE_NOT_EMPTY/)
  for (const kind of ['approval', 'question']) {
    controller.state = async () => ({running: false, queue: [], pendingInput: [kind]})
    await assert.rejects(service.send(payload), /MAIN_PENDING_INPUT/)
  }
  controller.state = async () => {throw Error('read failed')}
  await assert.rejects(service.send(payload), /MAIN_STATE_UNAVAILABLE/)
  controller.state = async () => ({running: false, queue: null})
  await assert.rejects(service.send(payload), /MAIN_STATE_UNAVAILABLE/)
  assert.equal(controller.prompts.length, 0)
  controller.state = async () => ({running: false, queue: null, pendingInput: []})
  assert.deepEqual(await service.send(payload), {main: 'main', mode: 'queue'})
  assert.equal(controller.prompts.length, 1)
})

test('concurrent sends to the same main session submit only once', async t => {
  const dir = await tempDir(t, 'fig-side-chat-double-')
  const controller = fakeController()
  let finish, entered
  const ready = new Promise(resolve => {entered = resolve})
  const gate = new Promise(resolve => {finish = resolve})
  const submit = controller.prompt
  controller.prompt = async request => {entered(); await gate; return submit(request)}
  const service = sideChatService(join(dir, 'chat.json'), () => controller)
  await service.register({ main: 'main', child: 'one' })
  await service.register({ main: 'main', child: 'two' })
  const sending = service.send({ requestId: id(6), child: 'one', text: 'first'})
  await ready
  await assert.rejects(service.send({ requestId: id(7), child: 'two', text: 'second'}), /SIDECHAT_SENDING/)
  finish()
  await sending
  assert.equal(controller.prompts.length, 1)
})

test('the status the side chat model reads covers state, goal, todos, changed files, replies and tools', async t => {
  const dir = await tempDir(t, 'fig-side-chat-')
  const controller = fakeController({ running: true })
  // The shapes DSH 0.2.2-rc.1 projects: GoalProjection, PlanProjection and the todo list.
  let plan = { active: false, pending: false }
  controller.projections = async () => ({ kind: 'sequenced', asOfSeq: 9, values: {
    goal: { goal: { id: 'g1', revision: 3, objective: 'ship v2', phase: 'active', maxGoalRounds: 10 }, roundsStarted: 2, createdAt: 1, updatedAt: 2 },
    plan,
    todos: [{ status: 'completed', content: 'alpha' }, { status: 'in_progress', content: 'beta' }, { status: 'pending', content: 'gamma' }] } })
  const events = controller.events
  controller.events = async request => {
    const page = await events(request)
    if (request.address.sessionId !== 'main') return page
    return { ...page, records: [...page.records, ...records([
      { type: 'workspace/changes', seq: 9, data: { turn: 2 } },
      { type: 'tool/result', seq: 10, data: { turn: 1, step: 1, message: { id: 'r1', role: 'tool', source: { kind: 'tool' }, toolCallId: 'c1',
        content: [{ type: 'text', text: 'wrote 3 files' }] } } },
      { type: 'tool/result', seq: 11, data: { turn: 1, step: 2, message: { id: 'r2', role: 'tool', source: { kind: 'tool' }, toolCallId: 'c2', isError: true,
        content: [{ type: 'text', text: 'no such file' }] } } }])] }
  }
  const changes = { summary: (sessionId, seq) => sessionId === 'main' && seq === 9
    ? { turn: 2, total: 2, added: 30, deleted: 4, files: [{ display: 'src/a.ts', added: 20, deleted: 4 }, { display: 'README.md', added: 10, deleted: 0 }] } : undefined }
  const service = sideChatService(join(dir, 's.json'), () => controller, () => changes)
  const status = await service.status('main', AbortSignal.timeout(1000), { toolResults: true })
  assert.match(status, /main: running/)
  assert.match(status, /Goal: ship v2 \(phase: active, rounds started: 2 of 10\)/)
  assert.match(status, /Todo \(1 of 3 done\)/)
  assert.match(status, /\[in_progress\] beta/)
  assert.match(status, /Turn 2 changed 2 file\(s\), \+30 −4/)
  assert.match(status, /- src\/a\.ts \(\+20 −4\)/)
  assert.match(status, /Latest user message: build it/)
  assert.doesNotMatch(status, /injected rules/, 'injected rule messages are not the user\'s')
  assert.match(status, /Latest reply \(full\):\nworking/)
  assert.match(status, /Recent tool calls: write/)
  assert.match(status, /Tool result write: wrote 3 files/, 'the result is named after its call')
  assert.match(status, /Tool result \(error\): no such file/)
  assert.doesNotMatch(status, /Plan/, 'plan mode off says nothing')
  assert.doesNotMatch(await service.status('main', AbortSignal.timeout(1000)), /Tool result/, 'Tool output only on request')
  plan = { active: true, pending: false }
  assert.match(await service.status('main', AbortSignal.timeout(1000)), /Plan mode is on/)
  const context = await service.context('main', undefined, AbortSignal.timeout(1000))
  assert.deepEqual(JSON.parse(context.text.split('\n')[1]), [
    { role: 'user', text: 'build it' },
    { role: 'assistant', text: 'working' }
  ])
  // A later question carries only messages after the newest event already referenced.
  const later = await service.context('main', context.through, AbortSignal.timeout(1000))
  assert.equal(later.text, '')
  assert.equal(later.through, context.through)
})

test('the send box starts with the part after 给主会话：, and the user may send edited text', async t => {
  assert.equal(forMain('分析……\n\n给主会话：\n把 a.ts 第 3 行改成 b'), '把 a.ts 第 3 行改成 b')
  assert.equal(forMain('Analysis\n**To main session:**\nRename x to y'), 'Rename x to y')
  assert.equal(forMain('只有分析'), '只有分析')
  assert.equal(forMain('结论如上。\n\n给主会话：改用方案 B，先写测试'), '改用方案 B，先写测试', 'The instruction may follow on the same line')
  assert.equal(forMain('提到给主会话：不在行首时不算'), '提到给主会话：不在行首时不算')
  const dir = await tempDir(t, 'fig-side-chat-')
  const controller = fakeController()
  const service = sideChatService(join(dir, 's.json'), () => controller)
  await service.register({ child: 'child', main: 'main' })
  assert.deepEqual(await service.draft({ child: 'child', messageId: 'm1' }), { text: 'Tell main: SIDE-1' })
  await assert.rejects(service.draft({ child: 'other', messageId: 'm1' }), /UNKNOWN_SIDE_CHAT/)
  await service.send({ requestId: id(8), child: 'child', messageId: 'm1', text: '  edited instruction  ' })
  assert.equal(controller.prompts.at(-1).content[0].text, uiText('（来自侧边聊天）', '(From the side chat)') + '\nedited instruction')
  await assert.rejects(service.send({ requestId: id(9), child: 'child', text: 'x'.repeat(20_001) }), /TOO_LONG/)
})

test('a send box retried after a lost response reaches the main Session once', async t => {
  const dir = await tempDir(t, 'fig-side-chat-retry-')
  const controller = fakeController()
  const service = sideChatService(join(dir, 'chat.json'), () => controller)
  await service.register({ main: 'main', child: 'child' })
  const box = { child: 'child', text: 'do it', requestId: id(1) }
  assert.deepEqual(await service.send(box), { main: 'main', mode: 'queue' })
  // The main Session now runs the message; the retry still answers as sent and submits nothing.
  controller.state = async () => ({ running: true, queue: [], pendingInput: [] })
  assert.deepEqual(await service.send(box), { main: 'main', mode: 'queue' })
  assert.equal(controller.prompts.length, 1)
  assert.equal(controller.prompts[0].requestId, id(1), 'DSH receives the box id and ignores a repeat itself')
  await assert.rejects(service.send({ ...box, requestId: id(2) }), /MAIN_RUNNING/, 'a new box is a new message')
  for (const requestId of [undefined, 'not-a-uuid']) await assert.rejects(service.send({ ...box, requestId }), /BAD_REQUEST_ID/)
})

test('send buttons hear when the Host\'s side chat list arrives after a reload', () => {
  const known = knownChats()
  let heard = 0
  const off = known.subscribe(() => heard++)
  known.add('a', 'b')
  assert.ok(known.has('a') && known.has('b'))
  assert.equal(heard, 1, 'one notice for the whole list')
  known.add('a')
  assert.equal(heard, 1, 'nothing new, no notice')
  known.delete('a')
  assert.equal(heard, 2)
  off()
  known.add('c')
  assert.equal(heard, 2)
})
