// JSON plumbing for the routes Fig's DSH plugins add to the DSH web server.

export function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

/** Reads a JSON body of at most `limit` characters; an empty body yields `empty` (400 if undefined). */
export async function readJsonBody(req, limit, empty = {}) {
  let body = ''
  req.setEncoding('utf8') // a character split across chunks decodes whole
  for await (const chunk of req) {
    body += chunk
    if (body.length > limit) return { status: 413 }
  }
  if (!body) return empty === undefined ? { status: 400 } : { payload: empty }
  try { return { payload: JSON.parse(body) } } catch { return { status: 400 } }
}

/** Thrown by an endpoint to answer with an HTTP error instead of `{ ok: false }`. */
export class RouteError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

// The one error whose message a page route may echo; see public-error.ts.
export { PublicError } from './public-error.ts'

const failed = (code, message) => ({ ok: false, error: { code, ...(message ? { message } : {}) } })
const statusCodes = { 400: 'BAD_REQUEST', 413: 'TOO_LARGE' }

/**
 * A POST route for the DSH page under `prefix`, answering `{ ok, value }` or `{ ok: false, error }`.
 * Requests pass DSH's connection check first: the same Host/Origin fence and browser session check
 * as its own /api. `failure(error, endpoint)` turns an endpoint's error into a page-safe `{ code, message }`.
 */
export function pageRoute({ prefix, endpoints, bodyLimit = 16 * 1024, failure }) {
  return async (connection, req, res, context) => {
    const rejection = connection.requestRejection(req)
    if (rejection) return reply(res, rejection, failed('FORBIDDEN'))
    const endpoint = new URL(req.url, 'http://localhost').pathname.slice(prefix.length + 1)
    if (req.method !== 'POST' || !Object.hasOwn(endpoints, endpoint)) return reply(res, 404, failed('NOT_FOUND'))
    const { payload, status } = await readJsonBody(req, bodyLimit)
    if (status) return reply(res, status, failed(statusCodes[status]))
    try {
      reply(res, 200, { ok: true, value: await endpoints[endpoint](payload, context) })
    } catch (error) {
      if (error instanceof RouteError) return reply(res, error.status, failed(error.code))
      const { code, message } = failure(error, endpoint)
      reply(res, 200, failed(code, message))
    }
  }
}

/** Registers `handler(connection, req, res)` for every request under `prefix` on the DSH web server. */
export function registerPageRoute(ctx, prefix, label, handler) {
  ctx.inject(['connection', 'webServer'], scope => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix', path: prefix, handler: (req, res) => handler(scope.connection, req, res)
    }), label)
  })
}
