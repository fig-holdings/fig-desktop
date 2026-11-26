import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { subscriptionModelPreferences } from '../harness/shared/subscription-model-preferences.js'
import { withMediumDefault } from '../harness/shared/subscription-adapter.js'

const first = { id: 'gpt-first', input: ['text'] }
const second = { id: 'gpt-second', input: ['text', 'image'] }
const unknown = { id: 'gpt-unconfirmed' }
const models = [first, second, unknown]
const discover = async () => models

async function newPreferences(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fig-chatgpt-menu-test-'))
  t.after(() => rm(dir, { recursive: true }))
  const path = join(dir, 'menu.json')
  return { path, preferences: subscriptionModelPreferences(path) }
}

test('ChatGPT shows one model by default, persists choices across instances, and supports hiding all', async t => {
  const { path, preferences } = await newPreferences(t)
  assert.deepEqual(await preferences.visible([first, second]), [first])
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.deepEqual(await preferences.save([second.id, second.id], discover), { models, selected: [second.id] })
  const reopened = subscriptionModelPreferences(path)
  assert.deepEqual(await reopened.visible([first, second]), [second])
  assert.deepEqual(await reopened.visible([first]), [], 'removal does not silently enable a different model')
  await reopened.save([], discover)
  assert.deepEqual(await preferences.visible([first, second]), [], 'an explicit empty selection is not a first-run default')
})

test('ChatGPT preferences reject stale or unsupported selections; a damaged file reads as absent and a save repairs it', async t => {
  const { path, preferences } = await newPreferences(t)
  for (const invalid of [null, [null], [unknown.id], ['gpt-removed']]) {
    await assert.rejects(preferences.save(invalid, discover))
  }
  await preferences.save([first.id], discover)
  assert.deepEqual(await preferences.visible([first, second]), [first])
  await writeFile(path, '{invalid')
  assert.deepEqual(await preferences.visible([first, second]), [first], 'the first-run default, not an empty menu')
  await preferences.save([second.id], discover)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ids: [second.id] })
})

test('ChatGPT defaults to Medium only when the resolved model offers that exact effort', () => {
  const efforts = [{ id: 'low' }, { id: 'medium' }, { id: 'high' }]
  const adjustable = { id: first.id, reasoning: { efforts } }
  const noMedium = { id: second.id, reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } }
  assert.deepEqual(withMediumDefault(adjustable), { ...adjustable, reasoning: { efforts, defaultEffort: 'medium' } })
  assert.equal(adjustable.reasoning.defaultEffort, undefined)
  assert.equal(withMediumDefault(noMedium), noMedium)
  assert.equal(withMediumDefault(first), first)
})
