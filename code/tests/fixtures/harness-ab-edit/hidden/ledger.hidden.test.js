// Hidden acceptance tests for the A/B edit task: every behaviour in the fixture README.
import assert from 'node:assert/strict'
import test from 'node:test'
import { cost, parseEvents, summarize, topModels } from '../src/ledger.js'
import { dayKey } from '../src/time.js'

const e = (ts, model, input, cached, output) => ({ ts, model, input, cached, output })
const sample = [
  e('2026-11-05T15:30:00Z', 'grok-4.7', 1000, 600, 200),
  e('2026-11-05T17:10:00Z', 'grok-4.7', 500, 0, 100),
  e('2026-11-05T09:00:00Z', 'gpt-5.5', 2000, 1500, 50),
  e('2026-11-05T10:00:00Z', 'alpha', 1800, 0, 0)
]

test('H1 dayKey positive offset crosses midnight', () => assert.equal(dayKey('2026-11-05T16:00:00Z', 480), '2026-11-06'))
test('H2 dayKey negative offset goes back a day', () => assert.equal(dayKey('2026-11-05T03:00:00Z', -300), '2026-11-04'))
test('H3 dayKey half-hour offset', () => assert.equal(dayKey('2026-11-05T18:29:00Z', 330), '2026-11-05'))
test('H4 dayKey month and year rollover', () => assert.equal(dayKey('2026-12-31T20:00:00Z', 480), '2027-01-01'))
test('H5 summarize sums', () => assert.deepEqual(summarize(sample)['2026-11-05']['gpt-5.5'], { calls: 1, input: 2000, cached: 1500, uncached: 500, output: 50 }))
test('H6 summarize with negative offset', () => {
  const days = summarize([e('2026-11-05T03:00:00Z', 'm', 10, 0, 1)], { offsetMinutes: -300 })
  assert.deepEqual(Object.keys(days), ['2026-11-04'])
})
test('H7 parseEvents skips bad JSON without throwing', () => {
  const r = parseEvents('{"ts":"2026-11-05T00:00:00Z","model":"m","input":1,"cached":0,"output":1}\nnot json\n\n{"model":"m"}\n')
  assert.equal(r.events.length, 1); assert.equal(r.skipped, 2)
})
test('H8 topModels ties broken by id', () => assert.deepEqual(topModels(sample, 3), ['gpt-5.5', 'alpha', 'grok-4.7']))
test('H9 topModels n larger than models', () => assert.equal(topModels(sample, 10).length, 3))
test('H10 topModels n <= 0', () => { assert.deepEqual(topModels(sample, 0), []); assert.deepEqual(topModels(sample, -1), []) })
test('H11 cost with all prices', () => {
  const prices = { 'grok-4.7': { input: 2, cached: 0.5, output: 10 }, 'gpt-5.5': { input: 1, cached: 0.1, output: 8 }, alpha: { input: 1, cached: 1, output: 1 } }
  const r = cost(sample, prices)
  assert.equal(r.byModel['grok-4.7'], 0.0051); assert.equal(r.byModel['gpt-5.5'], 0.00105); assert.equal(r.byModel.alpha, 0.0018); assert.equal(r.total, 0.00795); assert.deepEqual(r.unknown, [])
})
test('H12 cost unknown model is not free', () => {
  const r = cost(sample, { 'grok-4.7': { input: 2, cached: 0.5, output: 10 }, 'gpt-5.5': { input: 1, cached: 0.1, output: 8 } })
  assert.equal(r.total, null); assert.equal(r.byModel.alpha, null); assert.deepEqual(r.unknown, ['alpha'])
})
