import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEvents, summarize, topModels } from '../src/ledger.js'
import { dayKey } from '../src/time.js'

const sample = [
  { ts: '2026-11-05T15:30:00Z', model: 'grok-4.7', input: 1000, cached: 600, output: 200 },
  { ts: '2026-11-05T17:10:00Z', model: 'grok-4.7', input: 500, cached: 0, output: 100 },
  { ts: '2026-11-05T09:00:00Z', model: 'gpt-5.5', input: 2000, cached: 1500, output: 50 }
]

test('dayKey honours the UTC offset', () => {
  assert.equal(dayKey('2026-11-05T17:10:00Z', 480), '2026-11-06')
  assert.equal(dayKey('2026-11-05T17:10:00Z', 0), '2026-11-05')
})

test('summarize treats cached as part of input', () => {
  const days = summarize(sample)
  assert.deepEqual(days['2026-11-05']['grok-4.7'], { calls: 2, input: 1500, cached: 600, uncached: 900, output: 300 })
})

test('summarize splits days at the local midnight', () => {
  const days = summarize(sample, { offsetMinutes: 480 })
  assert.equal(days['2026-11-05']['grok-4.7'].calls, 1)
  assert.equal(days['2026-11-06']['grok-4.7'].calls, 1)
})

test('topModels orders by total tokens', () => {
  assert.deepEqual(topModels(sample, 1), ['gpt-5.5'])
})

test('parseEvents reads JSON lines', () => {
  const { events } = parseEvents(sample.map(event => JSON.stringify(event)).join('\n'))
  assert.equal(events.length, 3)
})
