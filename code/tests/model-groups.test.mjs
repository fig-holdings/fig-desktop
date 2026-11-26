import assert from 'node:assert/strict'
import { test } from 'node:test'

// Each subscription package names its model picker group through shared/page-model-groups.js, against a stand-in
// for DSH's model directory internals. Both register, as in the page; unloading both restores the resolver. A name is
// the plugin's text function; here it follows `<html lang>` in place of DSH's locale.
async function load() {
  globalThis.document = { documentElement: { lang: 'zh-CN' } }
  const { nameModelGroup } = await import('../harness/shared/page-model-groups.js?' + Math.random())
  class ModelDirectoryResolver { directoryFor(id) { return this.directories[id] } }
  const modules = { '@deepseek-ai/dsh-client-ui-model-selection': { ModelDirectoryResolver } }
  delete globalThis[Symbol.for('fig.model-group-names')]
  const named = (zh, en) => () => /^zh/.test(document.documentElement.lang) ? zh : en
  const disposers = [nameModelGroup(name => modules[name], 'fig-grok-oauth', named('Grok 订阅', 'Grok Subscription')),
    nameModelGroup(name => modules[name], 'fig-chatgpt', named('ChatGPT 订阅', 'ChatGPT Subscription'))]
  const resolver = new ModelDirectoryResolver()
  resolver.unload = () => { for (const dispose of disposers) dispose() }
  return resolver
}

function directory(snapshot) {
  let state = snapshot
  return { store: { getSnapshot: () => state, set: value => { state = value } } }
}

test('the Grok and ChatGPT subscription groups are named for the page language', async () => {
  const resolver = await load()
  resolver.directories = { s1: directory({
    current: { provider: 'deepseek', model: 'v4' }, routable: true, failures: [],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [] }, { id: 'fig-grok-oauth', name: 'Grok Subscription', models: [] },
      { id: 'fig-chatgpt', name: 'ChatGPT Subscription', models: [] }]
  }) }
  assert.deepEqual(resolver.directoryFor('s1').store.getSnapshot().groups.map(group => group.name), ['DeepSeek', 'Grok 订阅', 'ChatGPT 订阅'])
  document.documentElement.lang = 'en'
  assert.deepEqual(resolver.directoryFor('s1').store.getSnapshot().groups.slice(1).map(group => group.name), ['Grok Subscription', 'ChatGPT Subscription'])
})

test('an unfamiliar model directory shape passes through untouched', async () => {
  const resolver = await load()
  const changed = { entries: [], current: null }
  resolver.directories = { s1: directory(changed), s2: undefined }
  assert.equal(resolver.directoryFor('s1').store.getSnapshot(), changed)
  assert.equal(resolver.directoryFor('s2'), undefined)
})

test('unloading restores the resolver and the stores it wrapped', async () => {
  const resolver = await load()
  const original = resolver.directoryFor
  const stored = directory({ groups: [{ id: 'fig-grok-oauth', name: 'Grok Subscription', models: [] }] })
  const read = stored.store.getSnapshot
  resolver.directories = { s1: stored }
  assert.notEqual(resolver.directoryFor('s1').store.getSnapshot, read)
  resolver.unload()
  assert.notEqual(resolver.directoryFor, original, 'the patched resolver is removed')
  assert.equal(stored.store.getSnapshot, read)
  assert.equal(resolver.directoryFor('s1').store.getSnapshot().groups[0].name, 'Grok Subscription')
})
