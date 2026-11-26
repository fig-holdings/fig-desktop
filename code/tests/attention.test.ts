import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { AttentionState } from '../harness/attention/state'
import { desktopBridge } from '../harness/shell-bridge/bridge'
import { DesktopAttention, readAttention, readIdle } from '../app/main/attention'
import { readRecord } from '../harness/shared/atomic-json'
import { tempDir } from './helpers/temp-dir.mjs'

const prefs = {schema: 1 as const, notifications: true, dock: true}
const summary = (id: string, extra = {}) => ({sessionId: id, agentAvailable: true, running: false, ...extra})
const passive = (kinds: string[], running = false, cursor = 999) => ({pendingInput: kinds, running, cursor})
const workspaces = [{id: 'w', sessionIds: ['root', 'other']}]

test('attention baseline/episode/category/child aggregation, abort, failure and archive use actual identities', () => {
  const state = new AttentionState(randomUUID())
  const items = [summary('root'), summary('child', {origin: 'subagent', parentSessionId: 'root'}), summary('other')]
  const sample = (root: string[], child: string[] = []) => state.sample(items, workspaces, [], new Map([['root', passive(root)], ['child', passive(child)]]))
  sample(['approval'], ['question'])
  assert.deepEqual(state.read(undefined, prefs).events, [])
  assert.equal(state.read(0, prefs).rows.filter(r => r.pendingKinds.length).length, 1)
  const baseline = state.read(undefined, prefs).cursor
  sample(['approval'], ['question'])
  assert.equal(state.read(baseline, prefs).events.length, 0)
  sample([]); sample(['approval'])
  const again = state.read(baseline, prefs).events
  assert.equal(again.length, 1); assert.match(again[0].identity, /approval:2$/)
  state.event('child', {seq: 9, type: 'turn/end', data: {turn: 1, reason: {kind: 'error'}}})
  state.event('root', {seq: 10, type: 'turn/end', data: {turn: 1, reason: {kind: 'aborted'}}})
  assert.equal(state.read(baseline, prefs).events.length, 1)
  state.event('root', {seq: 11, type: 'turn/end', data: {turn: 2, reason: {kind: 'error'}}})
  state.event('root', {seq: 11, type: 'turn/end', data: {turn: 2, reason: {kind: 'error'}}})
  state.event('root', {seq: 12, type: 'turn/end', data: {turn: 3, reason: {kind: 'completed'}}})
  assert.deepEqual(state.read(baseline, prefs).events.map(e => e.kind), ['approval', 'failure', 'result'])
  // A stale passive sample cannot revive a more recent terminal event.
  state.sample(items, workspaces, [], new Map([['root', passive([], true, 11)]]))
  assert.equal(state.rows.get('root')?.running, false)
  state.sample(items, workspaces, ['root', 'child'], new Map())
  assert.ok(!state.rows.has('root')); assert.equal(state.read(0, prefs).events.length, 0)
  const restarted = new AttentionState(randomUUID()); restarted.sample(items, workspaces, [], new Map([['root', passive(['approval'])]]))
  assert.equal(restarted.read(undefined, prefs).events.length, 0)
})

test('new fast sessions retain terminal facts; baseline skips history; bounded gaps fail closed', () => {
  const state = new AttentionState(randomUUID()); state.sample([], [], [], new Map())
  state.event('root', {seq: 1, type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}})
  state.sample([summary('root')], workspaces, [], new Map())
  assert.equal(state.read(0, prefs).events[0].kind, 'result')
  for (let seq = 2; seq < 270; seq++) state.event('root', {seq, type: 'turn/end', data: {turn: seq, reason: {kind: 'completed'}}})
  assert.equal(state.read(0, prefs).gap, true); assert.deepEqual(state.read(0, prefs).events, [])
  assert.deepEqual(state.read(undefined, prefs).events, [])
})

