import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import test from 'node:test'
import { CoworkAuthorizationExpired, CoworkSession, coworkVault } from '../app/main/cowork-session'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coworkConnection, type CoworkGrant } from '../app/main/cowork-login'
import { startCoworkPluginBridge } from '../app/main/cowork-plugin-bridge'

test('Cowork enrolls only members, signs renewal with the enrolled device, and keeps the same Profile on sign-out', async () => {
  const records = new Map<string, unknown>()
  const vault = {
    async read<T>(key: string) { return records.get(key) as T | undefined },
    async save(key: string, value: unknown) { records.set(key, value) },
    async clear(key: string) { records.delete(key) }
  }
  let now = 10_000, enrolled = 0, renewed = 0, pluginRenewed = 0, revoked = false, invited = false, publicKey = '', profile = ''
  let revokeBody: unknown
  let adminConsolePath: unknown
  const config = coworkConnection({issuer:'https://login.example/realms/test', origin:'https://team.example', clientId:'desktop'}, false)!
  const initial = (): CoworkGrant => ({access: 'initial-token', refresh:'renew-one', expires: now + 60_000})
  const pluginGrant = (token: string, lifetime: number) => ({ pluginCredential: token, pluginCredentialExpiresAt: new Date(now + lifetime).toISOString() })
  function checkProof(path: string, method: string, body: string, headers: Headers) {
    const key = createPublicKey({key: Buffer.from(publicKey, 'base64url'), type:'spki', format:'der'})
    const digest = createHash('sha256').update(body).digest('base64url')
    const proof = Buffer.from([method, path, 'device', String(now), headers.get('x-cowork-nonce'), digest].join('\n'))
    assert.equal(verify(null, proof, key, Buffer.from(headers.get('x-cowork-proof')!, 'base64url')), true)
    assert.equal(headers.get('x-cowork-device'), 'device')
  }
  const client = new CoworkSession(config, vault, async (input, options) => {
    const url = new URL(String(input)), headers = new Headers(options?.headers)
    const body = options?.body && JSON.parse(String(options.body))
    assert.equal(url.origin, 'https://team.example')
    assert.equal(options?.redirect, 'error')
    if (url.pathname === '/api/desktop/session') return Response.json({member:'one', name:'Test Member',
      organization: invited ? {id:'tenant', name:'Team', adminConsolePath} : null, models: {organizationProviders: ['org', 'fig-chatgpt']} })
    if (url.pathname === '/api/desktop/devices') {
      enrolled++
      publicKey = body.publicKey
      profile = body.profile
      return Response.json({id:'device', ...pluginGrant('plugin-initial', 75_000)})
    }
    if (url.pathname === '/api/desktop/session/refresh') {
      assert.equal(body.refresh_token, 'renew-one')
      checkProof(url.pathname, 'POST', body.refresh_token, headers)
      renewed++
      return Response.json({access_token:'updated-token', refresh_token:'renew-two', expires_in:600})
    }
    if (url.pathname.endsWith('/plugin-credential')) {
      if (revoked) return Response.json({ error: { code: 'device_revoked' } }, { status: 403 })
      assert.equal(headers.get('authorization'), 'Bearer updated-token')
      checkProof(url.pathname, 'POST', String(options?.body), headers)
      pluginRenewed++
      return Response.json(pluginGrant('plugin-updated', 600_000))
    }
    if (url.pathname.endsWith('/revoke')) {
      revokeBody = body
      return new Response(null, { status: 204 })
    }
    assert.equal(url.pathname, '/api/desktop/devices/device')
    if (revoked) return Response.json({ error: { code: 'device_revoked', message: 'server detail' } }, { status: 403 })
    return Response.json({ id: 'device', profile, status: 'active', registeredAt: '1970-01-01T00:00:00Z', lastSeenAt: '1970-01-01T00:00:00Z' })
  }, () => now)

  assert.equal((await client.current(initial())).profile, undefined)
  assert.equal(enrolled, 0)
  invited = true
  const first = await client.current()
  assert.ok(first.profile)
  const get = { method: 'GET', path: '/api/team/sample?page=2' }
  const put = { method: 'PUT', path: '/api/team/sample', bodySha256: createHash('sha256').update('{"a":1}').digest('base64url') }
  const before = await client.authorizeTeamRequest(profile, get)
  assert.equal(before.origin, config.origin)
  assert.equal(before.headers.authorization, 'Bearer plugin-initial')
  checkProof('/api/team/sample', 'GET', '', new Headers(before.headers))
  await assert.rejects(client.authorizeTeamRequest('another-profile', get), CoworkAuthorizationExpired)
  for (const path of ['/api/desktop/session', '//outside.example/api/team/read', '/api/team/../desktop/admin', '/api/team/a%2fb'])
    await assert.rejects(client.authorizeTeamRequest(profile, { method: 'GET', path }), /COWORK_TEAM_REQUEST/)
  assert.deepEqual(first.identity.models.organizationProviders, ['org'])
  assert.equal(enrolled, 1)
  assert.equal(first.identity.organization?.adminConsoleUrl, undefined)
  adminConsolePath = '/admin'
  assert.equal((await client.current()).identity.organization?.adminConsoleUrl, 'https://team.example/admin')
  for (const invalid of ['//other.example/admin', '/\\other.example/admin', 'https://other.example/admin', '//user@team.example/admin']) {
    adminConsolePath = invalid
    assert.equal((await client.current()).identity.organization?.adminConsoleUrl, undefined)
  }
  await client.signOut()
  await assert.rejects(client.current(), CoworkAuthorizationExpired)
  await assert.rejects(client.authorizeTeamRequest(profile, get), CoworkAuthorizationExpired)
  assert.equal((await client.current(initial())).profile, first.profile)
  assert.equal(enrolled, 1)
  now += 55_000
  const [one, two] = await Promise.all([client.authorizeTeamRequest(profile, put), client.authorizeTeamRequest(profile, get)])
  assert.equal(renewed, 1)
  assert.equal(pluginRenewed, 1)
  assert.equal(one.headers.authorization, 'Bearer plugin-updated')
  checkProof(put.path, 'PUT', '{"a":1}', new Headers(one.headers))
  assert.notEqual(one.headers['x-cowork-nonce'], two.headers['x-cowork-nonce'])
  revoked = true
  await assert.rejects(client.current(undefined, {registeredOnly:true}), { name: 'Error', message: 'device_revoked' })
  await assert.rejects(client.authorizeTeamRequest(profile, get), CoworkAuthorizationExpired)
  assert.doesNotMatch(JSON.stringify(records.get('device')), /plugin-updated/)
  // Re-enable the mock device to exercise the user's separate, explicit revocation action.
  revoked = false
  await client.revokeDevice(profile, 'Test device no longer in use')
  assert.deepEqual(revokeBody, { reason: 'Test device no longer in use' })
  assert.equal(records.has('device'), false)
  assert.equal(records.has('session'), false)
})

