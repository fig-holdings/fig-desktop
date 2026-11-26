import { directoryBody, inputTypes, supportedEntry } from '../shared/model-discovery.js'
import { nativeSearch, unsupportedSearch } from '../shared/native-search.js'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { connect } from './acp'
import { unverifiedDsh } from '../dsh-versions'
import { dshHome } from '../shared/dsh-plugin.js'
import { subscriptionMenuActions, subscriptionModelPreferences } from '../shared/subscription-model-preferences.js'
import { grokPaths, grokReasoning, largestWindow, loginMessage, loginRequired, oidcSessionKey, reasoningLevels, safeFailure } from './shared'
import { readJsonFile as readJson } from '../shared/atomic-json.ts'
import { registerPageRoute } from '../shared/http.js'
import { loadPiAi, noStoredAuth, piProfiles } from '../shared/pi-ai.js'
import { subscriptionAdapter } from '../shared/subscription-adapter.js'
import { accountPrefix, accountRoute, accountService, accountProfile } from './account.js'
import { uiText } from '../shared/ui-text'

const provider = 'fig-grok-oauth'
const displayName = 'Grok Subscription'
const baseUrl = 'https://cli-chat-proxy.grok.com/v1'
const protocols = {
  responses: ['openai-responses', 'openAIResponsesApi'],
  chat_completions: ['openai-completions', 'openAICompletionsApi'],
  messages: ['anthropic-messages', 'anthropicMessagesApi']
}
const catalogTtl = 60_000
// Models the CLI proxy searches through Responses although the catalog sends their conversation over another
// transport (tried 2026-11-21). Re-check when the catalog changes them.
const responsesSearchModels = new Set(['grok-4.7'])
const refreshBackoff = 60_000
const safeVersion = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
// The proxy sends a tool call only once it is complete, so writing a large file is minutes of
// silence on the stream. DSH's own default is 5 minutes; this leaves room for a long file.
const streamIdleTimeoutMs = 600_000
export const stalledCode = 'GROK_STALLED'
export const stalledMessage = () => uiText('Grok 连续 10 分钟没有返回数据，重试一次后仍然如此，已停止。如果它在一次写入很大的文件，可以让它先写骨架、再分段补充。', 'Grok sent nothing for 10 minutes, and again after one retry, so it was stopped. If it was writing one very large file, ask it to write an outline first and fill it in section by section.')
// Appended to the system prompt of requests that carry tools, so a long file does not hit the timeout above.
export const largeFileRule = 'Tool calls on this connection arrive only once complete, and a very long one can time out. '
  + 'When creating or rewriting a large file (more than about 300 lines or 20 KB), do not put the whole file in one tool call: '
  + 'write a working skeleton first, then add the remaining sections with further edits, keeping each tool call moderate in size.'

export const inject = ['llm']

export function withLargeFileRule(options) {
  if (!options.tools?.length || options.system?.includes(largeFileRule)) return options
  return { ...options, system: options.system ? options.system + '\n\n' + largeFileRule : largeFileRule }
}

export function isIdleTimeout(error) {
  return error?.code === 'TIMEOUT' && /stream idle timeout/.test(error.message ?? '')
}

/**
 * DSH retries a timed-out request with the same messages, up to five times. An idle timeout of the
 * same request is retried once; `failed` says when to stop, so the failure leaves the retry codes.
 */
export function stallGuard(limit = 64) {
  const counts = new Map()
  const keyOf = options => [options.sessionId ?? '', options.messages?.length ?? 0, options.messages?.at(-1)?.id ?? ''].join('|')
  return {
    failed(options) {
      const key = keyOf(options)
      const count = (counts.get(key) ?? 0) + 1
      counts.delete(key)
      counts.set(key, count)
      if (counts.size > limit) counts.delete(counts.keys().next().value)
      return count >= 2
    },
    passed(options) { counts.delete(keyOf(options)) }
  }
}

/**
 * One CLI refresh at a time, with a backoff after a failed one. `refresh()` resolves true only when
 * it started or joined a refresh; a call skipped during the backoff never moves the backoff start.
 * @param {() => Promise<unknown>} attempt
 * @param {{ blocked?: () => boolean, backoff?: number, now?: () => number }} [options]
 */
export function refreshGate(attempt, { blocked = () => false, backoff = refreshBackoff, now = Date.now } = {}) {
  /** @type {Promise<boolean> | undefined} */
  let refreshing
  /** @type {number | undefined} */
  let failedAt
  return {
    get pending() { return refreshing },
    refresh() {
      if (blocked()) return Promise.resolve(false)
      if (!refreshing && failedAt !== undefined && now() - failedAt < backoff) return Promise.resolve(false)
      refreshing ??= Promise.resolve().then(attempt)
        .then(() => true, () => { failedAt = now(); return true })
        .finally(() => { refreshing = undefined })
      return refreshing
    },
    failed() { failedAt = now() },
    reset() { failedAt = undefined }
  }
}

