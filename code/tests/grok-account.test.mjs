import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { accountProfile, accountRoute, accountService, billingFrom, billingFromLog } from '../harness/provider-grok/account.js'
import { PublicError } from '../harness/shared/http.js'
import { findInTail } from '../harness/shared/file-tail.js'
import { uiText } from '../harness/shared/ui-text'
import { tempDir } from './helpers/temp-dir.mjs'

const fixture = fileURLToPath(new URL('./fixtures/fake-grok.mjs', import.meta.url))
const saved = { path: process.env.PATH, home: process.env.DSH_HOME }
const scope = 'https://auth.x.ai::00000000-0000-4000-8000-000000000000'
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'fig-grok-account-'))
  await mkdir(join(root, 'bin'))
  await mkdir(join(root, 'grok/logs'), { recursive: true })
  const grok = join(root, 'bin/grok')
  await writeFile(grok, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`)
  await chmod(grok, 0o755)
  process.env.PATH = join(root, 'bin') + delimiter + saved.path
  process.env.DSH_HOME = join(root, 'dsh-home')
})

after(async () => {
  process.env.PATH = saved.path
  if (saved.home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved.home
  await rm(root, { recursive: true, force: true })
})

const session = (extra = {}) => ({
  auth_mode: 'oidc', key: 'x'.repeat(40), email: 'person@example.com', first_name: 'Ada', last_name: 'Lee',
  principal_type: 'User', coding_data_team: 'personal', team_zero_data_retention: false,
  coding_data_retention_opt_out: true, expires_at: '2000-01-01T00:00:00Z', ...extra
})

test('the profile comes from the single Grok OIDC session, even with an expired access token', () => {
  assert.deepEqual(accountProfile({ [scope]: session() }), {
    name: 'Ada Lee', email: 'person@example.com', initials: 'AL', team: false,
    zeroDataRetention: false, codingDataOptOut: true
  })
  assert.equal(accountProfile({ [scope]: session({ principal_type: 'Team' }) }).team, true)
  assert.equal(accountProfile({}), undefined)
  assert.equal(accountProfile({ [scope]: session(), [scope.replace('0000-4', '1111-4')]: session() }), undefined)
  assert.equal(accountProfile({ [scope]: session({ auth_mode: 'api_key' }) }), undefined)
})

test('billing accepts the CLI config shape and rejects anything else', () => {
  const live = billingFrom({ config: {
    creditUsagePercent: 2.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-04T03:00:00Z', end: '2026-11-11T03:00:00Z' },
    prepaidBalance: { val: 0 }
  }, subscription_tier: 'SuperGrok' })
  assert.deepEqual(live, {
    usedPercent: 2.5, period: 'weekly', periodStart: '2026-11-04T03:00:00.000Z', periodEnd: '2026-11-11T03:00:00.000Z',
    prepaidBalance: 0, tier: 'SuperGrok'
  })
  assert.equal(billingFrom({ config: { creditUsagePercent: '2' } }), undefined)
  assert.equal(billingFrom(undefined), undefined)
  assert.equal(billingFrom({ config: { creditUsagePercent: 250, billingPeriodEnd: '2026-11-11T03:00:00Z' } }).usedPercent, 100)
})

test('the log fallback takes the newest billing record and skips broken lines', () => {
  const record = (ts, percent) => JSON.stringify({ ts, msg: 'billing: fetched credits config', ctx: {
    config: { creditUsagePercent: percent, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-11T03:00:00Z' } },
    subscriptionTier: 'SuperGrok'
  } })
  const text = [record('2026-11-04T03:00:00Z', 1), JSON.stringify({ msg: 'other' }), record('2026-11-04T13:00:00Z', 2), '{"msg":"billing: fetched credits config", broken'].join('\n')
  const billing = billingFromLog(text)
  assert.equal(billing.usedPercent, 2)
  assert.equal(billing.source, 'log')
  assert.equal(billing.fetchedAt, '2026-11-04T13:00:00Z')
  assert.equal(billingFromLog(''), undefined)
})

test('a large log is read from its end with the same result as reading all of it', async t => {
  const dir = await tempDir(t, 'fig-grok-log-')
  const record = (ts, percent) => JSON.stringify({ ts, msg: 'billing: fetched credits config', ctx: {
    config: { creditUsagePercent: percent, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-11T03:00:00Z' } },
    subscriptionTier: 'SuperGrok'
  } })
  // About 5 MB of other entries, with multi-byte text so a window can start inside a character.
  const filler = Array.from({ length: 24_000 }, (_, i) => JSON.stringify({ ts: '2026-11-04T05:00:00Z', msg: 'turn ' + i, ctx: { note: '用量记录'.repeat(40) } }))
  const cases = {
    'newest near the end': [record('2026-11-04T03:00:00Z', 1), ...filler, record('2026-11-04T13:00:00Z', 7), filler[0]],
    'only record near the start': [record('2026-11-04T03:00:00Z', 3), ...filler],
    'no record': filler,
    'record straddling the first window': [...filler.slice(0, 23_000), record('2026-11-04T09:00:00Z', 5), ...filler.slice(0, 250)]
  }
  for (const [name, lines] of Object.entries(cases)) {
    const path = join(dir, name.replaceAll(' ', '-') + '.jsonl')
    const text = lines.join('\n') + '\n'
    await writeFile(path, text)
    assert.deepEqual(await findInTail(path, billingFromLog), billingFromLog(text), name)
  }
  // Every window start inside the straddling record still finds it whole.
  const path = join(dir, 'record-straddling-the-first-window.jsonl')
  const text = await readFile(path, 'utf8')
  const end = Buffer.byteLength(text)
  for (const window of [end - Buffer.byteLength(text.slice(0, text.lastIndexOf('{"ts":"2026-11-04T09'))) - 10, 1024, 4096]) {
    assert.equal((await findInTail(path, billingFromLog, window))?.usedPercent, 5)
  }
  assert.ok((await readFile(join(dir, 'no-record.jsonl'))).length > 4_000_000)
})

test('the account answers without the CLI; live billing follows and is then served at once', async () => {
  const authPath = join(root, 'grok/auth.json')
  await writeFile(authPath, JSON.stringify({ [scope]: session() }))
  const service = accountService({ grokHome: join(root, 'grok'), authPath, readJson: async path => JSON.parse(await readFile(path, 'utf8')) })
  const account = await service.account()
  assert.equal(account.signedIn, true)
  assert.equal(account.profile.email, 'person@example.com')
  assert.equal(account.billing, undefined, 'no live read and no log yet')
  const { billing } = await service.billing()
  assert.equal(billing.source, 'live')
  assert.equal(billing.usedPercent, 2)
  assert.equal(billing.tier, 'SuperGrok')
  assert.equal((await service.account()).billing.source, 'live', 'the last live read is shown without starting the CLI')
})

test('without live billing the log record is used; without a session the account is signed out', async () => {
  const grokHome = join(root, 'grok-offline')
  await mkdir(join(grokHome, 'logs'), { recursive: true })
  await writeFile(join(grokHome, 'logs/unified.jsonl'), JSON.stringify({ ts: '2026-11-04T03:00:00Z', msg: 'billing: fetched credits config', ctx: {
    config: { creditUsagePercent: 1, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-11T03:00:00Z' } }
  } }) + '\n')
  // A failed CLI sign-in stands in for any live billing failure.
  process.env.FAKE_GROK_AUTH = 'fail'
  try {
    const signedIn = accountService({ grokHome, authPath: '', readJson: async () => ({ [scope]: session() }) })
    assert.equal((await signedIn.account()).billing.source, 'log')
    assert.equal((await signedIn.billing()).billing.source, 'log')
    const signedOut = accountService({ grokHome, authPath: '', readJson: async () => undefined })
    assert.equal((await signedOut.account()).state, 'signed-out')
    assert.equal((await signedOut.account()).signedIn, false)
    assert.deepEqual(await signedOut.billing(), {})
  } finally { delete process.env.FAKE_GROK_AUTH }
})

test('sign-in returns the CLI login URL and clears the pending state when the CLI exits', async () => {
  const service = accountService({ grokHome: join(root, 'grok'), authPath: '', readJson: async () => undefined })
  const { url } = await service.login()
  assert.match(url, /^https:\/\/auth\.x\.ai\/oauth2\/authorize\?/)
  assert.equal((await service.account()).signingIn, true)
  await new Promise(resolve => setTimeout(resolve, 2400))
  assert.equal((await service.account()).signingIn, false)
})

test('official logout success removes only synthetic auth, failure keeps login, and malformed state stays unknown', async () => {
  const grokHome = join(root, 'grok-logout'); await mkdir(grokHome)
  const authPath = join(grokHome, 'auth.json'), config = join(grokHome, 'config.toml')
  await writeFile(config, 'KEEP-CONFIG')
  await writeFile(authPath, JSON.stringify({[scope]: session()}))
  const service = accountService({grokHome, authPath})
  process.env.FAKE_GROK_LOGOUT = 'fail'
  try {
    await assert.rejects(service.logout(), new RegExp(uiText('Grok CLI 退出失败', 'Grok CLI sign-out failed')))
    assert.equal((await service.account()).signedIn, true)
  } finally { delete process.env.FAKE_GROK_LOGOUT }
  await service.logout(); assert.equal((await service.account()).signedIn, false)
  assert.equal(await readFile(config, 'utf8'), 'KEEP-CONFIG')
  await writeFile(authPath, '{broken'); assert.equal((await service.account()).state, 'unknown')
})

test('duplicate login shares its process; cancellation drains it before logout and late URL cannot win', async () => {
  const grokHome = join(root, 'grok-cancel'); await mkdir(grokHome)
  const authPath = join(grokHome, 'auth.json'); await writeFile(authPath, JSON.stringify({[scope]: session()}))
  let starts = 0, releaseUrl, releaseDone, cancelFinished = false
  const url = new Promise(resolve => {releaseUrl = resolve}), done = new Promise(resolve => {releaseDone = resolve})
  const service = accountService({grokHome, authPath, start: async () => {
    starts++; return {url, done, cancel: async () => { await new Promise(resolve => setTimeout(resolve, 20)); cancelFinished = true; releaseDone({completed: false}) }}
  }, logout: async () => { assert.ok(cancelFinished); await writeFile(authPath, '{}') }})
  const first = service.login(), second = service.login()
  const settled = Promise.allSettled([first, second])
  assert.equal(starts, 1)
  await service.logout()
  releaseUrl('https://auth.x.ai/stale')
  assert.ok((await settled).every(result => result.status === 'rejected'))
  assert.equal((await service.account()).signedIn, false)
})

test('cancelling the real managed login fixture clears pending after the owned process group is gone', async () => {
  const grokHome = join(root, 'grok-managed-cancel'); await mkdir(grokHome)
  process.env.FAKE_GROK_LOGIN = 'hang'
  try {
    const service = accountService({grokHome, authPath: join(grokHome, 'auth.json')})
    await service.login(); assert.equal((await service.account()).signingIn, true)
    await service.cancel(); assert.equal((await service.account()).signingIn, false)
  } finally {delete process.env.FAKE_GROK_LOGIN}
})

test('an unavailable CLI fails login and restores pending state without falling back to another executable', async () => {
  const executable = join(root, 'bin/grok'), original = await readFile(executable)
  // A selected executable with a missing interpreter makes the real spawn fail ENOENT.
  // It must not fall through to the user's installed CLI or leave the account page signing in.
  await writeFile(executable, '#!/fig-synthetic-missing-interpreter\n')
  const grokHome = join(root, 'grok-missing'); await mkdir(grokHome)
  try {
    const service = accountService({grokHome, authPath: join(grokHome, 'auth.json')})
    await assert.rejects(service.login(), /Grok CLI/)
    assert.equal((await service.account()).signingIn, false)
    assert.equal((await service.account()).signedIn, false)
    await service.cancel()
  } finally {await writeFile(executable, original)}
})

test('multiple OIDC profiles, including an expired second profile, stay explicitly unknown without billing',async()=>{
 const document={[scope]:session({expires_at:'2099-01-01T00:00:00Z'}),[scope.replace('0000-4','1111-4')]:session()}
 const service=accountService({grokHome:join(root,'ambiguous'),authPath:'unused',readJson:async()=>document})
 assert.equal(accountProfile(document),undefined);assert.equal((await service.account()).state,'unknown');assert.deepEqual(await service.billing(),{})
})

test('the account route echoes only Fig\'s own messages, not upstream text naming the Grok CLI', async () => {
  const call = async account => {
    const req = Object.assign(Readable.from(['{}']), { url: '/fig-grok/account', method: 'POST' })
    let body
    await accountRoute({ requestRejection: () => undefined }, req, { writeHead() {}, end(text) { body = JSON.parse(text) } }, account)
    return body.error.message
  }
  assert.equal(await call({ account: async () => { throw new Error('Grok CLI: sign in failed, token=synthetic-secret') } }),
    uiText('Grok 账号信息读取失败。', 'Could not read the Grok account.'))
  assert.equal(await call({ account: async () => { throw new PublicError('Fig wrote this') } }), 'Fig wrote this')
})
