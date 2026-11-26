import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { accountRoute, catalogModels } from '../harness/provider-chatgpt/index.js'
import { PublicError } from '../harness/shared/http.js'
import { agentName, chatgptSession, grantCredential, loginRequired, safeFailure } from '../harness/provider-chatgpt/session.js'
import { uiText } from '../harness/shared/ui-text'
import { tempDir } from './helpers/temp-dir.mjs'

const credential = (access, expires) => ({ type: 'oauth', access, refresh: 'synthetic-refresh', expires, clientId: 'oaiapp_synthetic', scopes: [] })

function memoryStore() {
  const records = new Map()
  let operations = Promise.resolve()
  const enqueue = operation => {
    const task = operations.then(operation)
    operations = task.then(() => {}, () => {})
    return task
  }
  return {
    records,
    readRecord: async key => records.get(key),
    async modifyRecord(key, mutate) {
      return enqueue(async () => {
        const current = records.get(key)
        const next = await mutate(current)
        // Match DSH credentials-local: undefined means no change, not deletion.
        if (next !== undefined) records.set(key, next)
        return next ?? current
      })
    },
    deleteRecord: key => enqueue(() => { records.delete(key) })
  }
}

/** A stand-in for pi-ai's Sign in with ChatGPT: announces a URL, then finishes when told. */
function fakeOAuth() {
  const calls = { logins: [], refreshes: 0 }
  let finish
  return {
    calls,
    finish: value => finish(value),
    login(interaction, options) {
      calls.logins.push({ deviceId: options.getDeviceId(), agentName: options.agentName })
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/api/accounts/authorize?synthetic' })
      return new Promise((resolve, reject) => {
        finish = value => value instanceof Error ? reject(value) : resolve(value)
        interaction.signal.addEventListener('abort', () => reject(new Error('Login cancelled')), { once: true })
      })
    },
    async refresh(stale) {
      calls.refreshes++
      if (calls.failRefresh) throw new Error('OpenAI OAuth token request failed (400): invalid_grant')
      return credential(stale.access + '-renewed', Date.now() + 3_600_000)
    }
  }
}

async function setup(t) {
  const credentials = memoryStore()
  const oauth = fakeOAuth()
  const hostPath = join(await tempDir(t, 'fig-chatgpt-'), 'fig', 'chatgpt-host.json')
  return { credentials, oauth, hostPath, session: chatgptSession({ credentials, key: 'fig-chatgpt:subscription', oauth, hostPath }) }
}

test('ChatGPT catalog lists the account models with pi-ai metadata where known', () => {
  const known = new Map([['gpt-6.1-sol', { name: 'GPT-6.1 Sol', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], reasoning: true, thinkingLevelMap: { off: null, high: 'high' } }]])
  const models = catalogModels({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
    { slug: 'gpt-new', visibility: 'list' },
    { slug: 'gpt-hidden', visibility: 'hide' },
    { slug: 'bad\nslug', visibility: 'list' }
  ] }, known)
  assert.deepEqual(models.map(({ id, name }) => [id, name]), [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-new', 'gpt-new']])
  assert.equal(models[0].provider, 'fig-chatgpt')
  assert.equal(models[0].baseUrl, 'https://api.openai.com/v1')
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.equal(models[0].reasoning, true)
  assert.deepEqual(models[1], { ...models[1], api: 'openai-responses', contextWindow: 272000, maxTokens: 128000, input: ['text'], reasoning: false })
  assert.deepEqual(catalogModels(undefined), [])
})

test('ChatGPT uses account input modalities and fills missing GPT-6.2 image metadata', () => {
  const listed = (slug, input_modalities) => ({ slug, visibility: 'list', input_modalities })
  const inputs = (slug, modalities, base) => catalogModels(
    { models: [listed(slug, modalities)] }, new Map([[slug, base]])
  )[0].input
  for (const slug of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
    assert.deepEqual(inputs(slug), ['text', 'image'])
    assert.deepEqual(inputs(slug, ['text']), ['text'])
    assert.deepEqual(inputs(slug, undefined, { input: ['text'] }), ['text'])
  }
  assert.deepEqual(inputs('gpt-new', ['text', 'image', 'audio'], { input: ['text'] }), ['text', 'image'])
  assert.deepEqual(inputs('gpt-6.2-sol', ['audio']), ['text'])
  assert.deepEqual(inputs('gpt-new', []), ['text'])
})

test('ChatGPT failures map to fixed messages and never suggest an API key fallback silently', () => {
  assert.equal(safeFailure('PROVIDER', 'error: subscription_sharing_user_not_eligible').code, 'CHATGPT_NOT_ELIGIBLE')
  assert.equal(safeFailure('PROVIDER', 'subscription_sharing_usage_limit_exceeded').code, 'CHATGPT_USAGE_LIMIT')
  assert.equal(safeFailure('PROVIDER', 'subscription_sharing_usage_unavailable').code, 'CHATGPT_USAGE_LIMIT')
  assert.equal(safeFailure('PROVIDER', 'subscription_sharing_workplace_individual_usage_limit_exceeded').code, 'CHATGPT_USAGE_LIMIT')
  assert.equal(safeFailure('PROVIDER', '401 Unauthorized').code, loginRequired)
  assert.equal(safeFailure('RATE_LIMIT', '').code, 'RATE_LIMIT')
  const other = safeFailure('PROVIDER', 'secret sk-synthetic in upstream text')
  assert.doesNotMatch(other.message, /sk-synthetic/)
})

