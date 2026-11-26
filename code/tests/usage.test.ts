import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UsageLedger, backfillUsage, projectName, windowStart } from '../harness/attention/usage'

const now = new Date(2026, 10, 7, 15, 30).getTime()
const at = (day: number, hour: number, minute = 10) => new Date(2026, 10, day, hour, minute).getTime()
let seq = 0
const message = (time: number, model: string, usage?: object, id: string | undefined = 'm' + ++seq) => ({
  type: 'assistant/message', seq: ++seq, time,
  data: {message: {id, role: 'assistant', source: {kind: 'model', provider: 'p', model}}, ...(usage ? {usage} : {})}
})
const usage = (total: number) => ({inputTokens: total * .2, cacheReadTokens: total * .7, cacheWriteTokens: 0, outputTokens: total * .1, totalTokens: total})
const workspaces = [{path: '/w/alpha'}, {path: '/w/beta'}]

test('usage window starts at local midnight six days back', () => {
  assert.equal(windowStart(now), new Date(2026, 10, 1).getTime())
})

test('project names follow the longest registered workspace, else the cwd', () => {
  assert.equal(projectName('/w/alpha/sub', workspaces), 'alpha')
  assert.equal(projectName('/w/alphabet', workspaces), 'alphabet')
  assert.equal(projectName(undefined, workspaces), '')
})

test('usage cells sum totals with cache, split projects and models, and count unmetered calls', () => {
  const ledger = new UsageLedger()
  ledger.observe('a', '/w/alpha', message(at(7, 14), 'gpt', usage(1000)))
  ledger.observe('a', '/w/alpha', message(at(7, 14, 40), 'grok', usage(500)))
  ledger.observe('b', '/w/beta', message(at(7, 14, 50), 'gpt', usage(300)))
  ledger.observe('b', '/w/beta', message(at(7, 14, 55), 'native'))
  ledger.observe('b', '/w/beta', {type: 'user/message', seq: 1, time: at(7, 14), data: {}})
  ledger.observe('c', '/w/gamma', message(at(31 - 30, 0), 'gpt', usage(10)))
  ledger.observe('c', '/w/gamma', message(at(31 - 31, 23), 'gpt', usage(99_999))) // Oct 31, outside
  const view = ledger.view(workspaces, now)
  assert.equal(view.days.length, 7)
  const cell = view.cells[6][14]
  assert.equal(cell.total, 1800)
  assert.equal(cell.cache, 1260)
  assert.equal(cell.unmetered, 1)
  assert.deepEqual(cell.projects, [{name: 'alpha', total: 1500}, {name: 'beta', total: 300}])
  assert.deepEqual(cell.models, [{name: 'gpt', total: 1300}, {name: 'grok', total: 500}])
  assert.equal(view.cells[0][0].total, 10)
  assert.equal(view.total, 1810)
  assert.equal(view.peak, 1800)
  assert.equal(ledger.records.size, 5, 'records before the window are pruned')
  // figActivity v2: the hour by Session, adding up to its total.
  assert.deepEqual(cell.sessions, [{id: 'a', total: 1500}, {id: 'b', total: 300}])
  for (const row of view.cells) for (const each of row) assert.equal(each.sessions.reduce((sum, item) => sum + item.total, 0), each.total)
})

test('usage collapses beyond three shares and dedupes forked message ids', () => {
  const ledger = new UsageLedger()
  for (const [i, model] of ['a', 'b', 'c', 'd', 'e'].entries()) ledger.observe('s', '/w/alpha', message(at(6, 9), model, usage(100 - i * 10)))
  ledger.observe('fork', '/w/beta', message(at(6, 9), 'a', usage(100), 'm1-shared'))
  ledger.observe('s', '/w/alpha', message(at(6, 9), 'a', usage(100), 'm1-shared'))
  const models = ledger.view(workspaces, now).cells[5][9].models
  assert.deepEqual(models.map(m => m.name), ['a', 'b', 'c', ''])
  assert.equal(models[0].total, 200)
  assert.equal(models[3].total, 70 + 60)
})

