import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogModels, isIdleTimeout, largeFileRule, oauthAccessToken, refreshGate, stallGuard, withLargeFileRule } from '../harness/provider-grok/index.js'
import { loginRequired } from '../harness/provider-grok/shared'
import { noStoredAuth, piProfiles } from '../harness/shared/pi-ai.js'
import { signedInModels, subscriptionAdapter } from '../harness/shared/subscription-adapter.js'

const scope = 'https://auth.x.ai::12345678-1234-1234-1234-123456789abc'
const accessToken = 'synthetic-access-token-for-unit-test'
const entry = {
  auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai',
  key: accessToken, expires_at: '2030-01-01T00:00:00Z'
}
const now = Date.parse('2029-01-01T00:00:00Z')

test('Grok uses the current first-party CLI OAuth record and rejects other credentials', () => {
  assert.equal(oauthAccessToken({ [scope]: entry }, now), accessToken)
  assert.equal(oauthAccessToken({ [scope]: { ...entry, auth_mode: 'api_key' } }, now), undefined)
  assert.equal(oauthAccessToken({ [scope]: { ...entry, key: 'xai-synthetic-api-key-for-unit-test' } }, now), undefined)
  assert.equal(oauthAccessToken({ ['https://example.test::' + scope.split('::')[1]]: entry }, now), undefined)
  assert.equal(oauthAccessToken({ [scope]: entry }, Date.parse(entry.expires_at)), undefined)
  assert.equal(oauthAccessToken({ [scope]: { ...entry, key: accessToken + '-renewed' } }, now), accessToken + '-renewed')
})

test('Grok catalog takes the account models and their protocols from discovery', () => {
  const catalog = catalogModels({ data: [
    { id: 'grok-4.7', api_backend: 'responses', context_window: 256000 },
    { id: 'grok-new', api_backend: 'chat_completions', name: 'Grok New' },
    { id: 'grok-another', api_backend: 'messages' },
    { id: 'other-model' }, { id: 'grok-invalid\nheader' }
  ] })
  assert.deepEqual(catalog.map(({ id, api }) => [id, api]), [
    ['grok-4.7', 'openai-responses'],
    ['grok-new', 'openai-completions'],
    ['grok-another', 'anthropic-messages']
  ])
  assert.equal(catalog[0].contextWindow, 256000)
  assert.equal(catalog[1].name, 'Grok New')
})

test('Grok catalog takes the largest offered window and leaves the output limit to the window', () => {
  const [large, plain, capped] = catalogModels({ data: [
    { id: 'grok-4.7', context_window: 256000, context_windows: [256000, 500000], max_completion_tokens: null },
    { id: 'grok-plain' },
    { id: 'grok-capped', context_window: 256000, max_completion_tokens: 32000 }
  ] })
  assert.deepEqual([large.contextWindow, large.maxTokens], [500000, 500000])
  assert.deepEqual([plain.contextWindow, plain.maxTokens], [131072, 131072])
  assert.deepEqual([capped.contextWindow, capped.maxTokens], [256000, 32000])
})

test('Grok catalog skips hidden models and offers the efforts each model lists', () => {
  const catalog = catalogModels({ data: [
    { id: 'grok-4.7', supports_reasoning_effort: true, reasoning_effort: 'high', reasoning_efforts: [
      { value: 'xhigh', label: 'Extra High' }, { value: 'high', label: 'High' }, { value: 'low', label: 'Low' }, { value: 'turbo' }
    ] },
    { id: 'grok-plain', supports_reasoning_effort: true },
    { id: 'grok-internal', hidden: true }
  ] })
  assert.deepEqual(catalog.map(({ id, reasoning }) => [id, reasoning]), [['grok-4.7', true], ['grok-plain', false]])
  const [model] = catalog
  assert.deepEqual(model.dshReasoning, {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'xhigh', name: 'Extra High' }],
    defaultEffort: 'high'
  })
  // The proxy rejects `effort: 'none'` (verified 2026-11-04), so off must omit the field.
  assert.equal(model.thinkingLevelMap.off, null)
  assert.equal(model.thinkingLevelMap.medium, null)
  assert.equal(model.thinkingLevelMap.xhigh, 'xhigh')
})

