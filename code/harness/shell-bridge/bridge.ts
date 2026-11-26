import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FigAttention } from '../shared/attention-contract.ts'

/** Answers a bridge request with an HTTP status and no body. */
class Refusal { status: number; constructor(status: number) { this.status = status } }

/**
 * Fig's main process reads the task activity package's state here, separate from the authenticated page routes: the browser's
 * DSH session is not involved. Strictly read-only; loopback only, the exact Host, no browser Origin,
 * and the one-use capability main handed this Host at start (bootstrap.js). Each read names the Host
 * generation it expects, also from bootstrap.js.
 */
export function desktopBridge(capability: string, generation: string, attention: FigAttention) {
  const reads: Record<string, (payload: any) => Promise<unknown> | unknown> = {
    '/fig-desktop/attention/read': payload => {
      if (Object.keys(payload).some(key => !['generation', 'cursor'].includes(key)) || (payload.cursor !== undefined && (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0))) throw new Refusal(409)
      const snapshot = attention.read(payload.cursor)
      const changed = new Set(snapshot.events.map(event => event.sessionId))
      // Main needs a count projection plus the identities referenced by this event batch,
      // not thousands of cold titles/timestamps. The browser retains its separate full page route.
      const rows = snapshot.rows.filter(row => row.pendingKinds.length || row.unknownFailure || changed.has(row.sessionId))
        .map(({sessionId, running, pendingKinds, unknownFailure}) => ({sessionId, running, pendingKinds, unknownFailure}))
      // Whether any Session runs at all, from the whole state rather than this batch's rows: main keeps the Mac awake on it.
      // Main knows this Host by the generation it started it with; the package keeps its own, so the snapshot carries main's.
      return {...snapshot, generation, rows, running: snapshot.rows.some(row => row.running)}
    },
    '/fig-desktop/activity': async payload => {
      if (Object.keys(payload).some(key => key !== 'generation')) throw new Refusal(409)
      return {idle: await attention.idle()}
    }
  }
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reject = (status: number) => { req.resume(); res.writeHead(status, {'cache-control': 'no-store'}); res.end() }
    const supplied = req.headers['x-fig-attention']
    const address = req.socket.remoteAddress
    if (req.method !== 'POST' || !Object.hasOwn(reads, req.url ?? '')) return reject(404)
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(address ?? '') || req.headers.host !== `127.0.0.1:${req.socket.localPort}` || 'origin' in req.headers) return reject(403)
    if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(capability))) return reject(403)
    try {
      const body = await new Promise<Buffer | undefined>((resolve, fail) => {
        let size = 0; const chunks: Buffer[] = []
        req.setTimeout(1500, () => { resolve(undefined); req.destroy() })
        req.on('data', chunk => { size += chunk.length; if (size > 1024) resolve(undefined); else chunks.push(chunk) })
        req.on('end', () => resolve(size <= 1024 ? Buffer.concat(chunks) : undefined))
        req.on('error', fail)
      })
      if (!body) return reject(413)
      req.setTimeout(0) // the read bound covers the request body; an activity read takes up to 2.5 s
      const payload = JSON.parse(body.toString('utf8'))
      if (payload.generation !== generation) return reject(409)
      const output = JSON.stringify(await reads[req.url!](payload))
      if (Buffer.byteLength(output) > 256 * 1024) return reject(503)
      res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(output)
    } catch (error) { if (!res.headersSent) reject(error instanceof Refusal ? error.status : 400) }
  }
}