test('usage levels rank non-empty cells from 1 to the peak at 4', () => {
  const ledger = new UsageLedger()
  for (const [hour, total] of [[1, 10], [2, 20], [3, 30], [4, 1_000_000]]) ledger.observe('s', '/w/alpha', message(at(5, hour), 'm', usage(total)))
  const row = ledger.view(workspaces, now).cells[4]
  assert.deepEqual([0, 1, 2, 3, 4].map(h => row[h].level), [0, 1, 2, 3, 4])
})

test('usage backfill pages backwards until the window start and addresses subagents', async () => {
  const ledger = new UsageLedger()
  const requests: any[] = []
  const pages = [
    {records: [{type: 'event', event: message(at(7, 10), 'gpt', usage(5))}], hasMore: true, cursor: 50},
    {records: [{type: 'event', event: message(at(1, 1), 'gpt', usage(7))}, {type: 'event', event: message(at(0 + 31 - 31, 1), 'gpt', usage(9))}], hasMore: true, cursor: 20}
  ]
  const source = {
    list: async () => ({items: [
      {sessionId: 'old', updatedAt: at(0 + 1, 0) - 86_400_000 * 3},
      {sessionId: 'p', updatedAt: at(7, 10), cwd: '/w/alpha'},
      {sessionId: 'child', updatedAt: at(7, 11), cwd: '/w/beta', origin: 'subagent' as const, parentSessionId: 'p'}
    ]}),
    events: async (request: any) => {
      requests.push(request)
      if (request.address.kind === 'subagent') return {records: [{type: 'event', event: message(at(7, 11), 'grok', usage(3))}], hasMore: false, cursor: 1}
      return pages[request.beforeSeq === undefined ? 0 : 1]
    }
  }
  const result = await backfillUsage(source, ledger, AbortSignal.timeout(5000), now)
  assert.deepEqual(result, {sessions: 2, failures: 0})
  assert.deepEqual(requests.filter(r => r.address.kind === 'session').map(r => r.beforeSeq), [undefined, 50])
  assert.deepEqual(requests.find(r => r.address.kind === 'subagent').address, {kind: 'subagent', parentSessionId: 'p', childSessionId: 'child', mode: 'unknown'})
  assert.equal(ledger.view(workspaces, now).total, 5 + 7 + 3)
})

test('records that leave the window are dropped as events arrive, at most once a minute', () => {
  const ledger = new UsageLedger(), now = Date.parse('2026-11-07T12:00:00')
  const call = (id: string, at: number) => ({type: 'assistant/message', seq: 1, time: at, data: {message: {id, source: {kind: 'model', model: 'm'}}, usage: {totalTokens: 1}}})
  ledger.observe('s', undefined, call('old', now - 8 * 86_400_000), now - 120_000)
  ledger.observe('s', undefined, call('new', now - 1000), now - 90_000)
  assert.equal(ledger.records.size, 2, 'pruned less than a minute ago')
  ledger.observe('s', undefined, call('newer', now), now)
  assert.deepEqual([...ledger.records.keys()], ['new', 'newer'])
})

test('cowork usage keeps billing sources separate when one session switches between models', () => {
  const ledger = new UsageLedger(), now = Date.parse('2026-11-21T12:00:00')
  for (const [provider, totalTokens] of [['org-models', 10], ['fig-grok-oauth', 4], ['local-api', 2], ['', 1]] as const) {
    ledger.observe('one-session', undefined, { type: 'assistant/message', time: now, data: {
      message: { id: provider, source: { kind: 'model', provider, model: 'model' } }, usage: { totalTokens }
    } }, now)
  }
  assert.deepEqual(ledger.view([], now).cells[6][12].sessions, [{ id: 'one-session', total: 17 }])
  assert.deepEqual(ledger.view([], now, ['org-models']).cells[6][12].sessions, [{ id: 'one-session', total: 17,
    sources: { organization: 10, 'personal-subscription': 4, 'personal-api': 2 } }])
})