test('only a complete OAuth grant counts as a stored sign-in', () => {
  assert.ok(grantCredential({ kind: 'grant', payload: credential('a', 1) }))
  assert.equal(grantCredential({ kind: 'api-key', key: 'sk-synthetic' }), undefined)
  assert.equal(grantCredential({ kind: 'grant', payload: { ...credential('a', 1), clientId: undefined } }), undefined)
  assert.equal(grantCredential(undefined), undefined)
})

test('sign-in keeps one installation id, stores the grant and then serves its token', async t => {
  const { session, oauth, credentials, hostPath } = await setup(t)
  assert.deepEqual(await session.status(), { signedIn: false, signingIn: false })
  await assert.rejects(session.accessToken(), { code: loginRequired })

  assert.match((await session.start()).url, /^https:\/\/auth\.openai\.com\//)
  assert.deepEqual(await session.status(), { signedIn: false, signingIn: true })
  oauth.finish(credential('synthetic-access', Date.now() + 3_600_000))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(await session.status(), { signedIn: true, signingIn: false })
  assert.equal(await session.accessToken(), 'synthetic-access')
  assert.equal([...credentials.records.values()][0].kind, 'grant')

  const saved = JSON.parse(await readFile(hostPath, 'utf8')).id
  assert.equal(oauth.calls.logins[0].deviceId, saved)
  assert.equal(oauth.calls.logins[0].agentName, agentName)
  assert.equal((await stat(hostPath)).mode & 0o077, 0)

  // Signing in again (after sign-out) reuses the same installation id.
  await session.signOut()
  assert.deepEqual(await session.status(), { signedIn: false, signingIn: false })
  void session.start()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(oauth.calls.logins[1].deviceId, saved)
  session.cancel()
})

test('an expired or rejected token is refreshed once, even for concurrent requests', async t => {
  const { session, oauth, credentials } = await setup(t)
  await credentials.modifyRecord('fig-chatgpt:subscription', async () => ({ kind: 'grant', payload: credential('old', Date.now() - 1) }))
  const tokens = await Promise.all([session.accessToken(), session.accessToken()])
  assert.deepEqual(tokens, ['old-renewed', 'old-renewed'])
  assert.equal(oauth.calls.refreshes, 1)

  session.reject('old-renewed')
  assert.equal(await session.accessToken(), 'old-renewed-renewed')
  assert.equal(oauth.calls.refreshes, 2)

  oauth.calls.failRefresh = true
  session.reject('old-renewed-renewed')
  await assert.rejects(session.accessToken(), { code: loginRequired })
})

test('a failed or ineligible sign-in reports a fixed message and stores nothing', async t => {
  const { session, oauth, credentials } = await setup(t)
  const started = await session.start()
  assert.ok(started.url)
  oauth.finish(new Error('OpenAI OAuth token request failed (403): subscription_sharing_user_not_eligible'))
  await new Promise(resolve => setTimeout(resolve, 10))
  const status = await session.status()
  assert.equal(status.signedIn, false)
  assert.equal(status.signingIn, false)
  assert.match(status.error, new RegExp(uiText('Plus 或 Pro', 'Plus or Pro')))
  assert.equal(credentials.records.size, 0)

  // Cancelling before the sign-in address arrives rejects this start; that is the expected outcome, not a failure.
  session.start().catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  session.cancel()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await session.status()).signingIn, false)
})

test('sign-out wins when OAuth has resolved but its credential write is still queued', async t => {
  const { session, oauth, credentials } = await setup(t)
  await session.start()
  oauth.finish(credential('late-login', Date.now() + 3_600_000))
  await session.signOut()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await session.status()).signedIn, false, 'a late login must not recreate the deleted grant')
  assert.equal(credentials.records.size, 0)
})

test('cancelled login cannot overwrite a newer login even if OAuth ignores abort', async t => {
  const { session, oauth } = await setup(t)
  const attempts = []
  oauth.login = interaction => new Promise(resolve => {
    interaction.notify({ type: 'auth_url', url: 'https://example.test/synthetic' })
    attempts.push(resolve)
  })
  await Promise.all([session.start(), session.start()])
  assert.equal(attempts.length, 1, 'double click shares one attempt')
  session.cancel()
  await session.start()
  assert.equal(attempts.length, 2)
  attempts[1](credential('current-login', Date.now() + 3_600_000))
  await new Promise(resolve => setTimeout(resolve, 10))
  attempts[0](credential('cancelled-login', Date.now() + 3_600_000))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(await session.accessToken(), 'current-login')
})

