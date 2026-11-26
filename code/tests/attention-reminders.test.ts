import assert from 'node:assert/strict'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { AttentionHistory, UndoExpired, available } from '../harness/attention/history'
import { AttentionState } from '../harness/attention/state'
import { tempDir } from './helpers/temp-dir.mjs'

const sessionId = 'synthetic'
const prefs = {schema: 1 as const, dock: true, notifications: true}
const event = (seq: number, kind: string, error?: object) =>
  ({seq, type: 'turn/end', data: {turn: seq, reason: {kind, error}}})
const id = (seq: number) => sessionId + ':turn-end:' + seq
const tap = (state: AttentionState) => state.sample([{sessionId, running: false, agentAvailable: true}], [], [], new Map())

test('only structured DSH termination facts classify quota and rate limits after restarts', async t => {
  const root = await tempDir(t, 'fig-activity-categories-')
  const path = join(root, 'history.json')
  const history = await new AttentionHistory(path).load()
  const examples = [
    ['error', {code: 'CHATGPT_USAGE_LIMIT'}, 'quota'],
    ['error', {code: 'GROK_QUOTA'}, 'quota'],
    ['error', {code: 'RATE_LIMIT'}, 'rate-limit'],
    ['error', {code: 'HTTP_ERROR', status: 429}, 'rate-limit'],
    ['error', {code: 'UNAUTHORIZED', status: 401}, 'failure'],
    ['error', {code: 'TRANSPORT', message: '429 quota exceeded'}, 'failure'],
    ['error', {code: 'UNKNOWN', message: 'quota exceeded'}, 'failure'],
    ['interrupted', undefined, 'failure']
  ] as const
  for (const [offset, [kind, error]] of examples.entries()) await history.observe(sessionId, event(offset + 1, kind, error))
  await history.observe(sessionId, event(9, 'aborted'))
  const reloaded = await new AttentionHistory(path).load()
  assert.deepEqual(reloaded.get(sessionId)?.failures.map(item => item.category), examples.map(item => item[2]))
})

test('snoozing and expiry suppress only the selected terminal identities across restarts', async t => {
  const root = await tempDir(t, 'fig-activity-reminders-')
  const path = join(root, 'history.json')
  let now = 1234
  const history = await new AttentionHistory(path, () => now).load()
  const before = new AttentionState('before', now)
  before.historyOf = key => history.get(key)
  tap(before)
  for (const terminal of [event(1, 'error'), event(2, 'completed')]) {
    await history.observe(sessionId, terminal)
    before.event(sessionId, terminal)
  }
  assert.deepEqual(before.read(0, prefs).events.map(item => item.kind), ['failure', 'result'])
  await history.acknowledge(sessionId, [id(1), id(2)], 'snooze')
  const expiry = now + 3600_000
  assert.equal(history.get(sessionId)?.failures[0].snoozedUntil, expiry)
  assert.equal(before.read(0, prefs, now).rows[0].unknownFailure, false)
  assert.deepEqual(before.read(0, prefs, now).events, [])
  now++
  const restarted = await new AttentionHistory(path, () => now).load()
  const after = new AttentionState('after', now)
  after.historyOf = key => restarted.get(key)
  tap(after)
  const newResult = event(3, 'completed')
  await restarted.observe(sessionId, newResult)
  after.event(sessionId, newResult)
  assert.equal(available(restarted.get(sessionId)!.results[0], now), false)
  assert.deepEqual(after.read(0, prefs, now).events.map(item => item.kind), ['result'])
  after.remind(expiry - 1)
  assert.equal(after.read(1, prefs, expiry - 1).events.length, 0)
  after.remind(expiry)
  after.remind(expiry + 1)
  assert.equal(after.read(1, prefs, expiry).rows[0].unknownFailure, true)
  assert.deepEqual(after.read(1, prefs, expiry).events.map(item => item.kind), ['result', 'failure'])
})

test('undo restores just the selected events and expires at five seconds', async t => {
  const root = await tempDir(t, 'fig-activity-undo-')
  let now = 1234
  const history = await new AttentionHistory(join(root, 'history.json'), () => now).load()
  await history.observe(sessionId, event(1, 'error'))
  const receipt = (await history.acknowledge(sessionId, [id(1)], 'known'))!
  assert.equal(history.get(sessionId)?.failures[0].known, true)
  await history.observe(sessionId, event(2, 'error'))
  now += 4999
  await history.undo(receipt.token)
  assert.deepEqual(history.get(sessionId)?.failures.map(f => [f.identity, f.known]), [[id(1), false], [id(2), false]])
  const ended = (await history.acknowledge(sessionId, [id(1)], 'end'))!
  await history.observe(sessionId, event(3, 'completed'))
  await history.undo(ended.token)
  assert.deepEqual(history.get(sessionId)?.failures.map(f => f.identity), [id(1), id(2)])
  assert.deepEqual(history.get(sessionId)?.results.map(r => r.identity), [id(3)])
  const snoozed = (await history.acknowledge(sessionId, [id(3)], 'snooze'))!
  const once = (await history.acknowledge(sessionId, [id(2)], 'known'))!
  now += 5000
  await assert.rejects(history.undo(snoozed.token), UndoExpired)
  await assert.rejects(history.undo(once.token), UndoExpired)
  assert.equal(history.get(sessionId)?.results[0].snoozedUntil, snoozed.expiresAt - 5000 + 3600_000)
  assert.equal(history.healthy, true)
})

test('a failed write does not defer the selected event or issue an undo receipt', async t => {
  const root = await tempDir(t, 'fig-activity-deferral-write-')
  const path = join(root, 'history.json')
  const history = await new AttentionHistory(path).load()
  await history.observe(sessionId, event(1, 'error'))
  await rename(path, path + '.saved')
  await mkdir(path)
  await assert.rejects(history.acknowledge(sessionId, [id(1)], 'snooze'))
  assert.equal(history.get(sessionId)?.failures[0].snoozedUntil, undefined)
  assert.equal(history.healthy, false)
  await rm(path, {recursive: true})
  await rename(path + '.saved', path)
  assert.equal((await new AttentionHistory(path).load()).get(sessionId)?.failures[0].snoozedUntil, undefined)
})

test('a reminder is not raised again when its session leaves the rows for a round and comes back', () => {
  const started = 1000, expiry = 5000
  const state = new AttentionState('gap', started)
  const record = {sessionId, observedThrough: 1, readThrough: 0, lastSignificantAt: started, failures: [],
    results: [{identity: id(1), seq: 1, turn: 1, at: started, snoozedUntil: expiry}]}
  state.historyOf = key => key === sessionId ? record : undefined
  tap(state)
  state.remind(expiry)
  assert.deepEqual(state.read(0, prefs, expiry).events.map(item => item.kind), ['result'])
  // The session drops out of one sampling round (still listed by DSH), then returns.
  state.sample([], [], [], new Map(), new Set([sessionId]))
  state.remind(expiry + 1)
  tap(state)
  state.remind(expiry + 2)
  assert.equal(state.read(0, prefs, expiry + 2).events.length, 1, 'One reminder per snooze')
  // Once DSH no longer lists it, the record is forgotten.
  state.sample([], [], [], new Map(), new Set())
  tap(state)
  state.remind(expiry + 3)
  assert.equal(state.read(0, prefs, expiry + 3).events.length, 2)
})
