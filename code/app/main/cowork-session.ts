import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeRecord } from '../../harness/shared/atomic-json.ts'
import { coworkGrant, type CoworkConnection, type CoworkGrant } from './cowork-login'
import { teamModels, validId as id, type TeamModels } from '../../harness/shared/team-models.ts'
import { teamPluginPolicy, type TeamPluginOff } from '../../harness/shared/profile-contract.ts'

export interface CoworkIdentity {
  member: string
  name: string
  organization?: { id: string, name: string, adminConsoleUrl?: string }
  models: TeamModels
  /** The organization's unavailable business plugins, with why each is off; a missing name is on. */
  plugins: Record<string, TeamPluginOff>
}
interface Device {
  member: string
  tenant: string
  id: string
  profile: string
  privateKey: string
  publicKey: string
  pluginCredential?: { token: string, expires: number }
}
interface StoredSession {
  issuer: string
  origin: string
  grant: CoworkGrant
  lastUsed: number
  deviceId?: string
}
interface Vault {
  read<T>(key: string): Promise<T | undefined>
  save(key: string, value: unknown): Promise<void>
  clear(key: string): Promise<void>
}
interface Encryption {
  isEncryptionAvailable(): boolean
  encryptString(clear: string): Buffer
  decryptString(cipher: Buffer): string
}

export function coworkVault(root: string, keychain: Encryption): Vault {
  const path = (key: string) => join(root, 'cowork', key + '.json')
  return {
    async read(key) {
      const text = await readFile(path(key), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (text === undefined) return undefined
      // A record the keychain can no longer open (its key was reset, or the file is damaged) counts as missing, so the
      // user is asked to sign in again; the next save replaces it.
      try { return JSON.parse(keychain.decryptString(Buffer.from(JSON.parse(text).sealed, 'base64'))) } catch { return undefined }
    },
    async save(key, value) {
      if (!keychain.isEncryptionAvailable()) throw new Error('COWORK_KEYCHAIN')
      await writeRecord(path(key), { sealed: keychain.encryptString(JSON.stringify(value)).toString('base64') })
    },
    async clear(key) { await rm(path(key), { force: true }) }
  }
}

export class CoworkAuthorizationExpired extends Error {}
export class CoworkApiError extends Error {
  constructor(readonly code: string) { super('COWORK_UNAVAILABLE') }
}
const idleLimit = 30 * 24 * 60 * 60 * 1000
const renewBefore = 30_000
const apiErrorCodes = new Set(['unauthenticated', 'device_revoked', 'proof_invalid', 'nonce_replayed', 'clock_skew', 'not_member', 'invalid_request', 'unavailable'])
const digestOf = (value: string) => createHash('sha256').update(value).digest('base64url')

export interface TeamRequestProof {
  method: string
  path: string
  bodySha256?: string
}

export interface TeamAuthorization {
  origin: string
  headers: Record<string, string>
  expiresAt: string
}

function deviceProof(device: Device, method: string, path: string, digest: string, now: number) {
  const timestamp = String(now), nonce = randomUUID()
  const proof = sign(null, Buffer.from([method, path, device.id, timestamp, nonce, digest].join('\n')), device.privateKey)
  return { 'x-cowork-device': device.id, 'x-cowork-time': timestamp, 'x-cowork-nonce': nonce, 'x-cowork-proof': proof.toString('base64url') }
}

function pluginCredential(value: any, now: number): NonNullable<Device['pluginCredential']> {
  const token = value?.pluginCredential, timestamp = value?.pluginCredentialExpiresAt
  const expires = typeof timestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) ? Date.parse(timestamp) : NaN
  if (typeof token !== 'string' || !/^[!-~]{1,4096}$/.test(token) || !Number.isFinite(expires) || expires <= now)
    throw new Error('COWORK_PLUGIN_CREDENTIAL')
  return { token, expires }
}