test('Grok prefers Medium over the account default only when the model offers it', () => {
  const [model] = catalogModels({ data: [{ id: 'grok-medium', supports_reasoning_effort: true, reasoning_effort: 'high',
    reasoning_efforts: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Balanced' }] }] })
  assert.deepEqual(model.dshReasoning, {
    efforts: [{ id: 'medium', name: 'Balanced' }, { id: 'high', name: 'High' }], defaultEffort: 'medium'
  })
  assert.equal(model.thinkingLevelMap.medium, 'medium')
})

test('requests with tools carry the large-file rule once; plain requests stay as they are', () => {
  const tools = [{ name: 'write' }]
  const first = withLargeFileRule({ system: 'Base prompt', tools })
  assert.equal(first.system, 'Base prompt\n\n' + largeFileRule)
  assert.equal(withLargeFileRule(first).system, first.system, 'not added twice')
  assert.equal(withLargeFileRule({ tools }).system, largeFileRule)
  const plain = { system: 'Title prompt' }
  assert.equal(withLargeFileRule(plain), plain)
})

test('an idle timeout of the same request is retried once, then stops', () => {
  const guard = stallGuard()
  const request = { sessionId: 's1', messages: [{ id: 'm1' }, { id: 'm2' }] }
  assert.ok(isIdleTimeout({ code: 'TIMEOUT', message: 'pi-ai stream idle timeout after 600000ms' }))
  assert.ok(!isIdleTimeout({ code: 'TIMEOUT', message: 'request timed out' }))
  assert.equal(guard.failed(request), false, 'the first timeout keeps DSH\'s retry')
  assert.equal(guard.failed({ ...request, messages: [...request.messages] }), true, 'the retry of the same messages stops')
  assert.equal(guard.failed({ sessionId: 's1', messages: [...request.messages, { id: 'm3' }] }), false, 'a later step starts over')
  guard.passed(request)
  assert.equal(guard.failed(request), false, 'a completed request clears its count')
})

test('a refresh during the backoff is skipped and never moves the backoff start', async () => {
  let clock = 0, attempts = 0, fail = true
  const gate = refreshGate(async () => { attempts++; if (fail) throw new Error('synthetic refresh failure') }, { backoff: 60_000, now: () => clock })
  assert.equal(await gate.refresh(), true); assert.equal(attempts, 1)
  for (clock = 10_000; clock < 60_000; clock += 10_000) assert.equal(await gate.refresh(), false)
  assert.equal(attempts, 1)
  clock = 60_000; fail = false
  assert.equal(await gate.refresh(), true, 'the backoff runs from the failed attempt, not from later skipped calls')
  assert.equal(attempts, 2)
  // A completed refresh that yields no usable token is marked by the caller.
  gate.failed(); clock = 61_000
  assert.equal(await gate.refresh(), false)
  gate.reset(); assert.equal(await gate.refresh(), true); assert.equal(attempts, 3)
  const shared = refreshGate(() => new Promise(resolve => setTimeout(resolve, 10)))
  assert.deepEqual(await Promise.all([shared.refresh(), shared.refresh()]), [true, true])
  assert.equal(await refreshGate(async () => { attempts++ }, { blocked: () => true }).refresh(), false)
  assert.equal(attempts, 3)
})

test('signed out with no catalog lists no models; other failures still surface', async () => {
  assert.deepEqual(await signedInModels(async () => { throw Object.assign(new Error('signed out'), { code: loginRequired }) }, loginRequired), [])
  await assert.rejects(signedInModels(async () => { throw Object.assign(new Error('network'), { code: 'TRANSPORT' }) }, loginRequired), /network/)
  assert.deepEqual(await signedInModels(async () => [{ id: 'grok-synthetic' }], loginRequired), [{ id: 'grok-synthetic' }])
})

test('the subscription adapter caches the catalog per sign-in, clears it while signed out and maps stream failures', async () => {
  class LlmAdapter {}
  let session = { key: 'token-1' }, loads = 0, rejected = 0
  const chunks = [{ type: 'text-delta', text: 'hi' }, { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: '401 token=secret' } } }]
  const piAdapter = {
    resolveModel: async (_route, model) => ({ id: model }),
    prepareCall: async () => ({ config: { a: 1 }, async *stream(options) { yield { type: 'options', options }; yield* chunks } })
  }
  const { adapter, catalogs } = subscriptionAdapter({
    LlmAdapter, provider: 'p', displayName: 'P', loginRequired, ttl: 60_000,
    current: async () => {
      if (!session) throw Object.assign(new Error('signed out'), { code: loginRequired })
      return { key: session.key, load: async () => { loads++; return { models: [{ id: 'grok-a', name: 'A', input: ['text'], extra: 'x' }], adapter: piAdapter } } }
    },
    safeFailure: (code, message) => /401/.test(message) ? { code: loginRequired, message: 'sign in again' } : { code, message: 'failed' },
    rejected: () => { rejected++ },
    listed: model => ({ extra: model.extra }),
    resolved: (info, model, { models }) => ({ ...info, known: models.some(item => item.id === model) }),
    around: async function* (stream, options) { yield* stream({ ...options, wrapped: true }) }
  })
  assert.ok(adapter instanceof LlmAdapter)
  assert.deepEqual(await adapter.listModels(), [{ provider: 'p', id: 'grok-a', name: 'A', inputModalities: ['text'], extra: 'x' }])
  assert.deepEqual(await adapter.resolveModel('p', 'grok-a'), { id: 'grok-a', known: true })
  assert.equal(loads, 1, 'one catalog per sign-in')
  const prepared = await adapter.prepareCall('p', 'grok-a')
  assert.deepEqual(prepared.config, { a: 1 })
  const seen = []
  for await (const chunk of prepared.stream({ model: 'grok-a' })) seen.push(chunk)
  assert.deepEqual(seen[0], { type: 'options', options: { model: 'grok-a', wrapped: true } })
  assert.deepEqual(seen.at(-1).reason.failure, { code: loginRequired, message: 'sign in again' }, 'upstream text is replaced')
  assert.equal(rejected, 1)
  session = undefined
  assert.equal((await adapter.listModels()).length, 0, 'sign-out removes the previous account catalog')
  catalogs.clear()
  assert.deepEqual(await adapter.listModels(), [], 'signed out without a catalog lists nothing')
  await assert.rejects(adapter.prepareCall('p', 'grok-a'), /signed out/, 'a request needs a sign-in')
  session = { key: 'token-2' }
  await adapter.listModels()
  assert.equal(loads, 2, 'a new sign-in reloads the catalog')
})

test('the pi-ai profile serves the catalog through the provider call and passes on only the resolved token', async () => {
  const models = [{ id: 'grok-a' }]
  const call = method => () => method
  const profiles = piProfiles({ provider: 'p', displayName: 'P', baseUrl: 'https://example.test/v1', models, call, retryPolicy: 'retry', headers: { h: '1' }, streamIdleTimeoutMs: 5 })
  const profile = profiles.get('p')
  assert.deepEqual([...profiles.keys()], ['p'])
  assert.equal(profile.piProvider.getModels(), models)
  assert.deepEqual([profile.piProvider.stream(), profile.piProvider.streamSimple()], ['stream', 'streamSimple'])
  assert.deepEqual(await profile.piProvider.auth.apiKey.resolve({ credential: { key: 'token' } }), { auth: { apiKey: 'token' }, source: 'P' })
  assert.deepEqual([profile.headers, profile.retryPolicy, profile.streamIdleTimeoutMs, profile.maxRequestImageBytes], [{ h: '1' }, 'retry', 5, 20 * 1024 * 1024])
  assert.equal(piProfiles({ provider: 'p', displayName: 'P', baseUrl: '', models, call, retryPolicy: 'retry', streamIdleTimeoutMs: 5 }).get('p').headers.constructor, Object)
  assert.deepEqual(await Promise.all([noStoredAuth.credentials.read(), noStoredAuth.credentials.list(), noStoredAuth.authContext.env(), noStoredAuth.authContext.fileExists()]), [undefined, [], undefined, false])
})