test('late refresh cannot recreate a signed-out grant and logout failure stays visible', async t => {
  const { session, oauth, credentials } = await setup(t)
  const key = 'fig-chatgpt:subscription'
  await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: credential('stale', 1) }))
  let finishRefresh
  oauth.refresh = () => new Promise(resolve => { finishRefresh = resolve })
  const refreshing = session.accessToken()
  await new Promise(resolve => setTimeout(resolve, 10))
  await session.signOut()
  finishRefresh(credential('late-refresh', Date.now() + 3_600_000))
  await assert.rejects(refreshing, { code: loginRequired })
  assert.equal((await session.status()).signedIn, false)
  await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: credential('kept', Date.now() + 3_600_000) }))
  credentials.deleteRecord = async () => { throw new Error('fixture write failure') }
  await assert.rejects(session.signOut(), /fixture write failure/)
  assert.equal((await session.status()).signedIn, true, 'failed deletion must not pretend to sign out')
})

test('F2 refresh survives starting and cancelling a login attempt', async t => {
  const {session, oauth, credentials} = await setup(t), key = 'fig-chatgpt:subscription'
  await credentials.modifyRecord(key, async () => ({kind:'grant',payload:credential('expired',1)}))
  let finish
  oauth.refresh = () => new Promise(resolve => {finish=resolve})
  const token = session.accessToken()
  while (!finish) await new Promise(resolve=>setImmediate(resolve))
  await session.start(); session.cancel()
  const rotated = {...credential('renewed',Date.now()+3600000),refresh:'rotated-refresh'}
  finish(rotated)
  assert.equal(await token,'renewed')
  assert.equal((await credentials.readRecord(key)).payload.refresh,'rotated-refresh')
})

test('F2 refresh loses to sign-out and to a successfully committed new login', async t => {
  for (const action of ['sign-out','new-login']) {
    const {session, oauth, credentials} = await setup(t), key='fig-chatgpt:subscription'
    await credentials.modifyRecord(key,async()=>({kind:'grant',payload:credential('expired',1)}))
    let finish
    oauth.refresh=()=>new Promise(resolve=>{finish=resolve})
    const token=session.accessToken(); const settled=token.then(value=>({value}),error=>({code:error.code}))
    while(!finish) await new Promise(resolve=>setImmediate(resolve))
    if(action==='sign-out') await session.signOut()
    else {await session.start();oauth.finish(credential('new-login',Date.now()+3600000));while((await session.status()).signingIn)await new Promise(resolve=>setImmediate(resolve))}
    finish({...credential('late-refresh',Date.now()+3600000),refresh:'late-refresh-grant'})
    const result=await settled
    if(action==='sign-out'){assert.equal(result.code,loginRequired);assert.equal(await credentials.readRecord(key),undefined)}
    else {assert.equal(result.value,'new-login');assert.equal((await credentials.readRecord(key)).payload.access,'new-login')}
  }
})

/** One POST to the account route with `services`; resolves with the JSON body it answered. */
async function accountCall(endpoint, services) {
  const req = Object.assign(Readable.from(['{}']), { url: '/fig-chatgpt/' + endpoint, method: 'POST' })
  let body
  const res = { writeHead() {}, end(text) { body = JSON.parse(text) } }
  await accountRoute({ requestRejection: () => undefined }, req, res, services)
  return body
}

test('the account route shows only Fig\'s own messages, never upstream text that happens to mention signing in', async t => {
  const limits = { cached: async () => ({}), live: async () => ({}) }
  const failing = message => ({ status: async () => { throw new Error(message) }, start: async () => { throw new Error(message) } })
  for (const upstream of ['signature mismatch for token synthetic-secret', 'Please sign in again: Bearer synthetic-secret', 'ChatGPT 登录 synthetic-secret']) {
    const reply = await accountCall('account', { session: failing(upstream), limits })
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'CHATGPT_ACCOUNT')
    assert.doesNotMatch(reply.error.message, /synthetic-secret/)
    assert.equal(reply.error.message, uiText('ChatGPT 账号操作失败。', 'The ChatGPT account action failed.'))
  }
  const own = await accountCall('login', { session: { start: async () => { throw new PublicError('Fig wrote this') } }, limits })
  assert.equal(own.error.message, 'Fig wrote this')
  // A sign-in that fails before its URL reaches the page with Fig's fixed text, not the upstream one.
  const { credentials, hostPath } = await setup(t)
  const oauth = { login: async () => { throw new Error('upstream sign-in failure synthetic-secret') }, refresh: async () => { throw new Error('unused') } }
  const session = chatgptSession({ credentials, key: 'fig-chatgpt:subscription', oauth, hostPath })
  const failed = await accountCall('login', { session, limits })
  assert.equal(failed.error.message, uiText('ChatGPT 登录未完成，请重试。', 'ChatGPT sign-in did not finish. Try again.'))
})
