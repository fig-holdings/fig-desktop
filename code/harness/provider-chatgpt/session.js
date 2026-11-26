import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeRecord } from '../shared/atomic-json.ts'
import { PublicError } from '../shared/http.js'
import { uiText } from '../shared/ui-text'

// The ChatGPT subscription sign-in (OpenAI's "ChatGPT plan usage" for open-source local apps). pi-ai
// runs the OAuth conversation and the refresh; Fig supplies what DSH does not: a stable installation
// UUID (the agent host OpenAI registers) and a place for the grant, a record of its own in DSH's
// credential store. Failing requests never fall back to an API key.

export const loginRequired = 'CHATGPT_LOGIN_REQUIRED'
export const loginMessage = () => uiText('ChatGPT 未登录或登录已失效。请在设置「ChatGPT 账号」中登录后重试。', 'ChatGPT is not signed in, or the sign-in expired. Sign in under Settings › ChatGPT Account, then retry.')
export const agentName = 'Fig Desktop'
const loginTimeout = 5 * 60_000
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i

/** Maps a sign-in or request failure to a fixed message. Upstream text may contain credentials and is never echoed. */
export function safeFailure(code, message = '') {
  if (/subscription_sharing_user_not_eligible/.test(message)) {
    return { code: 'CHATGPT_NOT_ELIGIBLE', message: uiText('这个 ChatGPT 账号暂不能在 Fig 中使用订阅额度（需要符合条件的 Plus 或 Pro）。Fig 不会改用 API key。', 'This ChatGPT account cannot use its subscription in Fig for now (an eligible Plus or Pro plan is needed). Fig does not switch to an API key.') }
  }
  if (/subscription_sharing_(?:workplace_individual_)?usage_(?:limit_exceeded|unavailable)/.test(message)) {
    return { code: 'CHATGPT_USAGE_LIMIT', message: uiText('ChatGPT 订阅用量已达上限或暂不可用，可在 chatgpt.com/settings/usage 查看。Fig 不会改用 API key。', 'The ChatGPT subscription has reached its usage limit or is unavailable; see chatgpt.com/settings/usage. Fig does not switch to an API key.') }
  }
  if (code === 'AUTH' || code === loginRequired || /\b(?:401|403)\b|unauthori[sz]ed|invalid_grant|reconnect ChatGPT/i.test(message)) {
    return { code: loginRequired, message: loginMessage() }
  }
  if (code === 'RATE_LIMIT' || /\b429\b|rate.?limit/i.test(message)) {
    return { code: 'RATE_LIMIT', message: uiText('ChatGPT 暂时限流，请稍后重试。', 'ChatGPT is rate-limited for now. Try again shortly.') }
  }
  return { code, message: uiText('ChatGPT 请求失败，请检查连接或稍后重试。', 'The ChatGPT request failed. Check the connection or try again shortly.') }
}

/** The pi-ai OAuth credential stored in a grant payload, or undefined for anything else. */
export function grantCredential(record) {
  const credential = record?.kind === 'grant' ? record.payload : undefined
  return credential?.type === 'oauth' && typeof credential.access === 'string' && typeof credential.refresh === 'string' &&
    typeof credential.clientId === 'string' && Number.isFinite(credential.expires) ? credential : undefined
}

/** The installation UUID, created and saved before the first sign-in and reused afterwards. */
export async function installationId(path) {
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'))?.id
    if (typeof saved === 'string' && uuid.test(saved)) return saved
  } catch { /* Created below. */ }
  const id = randomUUID()
  await writeRecord(path, { id, createdAt: new Date().toISOString() })
  return id
}

/**
 * Sign-in, sign-out and the current access token.
 * `credentials` is DSH's credential service and `key` the record Fig owns in it; `oauth` is pi-ai's
 * Sign in with ChatGPT (login, refresh); `hostPath` holds the installation UUID.
 */
