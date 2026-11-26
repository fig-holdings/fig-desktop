import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connect, grokCommand } from './acp'
import { oidcSessionKey } from './shared'
import { runOwnedAgent } from '../shared/owned-agent.js'
import { ttlCache } from '../shared/cache.js'
import { findInTail } from '../shared/file-tail.js'
import { pageRoute, PublicError } from '../shared/http.js'
import { uiText } from '../shared/ui-text'

// Account and weekly allowance for the Grok settings section. Everything comes
// from the signed-in Grok CLI: auth.json for the profile, the CLI's own
// `_x.ai/billing` ACP extension for live usage, and its unified log as fallback.
// Neither source is documented; any unexpected shape is reported as unknown.

const billingLifetime = 60_000
const loginTimeout = 5 * 60_000

/** The single SpaceXAI OIDC session in auth.json, signed in even if its access token expired. */
export function accountProfile(document) {
  const sessions = Object.entries(document ?? {})
    .filter(([key, session]) => oidcSessionKey.test(key) && session?.auth_mode === 'oidc')
    .map(([, session]) => session)
  if (sessions.length !== 1) return undefined
  const [session] = sessions
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined
  const name = [text(session.first_name), text(session.last_name)].filter(Boolean).join(' ') || undefined
  const email = text(session.email)
  return {
    name, email,
    initials: (name ?? email ?? 'G').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(),
    team: session.principal_type !== 'User' || session.coding_data_team === 'team',
    zeroDataRetention: session.team_zero_data_retention === true,
    codingDataOptOut: session.coding_data_retention_opt_out === true
  }
}

/** Normalizes the CLI's billing config; returns undefined for any shape it does not recognize. */
export function billingFrom(value) {
  const config = value?.config
  const percent = config?.creditUsagePercent
  const start = Date.parse(config?.currentPeriod?.start ?? config?.billingPeriodStart)
  const end = Date.parse(config?.currentPeriod?.end ?? config?.billingPeriodEnd)
  if (typeof percent !== 'number' || !Number.isFinite(percent) || !Number.isFinite(end)) return undefined
  const tier = value.subscription_tier ?? value.subscriptionTier
  const balance = config.prepaidBalance?.val
  return {
    usedPercent: Math.min(100, Math.max(0, percent)),
    period: config.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? 'weekly' : 'other',
    ...(Number.isFinite(start) ? { periodStart: new Date(start).toISOString() } : {}),
    periodEnd: new Date(end).toISOString(),
    ...(typeof balance === 'number' && Number.isFinite(balance) ? { prepaidBalance: balance } : {}),
    ...(typeof tier === 'string' && tier ? { tier } : {})
  }
}

/** The newest `billing: fetched credits config` record the interactive CLI wrote to its log. */
export function billingFromLog(text) {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].includes('billing: fetched credits config')) continue
    try {
      const record = JSON.parse(lines[index])
      const billing = billingFrom({ config: record.ctx?.config, subscriptionTier: record.ctx?.subscriptionTier })
      if (billing && !Number.isNaN(Date.parse(record.ts))) return { ...billing, source: 'log', fetchedAt: record.ts }
    } catch { /* A partial last line is skipped. */ }
  }
  return undefined
}

/** The npm Grok entry spawns a native child. Own both through the same pinned supervisor. */
export async function beginLogin(grokHome, authPath = join(grokHome, 'auth.json')) {
  const {executable, env} = await grokCommand()
  await mkdir(grokHome, {recursive: true})
  const controller = new AbortController()
  let announce, output = ''
  const url = new Promise((resolve, reject) => { announce = {resolve, reject} })
  void url.catch(() => {})
  const timer = setTimeout(() => controller.abort(), loginTimeout)
  const done = runOwnedAgent({file: executable, args: ['--no-auto-update', 'login', '--oauth', '--leader-socket', join(grokHome, 'fig-auth-leader.sock')], cwd: grokHome, input: '', signal: controller.signal,
    env: {...env, GROK_HOME: grokHome, GROK_AUTH_PATH: authPath},
    onOutput: (_kind, chunk) => {
      output = (output + chunk).slice(-8192)
      const value = output.match(/https:\/\/auth\.x\.ai\/[^\s]+/)?.[0]
      if (value && !controller.signal.aborted) announce.resolve(value)
    }
  }).then(result => ({completed: result.code === 0, cleanupFailed: false}), error => ({completed: false, cleanupFailed: error?.code === 'AGENT_CLEANUP_FAILED'}))
    .finally(() => { clearTimeout(timer); announce.reject(new PublicError(uiText('Grok CLI 登录已结束或取消。', 'Grok CLI sign-in ended or was cancelled.'))) })
  return {url, done, async cancel() { controller.abort(); const result = await done; if (result.cleanupFailed) throw new PublicError(uiText('Grok CLI 登录清理未确认。', 'Grok CLI sign-in cleanup was not confirmed.')) }}
}

export async function logoutCli(grokHome, authPath) {
  const {executable, env} = await grokCommand()
  const result = await runOwnedAgent({file: executable, args: ['--no-auto-update', 'logout', '--leader-socket', join(grokHome, 'fig-auth-leader.sock')], cwd: grokHome, input: '', signal: AbortSignal.timeout(30000), env: {...env, GROK_HOME: grokHome, GROK_AUTH_PATH: authPath}})
  if (result.code !== 0) throw new PublicError(uiText('Grok CLI 退出失败。请重试或在原CLI操作。', 'Grok CLI sign-out failed. Retry, or sign out in the Grok CLI itself.'))
}

