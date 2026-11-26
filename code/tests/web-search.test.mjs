import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../harness/web-search/index.js'
import { nativeSearch } from '../harness/shared/native-search.js'
import { searchModelRoute } from '../harness/web-search/model-route.js'

const request = { query: 'Electron', maxResults: 3 }
const citation = { type: 'url_citation', title: 'Electron', url: 'https://www.electronjs.org/' }
const completed = { output: [{ type: 'web_search_call', status: 'completed' },
  { type: 'message', content: [{ annotations: [citation] }] }] }

test('follow-model binds each tool call to its initiating model and rejects a stale route', async () => {
  let selected
  const routes = new Map()
  const ctx = { inject() {}, web: { registerSearchProvider(p) { routes.set(p.id, p) } },
    get(service) {
      if (service === 'agents') return { currentInitiator: () => ({ session: { requestContext: () => selected } }) }
      if (['figGrokSearch', 'figChatgptSearch'].includes(service)) return { search: async model => ({ service, model }) }
    } }
  apply(ctx)
  const follow = routes.get('fig-follow-model')
  selected = { provider: 'fig-grok-oauth', model: 'grok-model' }
  const one = follow.search({ ...request, llmProvider: selected.provider })
  selected = { provider: 'fig-chatgpt', model: 'chat-model' }
  const two = follow.search({ ...request, llmProvider: selected.provider })
  assert.deepEqual(await Promise.all([one, two]), [
    { service: 'figGrokSearch', model: 'grok-model' }, { service: 'figChatgptSearch', model: 'chat-model' }])
  await assert.rejects(follow.search({ ...request, llmProvider: 'mismatch' }))
  selected = undefined
  await assert.rejects(follow.search(request))
})

test('personal API search uses the selected endpoint, model and credential, including for a custom route', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    return Response.json(completed)
  })
  const profile = { api: 'openai-responses', baseURL: 'https://gateway.example/v1', apiKeyEnv: 'MY_API' }
  const ctx = { llm: { listConfigurableProviders: () => [{ provider: 'custom', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'custom'], declared: true }] },
    get(name) {
      if (name === 'llm') return this.llm
      if (name === 'settings') return { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { custom: profile } } }] }
      if (name === 'credentials') return { resolve: async ref => { assert.equal(ref, 'MY_API'); return { value: 'test-key' } } }
    } }
  const route = { provider: 'custom', model: 'user-selected-id' }
  const found = await searchModelRoute(ctx, route, request)
  assert.deepEqual(found.sources, [{ url: citation.url, title: citation.title }])
  const { url, options } = requests[0]
  assert.equal(url, profile.baseURL + '/responses')
  assert.equal(options.headers.authorization, 'Bearer test-key')
  assert.equal(JSON.parse(options.body).model, route.model)
  assert.equal(options.redirect, 'error')
  profile.api = 'openai-completions'
  await assert.rejects(searchModelRoute(ctx, route, request))
  assert.equal(requests.length, 1)
})

test('Brave uses only its own key; a refused search and an unsupported model never fall back', async t => {
  const routes = new Map()
  let key
  const calls = []
  apply({ web: { registerSearchProvider: p => routes.set(p.id, p) }, inject() {},
    get: () => ({ resolve: async ref => { assert.equal(ref, 'BRAVE_SEARCH_API_KEY'); return { value: key } } }) })
  const brave = routes.get('fig-brave-search')
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push(String(url))
    assert.equal(opts.headers['X-Subscription-Token'], key)
    assert.equal(opts.headers.authorization, undefined)
    return new Response(null, { status: 429 })
  })
  await assert.rejects(brave.search(request))
  key = 'brave-test'
  await assert.rejects(brave.search(request), /429/)
  assert.deepEqual(calls, ['https://api.search.brave.com/res/v1/web/search?q=Electron&count=3'])
})

test('streamed hosted search accepts citations and rejects an answer made of prose alone', async t => {
  let result = completed
  t.mock.method(globalThis, 'fetch', async () => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: result }) + '\n\n',
    { headers: { 'content-type': 'text/event-stream' } }))
  const route = { api: 'openai-responses', model: 'a', baseURL: 'https://model.example/v1', headers: {} }
  assert.equal((await nativeSearch(route, request)).sources[0].url, citation.url)
  result = { output: [{ type: 'message', content: [{ text: 'I searched' }] }] }
  await assert.rejects(nativeSearch(route, request))
})

test('a hosted search the service stops reports the failure, not a model without search; an incomplete one keeps its sources', async t => {
  let events = []
  t.mock.method(globalThis, 'fetch', async () => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } }))
  const route = { api: 'openai-responses', model: 'a', baseURL: 'https://model.example/v1', headers: {} }
  events = [{ type: 'error', error: { code: 'rate_limit_exceeded', message: 'secret upstream text' } }]
  await assert.rejects(nativeSearch(route, request), error => /rate_limit_exceeded/.test(error.message)
    && !/secret|native search|原生搜索/.test(error.message))
  events = [{ type: 'response.failed', response: { error: { code: 'server error!' } } }]
  await assert.rejects(nativeSearch(route, request), error => /搜索服务中途出错。/.test(error.message))
  events = [{ type: 'response.incomplete', response: completed }]
  assert.equal((await nativeSearch(route, request)).sources[0].url, citation.url)
})

test('subscription search accepts an event stream without a content type', async t => {
  const event = { type: 'response.completed', response: completed }
  const encoder = new TextEncoder()
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('eve'))
    controller.enqueue(encoder.encode('nt: response.completed\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n'))
    controller.close()
  } })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream))
  const result = await nativeSearch({ api: 'openai-responses', model: 'gpt-6.1-sol',
    baseURL: 'https://api.openai.com/v1', headers: {} }, request)
  assert.deepEqual(result.sources, [{ url: citation.url, title: citation.title }])
})

test('team sessions use the Cowork search service and cannot borrow a personal search key for an organization model', async () => {
  const services = new Map(), providers = new Map()
  services.set('agents', { currentInitiator: () => ({ session: { requestContext: () => ({ provider: 'organization', model: 'one' }) } }) })
  const ctx = { get: service => services.get(service), inject() {}, provide: (key, value) => services.set(key, value),
    web: { registerSearchProvider: provider => providers.set(provider.id, provider) } }
  apply(ctx, { team: true, organizationProviders: ['organization'] })
  const request = { query: 'synthetic', llmProvider: 'organization' }
  assert.equal(providers.has('fig-brave-search'), false)
  await assert.rejects(providers.get('fig-follow-model').search(request))
  await assert.rejects(async () => services.get('figNativeModelSearch').search(request))
  const result = { sources: [{ url: 'https://example.com' }], truncated: false }
  services.set('figCoworkSearch', { search: received => { assert.equal(received, request); return result } })
  assert.equal(await providers.get('fig-follow-model').search(request), result)
})
