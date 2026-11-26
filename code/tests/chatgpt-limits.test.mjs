import assert from 'node:assert/strict'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexLimits, limitsFrom, limitsFromLog } from '../harness/provider-chatgpt/limits.js'
import { tempDir } from './helpers/temp-dir.mjs'

// The shapes Codex 0.166 uses (values synthetic): the app server reply and a session file record.
const reply = snapshot => ({
  rateLimits: { limitId: 'codex', primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1 }, secondary: null, planType: 'plus' },
  rateLimitsByLimitId: { codex: {
    limitId: 'codex', planType: 'pro',
    primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1794000000 },
    secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: 1794106715 },
    ...snapshot
  } }
})
const record = (timestamp, percent, limitId = 'codex') => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: {
  limit_id: limitId, primary: { used_percent: percent, window_minutes: 10080, resets_at: 1794106715 }, secondary: null, plan_type: 'pro'
} } })

test('the codex bucket is read, longest window first, with the plan', () => {
  assert.deepEqual(limitsFrom(reply()), {
    windows: [
      { usedPercent: 47, minutes: 10080, resetsAt: new Date(1794106715000).toISOString() },
      { usedPercent: 12.5, minutes: 300, resetsAt: new Date(1794000000000).toISOString() }
    ],
    plan: 'pro'
  })
  assert.equal(limitsFrom(reply({ primary: null, secondary: null })), undefined)
  assert.equal(limitsFrom({}), undefined)
  assert.equal(limitsFrom(reply({ primary: { usedPercent: 140, windowDurationMins: 10080 }, secondary: null })).windows[0].usedPercent, 100)
})

test('a session file gives the newest codex limits and skips other buckets and broken lines', () => {
  const text = ['partial line', record('2026-11-06T10:00:00Z', 40), 'not json "rate_limits"', record('2026-11-06T11:00:00Z', 45), record('2026-11-06T12:00:00Z', 90, 'other')].join('\n')
  assert.deepEqual(limitsFromLog(text), { windows: [{ usedPercent: 45, minutes: 10080, resetsAt: new Date(1794106715000).toISOString() }], plan: 'pro', source: 'log', fetchedAt: '2026-11-06T11:00:00Z' })
  assert.equal(limitsFromLog('no limits here'), undefined)
})

test('cached limits answer without Codex; live ones are kept a minute and fall back to the session files', async t => {
  const codexHome = await tempDir(t, 'fig-codex-')
  let reads = 0
  const service = codexLimits({ codexHome, find: async () => ({}), read: async () => { reads++; return { limits: reply(), account: { type: 'chatgpt', email: 'me@example.com' } } } })
  assert.deepEqual(await service.cached(), {}, 'nothing at hand yet, and Codex is not started')
  assert.equal(reads, 0)
  const day = join(codexHome, 'sessions/2026/11/06')
  await mkdir(day, { recursive: true })
  await writeFile(join(day, 'old.jsonl'), record('2026-11-06T09:00:00Z', 30) + '\n')
  await writeFile(join(day, 'new.jsonl'), record('2026-11-06T12:43:05Z', 47) + '\n')
  await utimes(join(day, 'old.jsonl'), new Date(0), new Date(0))
  assert.equal((await service.cached()).fetchedAt, '2026-11-06T12:43:05Z')
  assert.equal(reads, 0)

  const live = await service.live()
  assert.equal(live.source, 'live')
  assert.equal(live.email, 'me@example.com')
  assert.equal(live.windows.length, 2)
  assert.deepEqual(await service.cached(), live, 'the last live read is at hand afterwards')
  await service.live()
  assert.equal(reads, 1, 'one Codex run per minute')
  await service.live({ refresh: true })
  assert.equal(reads, 2)

  const failing = codexLimits({ codexHome, find: async () => ({}), read: async () => { throw new Error('x') } })
  assert.equal((await failing.live()).source, 'log', 'a failed live read falls back to the session files')
  const empty = await tempDir(t, 'fig-codex-empty-')
  assert.deepEqual(await codexLimits({ codexHome: empty, find: async () => undefined }).live(), { unavailable: 'missing' })
  assert.deepEqual(await codexLimits({ codexHome: empty, find: async () => ({}), read: async () => { throw new Error('x') } }).live(), { unavailable: 'failed' })
})