export function chatgptSession({ credentials, key, oauth, hostPath, now = Date.now }) {
  let login
  let loginError
  let refreshing
  let rejected
  let loginEpoch = 0
  let credentialEpoch = 0

  const read = async () => grantCredential(await credentials.readRecord(key))

  async function refreshed(stale) {
    // The network round trip stays outside the record write, which only replaces the grant it refreshed:
    // a sign-out or a new sign-in in the meantime wins.
    const epoch = credentialEpoch
    refreshing ??= oauth.refresh(stale)
      .then(next => credentials.modifyRecord(key, async current =>
        epoch === credentialEpoch && grantCredential(current)?.access === stale.access && grantCredential(current)?.refresh === stale.refresh ? { kind: 'grant', payload: next } : current))
      .finally(() => { refreshing = undefined })
    return grantCredential(await refreshing)
  }

  return {
    /** A usable access token; refreshes an expired or rejected one. Throws `loginRequired` when signed out. */
    async accessToken() {
      let credential = await read()
      if (!credential) throw new PublicError(loginMessage(), loginRequired)
      if (credential.expires <= now() || credential.access === rejected) {
        try { credential = await refreshed(credential) } catch (error) {
          const failure = safeFailure('AUTH', error instanceof Error ? error.message : '')
          throw new PublicError(failure.message, failure.code === 'CHATGPT_NOT_ELIGIBLE' ? failure.code : loginRequired)
        }
        if (!credential || credential.access === rejected) throw new PublicError(loginMessage(), loginRequired)
      }
      return credential.access
    },
    /** Marks a token the server refused, so the next request refreshes it first. */
    reject(token) { rejected = token },
    async status() {
      const credential = await read()
      return { signedIn: Boolean(credential), signingIn: Boolean(login), ...(loginError ? { error: loginError } : {}) }
    },
    /** Starts the browser sign-in and resolves with its URL; the grant is stored when the browser returns. */
    async start() {
      if (login) return { url: await login.url }
      loginError = undefined
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), loginTimeout)
      let announce
      const url = new Promise((resolve, reject) => { announce = { resolve, reject } })
      const attempt = { url, controller }
      const epoch = ++loginEpoch
      // Claimed before any await, so a second click joins this sign-in instead of starting another.
      login = attempt
      installationId(hostPath).then(id => {
        controller.signal.throwIfAborted()
        return oauth.login({
        signal: controller.signal,
        notify: event => { if (event?.type === 'auth_url' && typeof event.url === 'string') announce.resolve(event.url) },
        // The pasted-URL fallback is not offered; the loopback callback completes the sign-in.
        prompt: prompt => new Promise((_, reject) => {
          const signal = prompt?.signal ?? controller.signal
          signal.addEventListener('abort', () => reject(new Error('prompt withdrawn')), { once: true })
        })
      }, { getDeviceId: () => id, agentName })
      })
        .then(async credential => {
          let committed = false
          await credentials.modifyRecord(key, async current => {
            if (epoch !== loginEpoch || login !== attempt || controller.signal.aborted) return current
            committed = true
            return {kind: 'grant', payload: credential}
          })
          if (committed) credentialEpoch++
        })
        .then(() => { if (epoch === loginEpoch && login === attempt) rejected = undefined },
          error => {
            const failure = safeFailure('LOGIN', error instanceof Error ? error.message : '')
            const message = controller.signal.aborted ? uiText('登录已超时或取消。', 'Sign-in timed out or was cancelled.')
              : failure.code === 'CHATGPT_NOT_ELIGIBLE' ? failure.message : uiText('ChatGPT 登录未完成，请重试。', 'ChatGPT sign-in did not finish. Try again.')
            announce.reject(new PublicError(message))
            if (login === attempt) loginError = message
          })
        .finally(() => { clearTimeout(timer); if (login === attempt) login = undefined })
      return { url: await url }
    },
    cancel() {
      loginEpoch++
      const attempt = login
      login = undefined
      attempt?.controller.abort()
    },
    async signOut() {
      loginEpoch++
      credentialEpoch++
      const attempt = login
      login = undefined
      attempt?.controller.abort()
      loginError = undefined
      rejected = undefined
      await credentials.deleteRecord(key)
    }
  }
}
