import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CoworkAuthorizationExpired, type TeamAuthorization, type TeamRequestProof } from './cowork-session'

/** Private loopback link for one DSH Host launch. Its token reaches the Host through FD 3 only. */
export async function startCoworkPluginBridge(capability: string, signal: AbortSignal,
  authorize: (request: TeamRequestProof) => Promise<TeamAuthorization>) {
  signal.throwIfAborted()
  const expected = Buffer.from(`Bearer ${capability}`)
  const server = createServer(async (req, res) => {
    const token = Buffer.from(req.headers.authorization ?? '')
    if (req.method !== 'POST' || req.url !== '/authorize' || req.headers.origin ||
      token.length !== expected.length || !timingSafeEqual(token, expected) || signal.aborted) {
      res.writeHead(404, { connection: 'close' }).end()
      return
    }
    try {
      let body = ''
      req.setEncoding('utf8')
      for await (const chunk of req) {
        body += chunk
        if (body.length > 8192) throw new Error('COWORK_TEAM_REQUEST')
      }
      signal.throwIfAborted()
      const authorization = await authorize(JSON.parse(body))
      signal.throwIfAborted()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(authorization))
    } catch (error) {
      res.writeHead(error instanceof CoworkAuthorizationExpired ? 401 : 503, { 'cache-control': 'no-store' }).end()
    }
  })
  server.requestTimeout = 5000
  const close = () => {
    signal.removeEventListener('abort', close)
    server.close()
    server.closeAllConnections()
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) { close(); signal.throwIfAborted() }
  return { port: (server.address() as AddressInfo).port, close }
}