export const accountPrefix = '/fig-grok'

/** POST /fig-grok/account and /fig-grok/login, for authenticated DSH browser sessions only. */
export const accountRoute = pageRoute({
  prefix: accountPrefix,
  endpoints: {
    models: (payload, service) => service.settingsModels(payload?.refresh === true),
    'models/save': (payload, service) => service.saveModels(payload?.ids),
    account: (_payload, account) => account.account(),
    billing: (payload, account) => account.billing({ refresh: payload?.refresh === true }),
    login: (_payload, account) => account.login(),
    cancel: (_payload, account) => account.cancel(),
    logout: (_payload, account) => account.logout()
  },
  // Upstream text may contain credentials; only Fig's own messages pass through.
  failure: error => ({
    code: 'GROK_ACCOUNT',
    message: error instanceof PublicError ? error.message : uiText('Grok 账号信息读取失败。', 'Could not read the Grok account.')
  })
})

export async function readAccountDocument(path) {
  try { const value = JSON.parse(await readFile(path, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape'); return value } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return {}; throw new PublicError(uiText('Grok CLI 账号状态未知；请检查本地授权后刷新。', 'The Grok CLI account state is unknown. Check the local sign-in, then refresh.')) }
}

export function accountService({ grokHome, authPath, readJson = readAccountDocument, start = beginLogin, logout = logoutCli, beforeLogout = async () => {}, afterLogout = () => {} }) {
  let live = ttlCache(billingLifetime)
  let login, signingOut, epoch = 0
  const pendingBilling = new Set()
  function liveBilling() {
    const generation = epoch
    const promise = live.get(async () => {
      const {connection} = await connect(grokHome)
      try {
        const billing = billingFrom(await connection.request('_x.ai/billing', {}, 15000))
        return generation === epoch && billing ? {...billing, source: 'live', fetchedAt: new Date().toISOString()} : undefined
      } finally { await connection.stop() }
    })
    pendingBilling.add(promise)
    void promise.finally(() => pendingBilling.delete(promise)).catch(() => {})
    return promise
  }
  // The CLI's log runs to megabytes; the newest billing record is near its end.
  const logBilling = () => findInTail(join(grokHome, 'logs/unified.jsonl'), billingFromLog).catch(() => undefined)
  const service = {
    get authBlocked() { return Boolean(signingOut) },
    async account() {
      const generation = epoch
      let document
      try { document = await readJson(authPath) } catch { return {state: 'unknown', signedIn: false, signingIn: Boolean(login), checkedAt: new Date().toISOString()} }
      const profile = accountProfile(document)
      if (!profile && Object.entries(document ?? {}).some(([key, value]) => oidcSessionKey.test(key) && value?.auth_mode === 'oidc')) return {state: 'unknown', signedIn: false, signingIn: Boolean(login), checkedAt: new Date().toISOString()}
      const billing = profile ? live.last ?? await logBilling() : undefined
      if (generation !== epoch) return service.account()
      return {state: profile ? 'signed-in' : 'signed-out', signedIn: Boolean(profile), signingIn: Boolean(login), signingOut: Boolean(signingOut), checkedAt: new Date().toISOString(),
        ...(profile ? {profile} : {}), ...(billing ? {billing} : {})}
    },
    async billing({refresh = false} = {}) {
      const generation = epoch
      if (signingOut || !accountProfile(await readJson(authPath))) return {}
      if (generation !== epoch || signingOut) return {}
      if (refresh) live.clear()
      const billing = await liveBilling().catch(() => undefined) ?? await logBilling()
      if (generation !== epoch || signingOut || !accountProfile(await readJson(authPath))) return {}
      return billing ? {billing} : {}
    },
    async login() {
      if (signingOut) throw new PublicError(uiText('Grok CLI 正在退出，请稍后重试。', 'Grok CLI is signing out. Try again shortly.'))
      if (!login) {
        const record = {epoch: ++epoch, handle: start(grokHome, authPath)}
        login = record
        void record.handle.then(handle => handle.done).finally(() => {if (login === record) {login = undefined; live.clear()}}).catch(() => {})
      }
      const record = login
      const handle = await record.handle
      const url = await handle.url
      if (record.epoch !== epoch || login !== record) throw new PublicError(uiText('Grok CLI 登录已取消。', 'Grok CLI sign-in was cancelled.'))
      return {url}
    },
    async cancel() {
      const record = login
      ++epoch; login = undefined; live = ttlCache(billingLifetime)
      if (record) await (await record.handle).cancel()
      return {}
    },
    async logout() {
      if (signingOut) return signingOut
      const record = login
      ++epoch; login = undefined; live = ttlCache(billingLifetime)
      signingOut = (async () => {
        if (record) await (await record.handle).cancel()
        await Promise.allSettled([...pendingBilling])
        await beforeLogout()
        await logout(grokHome, authPath)
        const remaining = await readJson(authPath)
        if (Object.entries(remaining ?? {}).some(([key, value]) => oidcSessionKey.test(key) && value?.auth_mode === 'oidc')) throw new PublicError(uiText('Grok CLI 未确认退出；请在原CLI操作后刷新。', 'Grok CLI did not confirm sign-out. Sign out in the Grok CLI itself, then refresh.'))
        afterLogout()
        return {}
      })().finally(() => {signingOut = undefined})
      return signingOut
    }
  }
  return service
}