export function oauthAccessToken(document, now = Date.now()) {
  const sessions = Object.entries(document ?? {}).filter(([key, session]) =>
    oidcSessionKey.test(key) && session?.auth_mode === 'oidc' &&
    (session.oidc_issuer === undefined || session.oidc_issuer === 'https://auth.x.ai') &&
    typeof session.key === 'string' && /^[A-Za-z0-9._~+\/=-]{25,}$/.test(session.key) &&
    !session.key.startsWith('xai-') && Date.parse(session.expires_at) > now)
  return sessions.length === 1 ? sessions[0][1].key : undefined
}

function listedGrokModel(entry) {
  return typeof entry?.id === 'string' && /^grok[\w.-]*$/i.test(entry.id) && !entry.hidden
}

const compatible = entry => supportedEntry(entry, Object.keys(protocols))

export function catalogModels(document) {
  const entries = Array.isArray(document?.data) ? document.data : []
  const models = new Map()
  for (const entry of entries) {
    if (!listedGrokModel(entry) || !compatible(entry)) continue
    const [api] = Object.hasOwn(protocols, entry.api_backend) ? protocols[entry.api_backend] : protocols.responses
    const contextWindow = largestWindow(entry.context_window, entry.context_windows) ?? 131_072
    // The catalog leaves the output limit open, as Grok CLI sends none. pi-ai sends a limit
    // regardless and clamps it to the room left in the window, so the window stands in for it.
    const maxTokens = Math.min(contextWindow, positiveInt(entry.max_completion_tokens, contextWindow))
    const reasoning = grokReasoning(entry.supports_reasoning_effort, entry.reasoning_efforts, entry.reasoning_effort)
    models.set(entry.id, {
      id: entry.id, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id,
      api, provider, baseUrl, contextWindow, maxTokens,
      input: inputTypes(entry.input_modalities), reasoning: Boolean(reasoning),
      // `off: null` makes pi-ai omit the reasoning field; the proxy rejects its `effort: 'none'`.
      ...(reasoning ? { thinkingLevelMap: Object.fromEntries(['off', ...reasoningLevels].map(level =>
        [level, reasoning.efforts.some(effort => effort.id === level) ? level : null])) } : {}),
      ...(reasoning ? { dshReasoning: reasoning } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
  }
  return [...models.values()]
}

function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function requestHeaders(version) {
  return {
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-mode': 'headless',
    ...(version ? { 'x-grok-client-version': version } : {})
  }
}

/** The account's models from the proxy's catalog; `LlmError` is DSH's, so the failures reach the model picker. */
async function fetchCatalog(LlmError, { token, version }, lifecycle) {
  const unreachable = uiText('无法获取 Grok 订阅模型目录，请检查网络后重试。', 'Could not get the Grok subscription model list. Check the network and retry.')
  let response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { ...requestHeaders(version), authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.any([lifecycle, AbortSignal.timeout(10_000)])
    })
  } catch {
    throw new LlmError(unreachable, 'TRANSPORT')
  }
  if (!response.ok) {
    await response.body?.cancel()
    const failure = safeFailure(response.status >= 500 ? 'TRANSPORT' : 'GROK_CATALOG', String(response.status))
    throw new LlmError(failure.message, failure.code)
  }
  const body = await directoryBody(response, LlmError, unreachable)
  if (!Array.isArray(body?.data)) throw new LlmError('Invalid Grok model directory', 'DISCOVERY_FAILED')
  const unconfirmed = body.data.filter(row => listedGrokModel(row) && !compatible(row)).map(row => row.id)
  return { models: catalogModels(body), unconfirmed }
}

export async function apply(ctx) {
  const unverified = await unverifiedDsh('Fig Grok Subscription')
  if (unverified) return ctx.logger.warn(unverified)
  try {
    const { PiAiAdapter, llm: { LlmAdapter, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy }, piModule } = await loadPiAi()
    const wire = new Map(await Promise.all(Object.values(protocols).map(async ([api, factory]) =>
      /** @type {[string, any]} */ ([api, (await piModule('./api/*', `${api}.lazy`))[factory]()]))))
    const { grokHome, authPath } = grokPaths()
    // The Grok settings section calls /fig-grok/<endpoint>.
    const account = accountService({ grokHome, authPath, beforeLogout: async () => { await refresher.pending }, afterLogout: () => { catalogs.clear(); rejected = undefined; refresher.reset(); ctx.emit('llm/models-updated', provider) } })
    const lifecycle = new AbortController()
    const retryPolicy = resolveRetryPolicy(undefined, provider)
    const stalls = stallGuard()
    let rejected

    // The CLI owns the refresh token. A headless ACP sign-in lets it rotate an
    // expired or rejected access token; Fig then reads the new one from auth.json.
    const refresher = refreshGate(() => connect(grokHome).then(({ connection }) => connection.stop()), { blocked: () => account.authBlocked })

    async function readSession() {
      const document = await readJson(authPath)
      if (account.authBlocked || !accountProfile(document)) throw new LlmError(loginMessage(), loginRequired)
      let token = oauthAccessToken(document)
      if (!token || token === rejected) {
        const attempted = await refresher.refresh()
        token = oauthAccessToken(await readJson(authPath))
        if (attempted && (!token || token === rejected)) refresher.failed()
      }
      if (account.authBlocked || !token || token === rejected) throw new LlmError(loginMessage(), loginRequired)
      const version = (await readJson(join(grokHome, 'version.json')))?.version
      return { token, version: typeof version === 'string' && safeVersion.test(version) ? version : undefined }
    }

    function makeAdapter(models, version, token) {
      const headers = requestHeaders(version)
      const call = (method) => (model, context, options) => wire.get(model.api)[method](model, context, {
        // The proxy serves the default window unless the request names a larger one, as Grok CLI does.
        ...options, headers: { ...options.headers, 'x-grok-model-override': model.id, 'x-grok-context-window': String(model.contextWindow) }
      })
      const profiles = piProfiles({ provider, displayName, baseUrl, models, call, retryPolicy, headers, streamIdleTimeoutMs })
      // pi-ai sees no stored credentials; each request gets only the current access token from the official CLI's OIDC record.
      return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => token, auth: noStoredAuth,
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref) })
    }

    const preferences = subscriptionModelPreferences(join(dshHome(), 'fig', 'grok-model-menu.json'))
    function withGrokReasoning(info, model, { models }) {
      const reasoning = models.find(item => item.id === model)?.dshReasoning
      return reasoning ? { ...info, reasoning } : info
    }
    const { adapter, catalogs, catalog, settingsModels } = subscriptionAdapter({
      LlmAdapter, provider, displayName, loginRequired, ttl: catalogTtl, safeFailure,
      advertised: preferences.visible,
      // Keyed by token and CLI version, so a new sign-in or CLI update reloads the catalog.
      current: async () => {
        const session = await readSession()
        const load = async () => {
          const { models, unconfirmed } = await fetchCatalog(LlmError, session, lifecycle.signal)
          return { models, unconfirmed, token: session.token, adapter: makeAdapter(models, session.version, session.token) }
        }
        return { key: createHash('sha256').update(session.token).update(session.version ?? '').digest('hex'), load }
      },
      rejected: ({ token }) => { rejected = token },
      listed: model => model.dshReasoning ? { reasoning: model.dshReasoning } : {},
      // Keep Grok's offered names and the same default in the picker and prepared calls.
      resolved: withGrokReasoning, preparedInfo: withGrokReasoning,
      around: async function* (stream, options) {
        try {
          yield* stream(withLargeFileRule(options))
          stalls.passed(options)
        } catch (error) {
          if (isIdleTimeout(error) && stalls.failed(options)) throw new LlmError(stalledMessage(), stalledCode, { cause: error })
          throw error
        }
      }
    })
    ctx.provide('figGrokSearch', {
      async search(model, request, signal) {
        const { models } = await catalog()
        const selected = models.find(item => item.id === model)
        if (!selected || (!responsesSearchModels.has(model) && selected.api !== 'openai-responses')) throw unsupportedSearch()
        const { token, version } = await readSession()
        const headers = { ...requestHeaders(version), authorization: 'Bearer ' + token, accept: 'text/event-stream' }
        return nativeSearch({ api: 'openai-responses', baseURL: baseUrl, headers, model }, request, signal)
      }
    })
    const menu = subscriptionMenuActions(preferences, settingsModels, () => ctx.emit('llm/models-updated', provider))
    const pageService = Object.assign(account, menu)
    registerPageRoute(ctx, accountPrefix, 'fig-grok: account route', (connection, req, res) => accountRoute(connection, req, res, pageService))
    const registration = ctx.llm.registerAdapter([provider], adapter)
    ctx.on('dispose', () => { lifecycle.abort(); registration() })
  } catch {
    ctx.logger.warn('Fig Grok Provider could not load with this DSH version.')
  }
}