function teamRequest(value: TeamRequestProof, origin: string) {
  if (typeof value?.path !== 'string' || value.path.length > 4096 || !value.path.startsWith('/api/team/') || /[\\#\s]|%2f|%5c/i.test(value.path))
    throw new Error('COWORK_TEAM_REQUEST')
  const target = new URL(value.path, origin)
  if (target.origin !== origin || target.pathname !== value.path.split('?')[0] || target.pathname === '/api/team/' ||
    !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method) ||
    (value.bodySha256 !== undefined && (typeof value.bodySha256 !== 'string' || !/^[\w-]{43}$/.test(value.bodySha256))))
    throw new Error('COWORK_TEAM_REQUEST')
  return { method: value.method, path: target.pathname, digest: value.bodySha256 ?? digestOf('') }
}

/** Fig's side of the desktop API. The Cowork service owns authorization and verifies every signed proof. */
export class CoworkSession {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly connection: CoworkConnection, private readonly vault: Vault,
    private readonly fetcher = fetch, private readonly now = Date.now) {}

  private async request(path: string, grant: CoworkGrant, body?: object, headers?: Record<string, string>) {
    const response = await this.fetcher(new URL(path, this.connection.origin), {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: 'Bearer ' + grant.access, ...body ? { 'content-type': 'application/json' } : {}, ...headers },
      ...body ? { body: JSON.stringify(body) } : {}
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined)
      const suppliedCode = payload?.error?.code
      const code = apiErrorCodes.has(suppliedCode) ? suppliedCode : 'unavailable'
      if (response.status === 401 || response.status === 403) throw new CoworkAuthorizationExpired(code)
      throw new CoworkApiError(code)
    }
    return response.status === 204 ? undefined : await response.json()
  }

  private save(grant: CoworkGrant, lastUsed: number, deviceId?: string) {
    return this.vault.save('session', { issuer: this.connection.issuer, origin: this.connection.origin, grant, lastUsed, deviceId })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }

  private async enroll(member: string, tenant: string, grant: CoworkGrant, oldProfile?: string): Promise<Device> {
    let pending = await this.vault.read<Omit<Device, 'id' | 'pluginCredential'>>('device-pending')
    if (!pending || pending.member !== member || pending.tenant !== tenant || (oldProfile && pending.profile !== oldProfile)) {
      const pair = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      })
      pending = { member, tenant, profile: oldProfile ?? randomUUID(), publicKey: pair.publicKey.toString('base64url'), privateKey: pair.privateKey }
      await this.vault.save('device-pending', pending)
    }
    const registration = await this.request('/api/desktop/devices', grant, { profile: pending.profile, publicKey: pending.publicKey })
    if (!id(registration?.id) || registration.id === '.' || registration.id === '..') throw new Error('COWORK_DEVICE')
    // The pre-contract fixture only returned id. A legacy device obtains its first credential through the renewal route.
    const device = { ...pending, id: registration.id,
      ...registration.pluginCredential !== undefined || registration.pluginCredentialExpiresAt !== undefined
        ? { pluginCredential: pluginCredential(registration, this.now()) } : {} }
    await this.vault.save('device', device)
    await this.vault.clear('device-pending')
    return device
  }

  current(newGrant?: CoworkGrant, options?: { touch?: boolean, registeredOnly?: boolean }): Promise<{ identity: CoworkIdentity, profile?: string }> {
    return this.serialize(() => this.readCurrent(newGrant, options))
  }

  private async readCurrent(newGrant?: CoworkGrant, { touch = true, registeredOnly = false } = {}): Promise<{ identity: CoworkIdentity, profile?: string }> {
    const stored = newGrant ? undefined : await this.vault.read<StoredSession>('session')
    if (!newGrant && (!stored || stored.issuer !== this.connection.issuer || stored.origin !== this.connection.origin ||
      this.now() - stored.lastUsed >= idleLimit)) throw new CoworkAuthorizationExpired()
    let grant = newGrant ?? stored!.grant
    const lastUsed = stored && !touch ? stored.lastUsed : this.now()
    const device = await this.vault.read<Device>('device')
    if (grant.expires <= this.now() + renewBefore) {
      if (!device || newGrant || stored?.deviceId !== device.id) throw new CoworkAuthorizationExpired()
      const path = '/api/desktop/session/refresh'
      grant = coworkGrant(await this.request(path, grant, { refresh_token: grant.refresh }, {
        ...deviceProof(device, 'POST', path, digestOf(grant.refresh), this.now())
      }), this.now())
      // Persist a rotated grant immediately, even if a later account lookup fails.
      await this.save(grant, lastUsed, device.id)
    }

    const account = await this.request('/api/desktop/session', grant)
    if (!id(account?.member) || typeof account.name !== 'string' || (account.organization !== null &&
      (!id(account.organization?.id) || typeof account.organization.name !== 'string'))) throw new Error('COWORK_SESSION')
    // Optional capability from the authenticated session: Cowork only returns it for tenant admins.
    // It controls discoverability, not authorization. No off-origin URL may reach the renderer.
    const organization = account.organization
    const adminPath = organization?.adminConsolePath
    const adminUrl = typeof adminPath === 'string' && adminPath.startsWith('/')
      ? URL.parse(adminPath, this.connection.origin) : null
    const adminConsoleUrl = adminUrl?.origin === this.connection.origin && !adminUrl.username && !adminUrl.password
      ? adminUrl.href : undefined
    const identity: CoworkIdentity = { member: account.member, name: account.name, models: teamModels(account.models), plugins: teamPluginPolicy(account.plugins),
      ...organization && { organization: { id: organization.id, name: organization.name, ...adminConsoleUrl && { adminConsoleUrl } } } }
    if (!identity.organization) {
      await this.save(grant, lastUsed)
      return { identity }
    }
    const tenant = identity.organization.id
    let enrolled = device?.member === identity.member && device.tenant === tenant ? device : undefined
    const oldProfile = enrolled?.profile
    if (enrolled) {
      try {
        const remote = await this.request('/api/desktop/devices/' + encodeURIComponent(enrolled.id), grant)
        if ((remote?.status !== undefined && remote.status !== 'active') || (remote?.id !== undefined && remote.id !== enrolled.id) ||
          (remote?.profile !== undefined && remote.profile !== enrolled.profile)) throw new CoworkAuthorizationExpired()
      }
      catch (error) {
        if (error instanceof CoworkAuthorizationExpired && enrolled.pluginCredential) {
          delete enrolled.pluginCredential
          await this.vault.save('device', enrolled)
        }
        if (!newGrant || registeredOnly || !(error instanceof CoworkAuthorizationExpired)) throw error
        // Re-enrollment after an explicit new login is still authorized by Cowork.
        enrolled = undefined
      }
    }
    if (!enrolled) {
      if (registeredOnly) throw new CoworkAuthorizationExpired()
      enrolled = await this.enroll(identity.member, tenant, grant, oldProfile)
    }
    if (!stored || stored.lastUsed !== lastUsed || stored.grant !== grant || stored.deviceId !== enrolled.id)
      await this.save(grant, lastUsed, enrolled.id)
    return { identity, profile: enrolled.profile }
  }

  signOut() { return this.serialize(() => this.vault.clear('session')) }

  authorizeTeamRequest(profile: string, request: TeamRequestProof): Promise<TeamAuthorization> {
    return this.serialize(async () => {
      const { method, path, digest } = teamRequest(request, this.connection.origin)
      let stored = await this.vault.read<StoredSession>('session')
      const device = await this.vault.read<Device>('device')
      if (!stored || stored.issuer !== this.connection.issuer || stored.origin !== this.connection.origin ||
        this.now() - stored.lastUsed >= idleLimit || !device || device.profile !== profile || stored.deviceId !== device.id)
        throw new CoworkAuthorizationExpired()
      let credential = device.pluginCredential
      const needsRenewal = !credential || credential.expires <= this.now() + renewBefore
      if (needsRenewal || stored.grant.expires <= this.now() + renewBefore) {
        const active = await this.readCurrent(undefined, { touch: false, registeredOnly: true })
        stored = await this.vault.read<StoredSession>('session')
        if (!stored || active.profile !== profile || stored.deviceId !== device.id) throw new CoworkAuthorizationExpired()
      }
      if (needsRenewal || !credential) {
        const renew = '/api/desktop/devices/' + encodeURIComponent(device.id) + '/plugin-credential'
        const response = await this.request(renew, stored.grant, {}, deviceProof(device, 'POST', renew, digestOf('{}'), this.now()))
        credential = pluginCredential(response, this.now())
        await this.vault.save('device', { ...device, pluginCredential: credential })
      }
      return { origin: this.connection.origin,
        headers: { authorization: 'Bearer ' + credential.token, ...deviceProof(device, method, path, digest, this.now()) },
        expiresAt: new Date(credential.expires).toISOString() }
    })
  }

  revokeDevice(profile: string, reason?: string): Promise<void> {
    return this.serialize(() => this.revoke(profile, reason))
  }

  private async revoke(profile: string, reason?: string) {
    const current = await this.readCurrent(undefined, { registeredOnly: true })
    const device = await this.vault.read<Device>('device')
    const session = await this.vault.read<StoredSession>('session')
    if (current.profile !== profile || !device || device.profile !== profile || !session || session.deviceId !== device.id)
      throw new CoworkAuthorizationExpired()
    await this.request('/api/desktop/devices/' + encodeURIComponent(device.id) + '/revoke', session.grant, reason ? { reason } : {})
    await this.vault.clear('session')
    await this.vault.clear('device')
    await this.vault.clear('device-pending')
  }
}
