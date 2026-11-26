import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { validId } from '../../harness/shared/team-models.ts'

export interface CoworkConnection {
  issuer: string
  clientId: string
  origin: string
}
export interface CoworkGrant {
  access: string
  refresh: string
  expires: number
}

function endpoint(value: unknown, loopback: boolean): URL {
  if (typeof value !== 'string') throw new Error('COWORK_CONFIG')
  const url = new URL(value)
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' &&
    !(loopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('COWORK_CONFIG')
  return url
}

export function coworkConnection(value: any, loopback: boolean): CoworkConnection | undefined {
  try {
    const issuer = endpoint(value?.issuer, loopback).href.replace(/\/$/, '')
    const origin = endpoint(value?.origin, loopback).origin
    if (!validId(value?.clientId)) return undefined
    return { issuer, origin, clientId: value.clientId }
  } catch { return undefined }
}

export function coworkGrant(value: any, now = Date.now()): CoworkGrant {
  if (typeof value?.access_token !== 'string' || !value.access_token || typeof value?.refresh_token !== 'string'
    || !value.refresh_token || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error('COWORK_AUTH')
  return { access: value.access_token, refresh: value.refresh_token, expires: now + value.expires_in * 1000 }
}

export async function coworkLogin(connection: CoworkConnection, openBrowser: (url: string) => Promise<void>,
  signal: AbortSignal, request = fetch): Promise<CoworkGrant> {
  const issuer = new URL(connection.issuer)
  const discovery = await request(connection.issuer + '/.well-known/openid-configuration', { redirect: 'error', signal })
  if (!discovery.ok) throw new Error('COWORK_DISCOVERY')
  const metadata = await discovery.json()
  if (metadata.issuer !== connection.issuer) throw new Error('COWORK_DISCOVERY')
  const authorize = endpoint(metadata.authorization_endpoint, issuer.protocol === 'http:')
  const token = endpoint(metadata.token_endpoint, issuer.protocol === 'http:')
  if (authorize.origin !== issuer.origin || token.origin !== issuer.origin) throw new Error('COWORK_DISCOVERY')

  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  let callback: URL
  let accepted = false
  let complete!: (code: string) => void
  let failed!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => { complete = resolve; failed = reject })
  // Cancellation during browser launch must not generate an unhandled rejection.
  void code.catch(() => {})
  const server = createServer((incoming, response) => {
    const path = callback && URL.parse(incoming.url ?? '/', callback)
    if (!path || incoming.method !== 'GET' || incoming.headers.host !== callback.host || path.origin !== callback.origin
      || path.pathname !== callback.pathname || path.searchParams.getAll('state').length !== 1
      || path.searchParams.get('state') !== state || accepted) {
      response.writeHead(404).end()
      return
    }
    accepted = true
    const codes = path.searchParams.getAll('code')
    const valid = codes.length === 1 && codes[0] && !path.searchParams.has('error')
    response.writeHead(valid ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
      .end(valid ? 'You can close this tab and return to Fig Desktop.' : 'Sign-in did not complete. Return to Fig Desktop.')
    server.close()
    if (valid) complete(codes[0])
    else failed(new Error('COWORK_AUTH'))
  })
  const abort = () => { failed(new Error('COWORK_CANCELLED')); server.closeAllConnections() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    signal.throwIfAborted()
    callback = new URL('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/oauth/cowork')
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: connection.clientId, scope: 'openid profile',
      redirect_uri: callback.href, state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url')
    }).toString()
    await openBrowser(authorize.href)
    const acceptedCode = await code
    const response = await request(token, { method: 'POST', redirect: 'error', signal, body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: connection.clientId, code: acceptedCode,
      redirect_uri: callback.href, code_verifier: verifier
    }) })
    if (!response.ok) throw new Error('COWORK_AUTH')
    return coworkGrant(await response.json())
  } finally {
    signal.removeEventListener('abort', abort)
    server.close()
    if (!accepted) server.closeAllConnections()
  }
}
