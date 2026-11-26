import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installNativeDiscovery } from '../harness/shell-bridge/native-model-catalog.js'
import { apiDirectory } from '../harness/shell-bridge/api-model-discovery.js'
import { catalogModels as grok } from '../harness/provider-grok/index.js'
import { catalogModels as chatgpt } from '../harness/provider-chatgpt/index.js'

class Failure extends Error {
  constructor(message, code) { super(message); this.code = code }
}

test('API catalog honors revocation, key changes, authoritative removal and same-key offline reads', async t => {
  const profile = { apiKeyEnv: 'TEST_KEY' }
  let key = 'first', status = 200, models = [{ id: 'grok-private', input_modalities: ['text', 'image'] }]
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.x.ai/v1/language-models')
    requests.push(options.headers.get('authorization'))
    if (!status) throw Error('offline')
    return Response.json({ models }, { status })
  })
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { xai: profile } } }] }
  const credentials = { resolve: async () => ({ value: key }) }
  const ctx = { get: name => ({ settings, credentials })[name] }
  const directory = apiDirectory({ xai: {} }, Failure, () => '')
  const read = (force = false, draft = {}) => directory(ctx, 'xai', draft, force)
  assert.deepEqual((await read()).rows.get('grok-private').model.input, ['text', 'image'])
  await read()
  assert.deepEqual(requests, ['Bearer first'])
  status = 503
  assert.ok((await read(true)).rows.has('grok-private'))
  // The unsaved key must not evict the active account's offline cache
  await assert.rejects(read(true, { apiKey: 'draft' }), { code: 'TRANSPORT' })
  assert.ok((await read(true)).rows.has('grok-private'))
  key = 'second'
  await assert.rejects(read(), { code: 'TRANSPORT' })
  status = 200
  assert.ok((await read()).rows.has('grok-private'))
  models = []
  assert.equal((await read(true)).rows.size, 0)
  status = 401
  await assert.rejects(read(true), { code: 'AUTH' })
  status = 0
  await assert.rejects(read(), { code: 'TRANSPORT' })
  key = undefined
  assert.equal((await read()).rows.size, 0)
  profile.baseURL = 'https://custom.invalid/v1'
  assert.equal(await read(true, { baseURL: 'https://api.x.ai/v1' }), undefined)
})

test('a directory page that is not JSON is an invalid directory, and its text never reaches the picker', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<!DOCTYPE html><p>sign in to the hotel wifi', { status: 200 }))
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { xai: { apiKeyEnv: 'TEST_KEY' } } } }] }
  const ctx = { get: name => ({ settings, credentials: { resolve: async () => ({ value: 'k' }) } })[name] }
  await assert.rejects(apiDirectory({ xai: {} }, Failure, () => '')(ctx, 'xai'),
    error => error.code === 'DISCOVERY_FAILED' && !/DOCTYPE|wifi/.test(error.message))
})

test('unknown protocols and non-chat outputs stay out of the session picker', async t => {
  const id = 'grok-sample'
  assert.deepEqual(grok({ data: [{ id, api_backend: 'future' }, { id, output_modalities: ['video'] }] }), [])
  assert.deepEqual(chatgpt({ models: [{ slug: id, visibility: 'list', api_backend: 'future' }] }), [])
  t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [
    { id, api_backend: 'future', input_modalities: ['text', 'image'] },
    { id: 'audio-only', output_modalities: ['audio'] },
    { id: 'verified', aliases: ['alias'], input_modalities: ['text', 'image'] }
  ] }))
  const directory = apiDirectory({ xai: {} }, Failure, () => '')
  const { rows } = await directory({ get: () => undefined }, 'xai', { apiKey: 'draft' })
  for (const name of [id, 'audio-only']) {
    assert.ok(rows.has(name))
    assert.equal(rows.get(name).model, undefined)
  }
  assert.deepEqual(rows.get('alias').model.input, ['text', 'image'])
})

test('a public OpenAI card must affirm Responses support and the documentation gets no account secrets', async t => {
  const candidates = ['public-supported', 'public-unsupported', 'private-name']
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.openai.com/v1/models') {
      assert.equal(options.headers.get('authorization'), 'Bearer synthetic')
      return Response.json({ data: candidates.map(id => ({ id })) })
    }
    assert.equal(new Headers(options.headers).has('authorization'), false)
    requests.push(url)
    if (url.endsWith('/models.md')) return new Response(candidates.slice(0, 2).map(id => '[' + id + '](/api/docs/models/' + id + '.md)').join('\n'))
    const support = url.endsWith('/public-supported.md') ? 'Supported' : 'Not supported'
    return new Response('- Input modalities: text, image\n- Output modalities: text\n| Responses | `v1/responses` | ' + support + ' |')
  })
  const directory = apiDirectory({ openai: {} }, Failure, () => '')
  const { rows } = await directory({ get: () => undefined }, 'openai', { apiKey: 'synthetic' }, true)
  assert.deepEqual(rows.get(candidates[0]).model.input, ['text', 'image'])
  assert.equal(rows.get(candidates[1]).model, undefined)
  assert.equal(rows.get(candidates[2]).model, undefined)
  assert.ok(!requests.some(url => url.includes('private-name')))
})

test('native settings discover all candidates while a configured subset and its explicit input govern sessions', async t => {
  const chosen = 'future-offered'
  const catalog = { models: [
    { id: chosen, input_modalities: ['text', 'image'] }, { id: 'text-sibling' }, { id: 'future-protocol', api_backend: 'unsupported' }
  ] }
  t.mock.method(globalThis, 'fetch', async () => Response.json(catalog))
  const raw = { apiKeyEnv: 'TEST_KEY', models: [{ id: chosen, input: ['text'] }] }
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { xai: raw } } }] }
  const credentials = { resolve: async () => ({ value: 'synthetic' }) }
  class Runtime {
    ctx = { get: name => ({ settings, credentials })[name], emit() {} }
    registerAdapter(_providers, adapter) { return adapter }
    registerModelDiscovery(_ns, discover) { return discover }
  }
  class Adapter {
    constructor(config) { this.config = config }
    listModels(provider) { return this.config.profiles().get(provider).piProvider.getModels() }
    prepareCall() { throw Error('unused') }
  }
  const profile = { piProvider: { getModels: () => raw.models } }
  installNativeDiscovery({ LlmRuntime: Runtime, PiAiAdapter: Adapter, LlmError: Failure, credentialKey: () => '', known: { xai: {} } })
  const runtime = new Runtime()
  const discover = runtime.registerModelDiscovery('llm-pi-ai', () => [])
  assert.deepEqual((await discover({ provider: 'xai' })).map(m => m.id), catalog.models.map(m => m.id))
  const adapter = runtime.registerAdapter(['xai'], new Adapter({ profiles: () => new Map([['xai', profile]]) }))
  const models = await adapter.listModels('xai')
  assert.deepEqual(models.map(m => [m.id, m.input]), [[chosen, ['text']]])
  catalog.models = []
  await discover({ provider: 'xai' })
  assert.deepEqual(await adapter.listModels('xai'), [])
})