test('per-session episode and event tables forget sessions DSH no longer lists, and keep listed ones', () => {
  const state = new AttentionState(randomUUID())
  const items = [summary('root'), summary('other')]
  state.sample(items, workspaces, [], new Map([['root', passive(['approval'])], ['other', passive(['question'])]]))
  state.event('other', {seq: 3, type: 'turn/start', data: {turn: 1}})
  const tables = state as any
  assert.equal(tables.episodes.size, 2); assert.equal(tables.seenEvents.size, 1)
  state.sample([summary('root')], workspaces, ['other'], new Map([['root', passive(['approval'])]]), new Set(['root', 'other']))
  assert.equal(tables.episodes.size, 2, 'an archived session is still listed and keeps its episode count')
  state.sample([summary('root')], workspaces, [], new Map([['root', passive(['approval'])]]), new Set(['root']))
  assert.deepEqual([...tables.episodes.keys()], ['root:approval']); assert.equal(tables.seenEvents.size, 0)
  assert.equal(state.rows.get('root')?.workspaceId, 'w')
})

test('durable state time survives restart; unknown failures alone contribute one Dock session', () => {
  const state = new AttentionState(randomUUID())
  const record = {sessionId: 'root', observedThrough: 1, readThrough: 0, results: [], lastSignificantAt: 1234}
  const failure = {identity: 'root:turn-end:1', seq: 1, turn: 1, at: 1234, ended: false}
  state.historyOf = () => ({...record, failures: [{...failure, known: false}]})
  state.sample([summary('root')], workspaces, [], new Map())
  assert.equal(state.rows.get('root')!.lastSignificantAt, 1234)
  assert.equal(state.read(undefined, prefs).rows[0].unknownFailure, true)
  state.historyOf = () => ({...record, failures: [{...failure, known: true}]})
  assert.equal(state.read(undefined, prefs).rows[0].unknownFailure, false)
})