test('Cowork Host bridge requires its one-launch capability and closes on stop', async t => {
  const stop = new AbortController()
  t.after(() => stop.abort())
  const cap = 'a'.repeat(64)
  const calls: string[] = []
  const bridge = await startCoworkPluginBridge(cap, stop.signal, async request => {
    calls.push(request.path)
    return { origin: 'https://team.example', headers: { authorization: 'Bearer synthetic-plugin' }, expiresAt: '2026-12-24T00:00:00Z' }
  })
  const url = `http://127.0.0.1:${bridge.port}/authorize`
  const send = (headers: Record<string, string>) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ method: 'GET', path: '/api/team/test' }) })
  assert.equal((await send({})).status, 404)
  assert.equal((await send({ authorization: `Bearer ${cap}`, origin: 'http://127.0.0.1:1' })).status, 404)
  assert.deepEqual(calls, [])
  const response = await send({ authorization: `Bearer ${cap}` })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).headers.authorization, 'Bearer synthetic-plugin')
  assert.deepEqual(calls, ['/api/team/test'])
  stop.abort()
  await assert.rejects(send({ authorization: `Bearer ${cap}` }))
})

test('a vault record the keychain can no longer open reads as missing, so Cowork asks to sign in again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fig-vault-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keychain = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text),
    decryptString: () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.') } }
  await mkdir(join(root, 'cowork'), { recursive: true })
  await writeFile(join(root, 'cowork', 'session.json'), JSON.stringify({ sealed: 'AAAA' }))
  const vault = coworkVault(root, keychain)
  assert.equal(await vault.read('session'), undefined)
  await writeFile(join(root, 'cowork', 'session.json'), '{damaged')
  assert.equal(await vault.read('session'), undefined)
  const session = new CoworkSession(coworkConnection({ issuer: 'https://cowork.example', origin: 'https://cowork.example', clientId: 'fig' }, false)!, vault)
  await assert.rejects(session.current(), CoworkAuthorizationExpired)
})
