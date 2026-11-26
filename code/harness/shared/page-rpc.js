import { postPageJson } from './page-client.js'

/**
 * A page plugin's call to its Host half on `prefix` (behind DSH's browser session check); returns the endpoint's
 * value. A failure throws an Error carrying the Host's error `code`. Its message: with `unavailable` and `failed`
 * (each a function giving the text in the page's language), the Host's own message, else `unavailable` when the request got no answer at all, else
 * `failed`; without them, a fixed `<name> <endpoint> failed` for callers that word their own errors.
 * @param {string} prefix
 * @param {{ unavailable?: () => string, failed?: () => string }} [texts]
 */
export function pageRpc(prefix, { unavailable, failed } = {}) {
  return async function call(endpoint, payload = {}) {
    const { response, result } = await postPageJson(prefix, endpoint, payload)
    if (result?.ok) return result.value
    const fallback = !response.ok && !result ? unavailable ?? failed : failed ?? unavailable
    const message = !fallback ? prefix.slice(1) + ' ' + endpoint + ' failed'
      : !response.ok && !result ? fallback() : result?.error?.message ?? fallback()
    throw Object.assign(new Error(message), { code: result?.error?.code })
  }
}