async function serverFor(state: AttentionState, capability = randomBytes(32).toString('hex'), idle = async () => true) {
  // The bridge checks the generation main started this Host with; here the state's own stands in for it.
  const server = createServer(desktopBridge(capability, state.generation, {read: cursor => state.read(cursor, prefs), idle}))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`
  return {server, connection: {origin, capability, generation: state.generation}}
}
function raw(origin: string, method: string, headers = {}, body = '{}', path = '/fig-desktop/attention/read'): Promise<number> {
  return new Promise((resolve, reject) => { const req = request(new URL(path, origin), {method, headers: {'content-length': Buffer.byteLength(body), ...headers}}, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) }); req.on('error', error => { error.message += ` [${method} ${path}; body bytes ${body.length}; headers ${Object.keys(headers)}]`; reject(error) }); req.end(body) })
}
test('real loopback bridge denies browser, incorrect capability/Host/generation, oversized and write-shaped requests', async () => {
  const state = new AttentionState(randomUUID()); state.sample([], [], [], new Map())
  const {server, connection: c} = await serverFor(state)
  const headers = {'x-fig-attention': c.capability}
  try {
    assert.equal((await readAttention(c)).baseline, true)
    assert.equal(await raw(c.origin, 'POST'), 403)
    assert.equal(await raw(c.origin, 'POST', {...headers, origin: c.origin}), 403)
    assert.equal(await raw(c.origin, 'POST', {...headers, host: 'localhost'}), 403)
    assert.equal(await raw(c.origin, 'OPTIONS', headers), 404)
    assert.equal(await raw(c.origin, 'POST', headers, '{}'), 409)
    assert.equal(await raw(c.origin, 'POST', headers, JSON.stringify({generation: c.generation, command: 'approve'})), 409)
    assert.equal(await raw(c.origin, 'POST', headers, 'a'.repeat(1025)), 413)
    assert.equal(await raw(c.origin, 'POST', headers, '{}', '/fig-desktop/attention/write'), 404)
    await assert.rejects(readAttention({...c, generation: randomUUID()}))
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('the activity read shares the bridge checks and answers only idle', async () => {
  const state = new AttentionState(randomUUID()); state.sample([], [], [], new Map())
  let idle = false
  const {server, connection: c} = await serverFor(state, undefined, async () => idle)
  const headers = {'x-fig-attention': c.capability}
  try {
    assert.equal(await readIdle(c), false)
    idle = true
    assert.equal(await readIdle(c), true)
    await assert.rejects(readIdle(undefined))
    await assert.rejects(readIdle({...c, capability: randomBytes(32).toString('hex')}))
    await assert.rejects(readIdle({...c, generation: randomUUID()}))
    assert.equal(await raw(c.origin, 'POST', {}, JSON.stringify({generation: c.generation}), '/fig-desktop/activity'), 403)
    assert.equal(await raw(c.origin, 'POST', {...headers, origin: c.origin}, JSON.stringify({generation: c.generation}), '/fig-desktop/activity'), 403)
    assert.equal(await raw(c.origin, 'POST', headers, JSON.stringify({generation: c.generation, kind: 'dshHome'}), '/fig-desktop/activity'), 409)
    assert.equal(await raw(c.origin, 'GET', headers, '', '/fig-desktop/activity'), 404)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('a malformed server capability fails closed before constant-time comparison', async () => {
  const state = new AttentionState(randomUUID()); state.sample([], [], [], new Map())
  const {server, connection} = await serverFor(state, 'invalid')
  try {
    assert.equal(await raw(connection.origin, 'POST', {'x-fig-attention': randomBytes(32).toString('hex')}, JSON.stringify({generation: state.generation})), 403)
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))}
})

test('main schedules before showing, suppresses only visible foreground, retains badge on disconnect and clears on confirmed stop', async t => {
  const state = new AttentionState(randomUUID()); state.sample([summary('root')], workspaces, [], new Map())
  const {server, connection} = await serverFor(state)
  const home = await tempDir(t, 'fig-attention-test-')
  let online = true, foreground = false
  const badges: string[] = [], shown: any[] = []
  const main = new DesktopAttention(home, {
    connection: () => online ? connection : undefined, foreground: () => foreground,
    execute: async script => script.includes('Context') ? {visible: true, sessionId: 'root'} : undefined,
    badge: text => badges.push(text), activate() {},
    show: (event, click) => { shown.push({event, click}) }
  })
  try {
    await main.start()
    state.sample([summary('root')], workspaces, [], new Map([['root', passive(['approval'])]]))
    await main.poll(); assert.equal(badges.at(-1), '1'); assert.equal(shown.length, 1)
    const ledger = JSON.parse(await readFile(join(home, 'fig/attention/notification-ledger.json'), 'utf8'))
    assert.ok(ledger.scheduled.includes(shown[0].event.identity))
    await main.poll(); assert.equal(shown.length, 1)
    online = false; await main.poll(); assert.equal(badges.at(-1), '1'); assert.equal(main.status, 'disconnected')
    online = true; foreground = true
    state.event('root', {seq: 4, type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}})
    await main.poll(); assert.equal(shown.length, 1)
    main.stop(); assert.equal(badges.at(-1), '')
  } finally { main.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('the Mac stays awake while a Session runs, through a disconnect, until it ends or the service stops', async t => {
  const state = new AttentionState(randomUUID()); state.sample([summary('root')], workspaces, [], new Map())
  const {server, connection} = await serverFor(state)
  const home = await tempDir(t, 'fig-attention-awake-')
  let online = true
  const awake: boolean[] = []
  const main = new DesktopAttention(home, {
    connection: () => online ? connection : undefined, foreground: () => false, execute: async () => undefined,
    badge() {}, activate() {}, show() {}, keepAwake: running => awake.push(running)
  })
  try {
    await main.start(); await main.poll()
    assert.deepEqual(awake, [], 'Nothing running, nothing held')
    state.sample([summary('root', {running: true})], workspaces, [], new Map([['root', passive([], true)]]))
    await main.poll(); await main.poll()
    assert.deepEqual(awake, [true], 'Held once while running, not on every poll')
    online = false; await main.poll(); assert.deepEqual(awake, [true], 'A disconnect keeps the hold')
    online = true
    state.sample([summary('root')], workspaces, [], new Map([['root', passive([], false)]]))
    await main.poll(); assert.deepEqual(awake, [true, false], 'Released when the run ends')
    state.sample([summary('root', {running: true})], workspaces, [], new Map([['root', passive([], true)]]))
    await main.poll(); main.stop(); assert.deepEqual(awake, [true, false, true, false], 'Released on stop')
  } finally { main.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('the Dock menu and badge are set only when status or count changes, not on every poll', async t => {
  const state = new AttentionState(randomUUID()); state.sample([summary('root')], workspaces, [], new Map())
  const {server, connection} = await serverFor(state)
  const home = await tempDir(t, 'fig-attention-quiet-')
  let online = true
  const badges: string[] = [], statuses: string[] = []
  const main = new DesktopAttention(home, {
    connection: () => online ? connection : undefined, foreground: () => false, execute: async () => undefined,
    badge: text => badges.push(text), syncStatus: status => statuses.push(status), activate() {}, show() {}
  })
  try {
    await main.start(); await main.poll(); await main.poll()
    assert.deepEqual(statuses, ['syncing', 'ready']); assert.deepEqual(badges, [''])
    state.sample([summary('root')], workspaces, [], new Map([['root', passive(['approval'])]]))
    await main.poll(); await main.poll()
    assert.deepEqual(badges, ['', '1'])
    online = false; await main.poll(); await main.poll()
    online = true; await main.poll(); await main.poll()
    assert.deepEqual(statuses, ['syncing', 'ready', 'disconnected', 'ready']); assert.deepEqual(badges, ['', '1'])
    main.stop(); main.stop()
    assert.deepEqual(statuses.at(-1), 'stopped'); assert.deepEqual(badges, ['', '1', ''])
  } finally { main.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('invalid persistent schema is quarantined, and HTTP redirects never reach a target', async t => {
  const home = await tempDir(t, 'fig-attention-corrupt-')
  const path = join(home, 'preferences.json'); await writeFile(path, '{bad')
  const value = await readRecord(path, (v): v is {schema: number} => v?.schema === 1, {schema: 1})
  assert.equal(value.schema, 1); assert.ok((await readdir(home)).some(p => p.startsWith('preferences.json.corrupt-')))
  let requests = 0
  const server = createServer((req, res) => { requests++; res.writeHead(302, {location: '/secret'}); res.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(readAttention({origin: `http://127.0.0.1:${(server.address() as {port: number}).port}`, capability: 'x', generation: randomUUID()}))
    assert.equal(requests, 1)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('an old navigation acknowledgement cannot clear a newer notification target', async t => {
  const state = new AttentionState(randomUUID()); state.sample([summary('root'), summary('other')], workspaces, [], new Map())
  const {server, connection} = await serverFor(state)
  const home = await tempDir(t, 'fig-navigation-test-')
  const clicks: (() => void)[] = [], targets: any[] = [], responses: ((value: any) => void)[] = []
  const main = new DesktopAttention(home, {connection: () => connection, foreground: () => false, badge() {}, activate() {},
    show: (_event, click) => clicks.push(click), execute: script => {
      const target = JSON.parse(script.slice(script.indexOf('(') + 1, -1)); targets.push(target)
      return new Promise(resolve => responses.push(resolve))
    }})
  const tick = () => new Promise(resolve => setImmediate(resolve))
  try {
    await main.start()
    state.sample([summary('root'), summary('other')], workspaces, [], new Map([['root', passive(['approval'])], ['other', passive(['question'])]]))
    await main.poll(); assert.equal(clicks.length, 2)
    clicks[0](); await tick(); clicks[1]()
    assert.equal(targets.length, 1)
    responses[0]({accepted: true, navigationId: targets[0].navigationId}); await tick()
    const next = main.navigate(); await tick()
    assert.equal(targets.length, 2); assert.equal(targets[1].sessionId, 'other')
    responses[1]({accepted: true, navigationId: targets[1].navigationId}); await next
    await main.navigate(); assert.equal(targets.length, 2)
  } finally { main.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
