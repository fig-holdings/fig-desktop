import { directoryBody, inputTypes, positiveLimit, publicOpenAIModels, supportedEntry as compatible } from '../shared/model-discovery.js'
import { nativeSearch } from '../shared/native-search.js'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { unverifiedDsh } from '../dsh-versions'
import { dshHome } from '../shared/dsh-plugin.js'
import { pageRoute, PublicError, registerPageRoute } from '../shared/http.js'
import { loadPiAi, noStoredAuth, piProfiles } from '../shared/pi-ai.js'
import { openAI62Models, supplementOpenAIModels } from '../shared/openai-models.ts'
import { subscriptionAdapter, withMediumDefault } from '../shared/subscription-adapter.js'
import { codexLimits } from './limits.js'
import { subscriptionMenuActions, subscriptionModelPreferences } from '../shared/subscription-model-preferences.js'
import { chatgptSession, loginMessage, loginRequired, safeFailure } from './session.js'
import { uiText } from '../shared/ui-text'

const provider = 'fig-chatgpt'
const displayName = 'ChatGPT Subscription'
const baseUrl = 'https://api.openai.com/v1'
const catalogTtl = 5 * 60_000
// DSH requires an idle limit per route; its own default is 5 minutes.
const streamIdleTimeoutMs = 300_000
// Defaults for a listed model pi-ai's catalog does not know yet.
const fallback = { contextWindow: 272_000, maxTokens: 128_000 }

function listedChatModel(entry) {
  return typeof entry?.slug === 'string' && /^[\w.-]+$/.test(entry.slug) && entry.visibility === 'list'
}


export const inject = ['llm', 'credentials']

/**
 * The account's chat models: `GET /v1/models` entries listed for display (`visibility: list`), with
 * input types from the account where available, and model defaults from pi-ai's OpenAI catalog.
 */
export function catalogModels(document, known = new Map()) {
  const entries = Array.isArray(document?.models) ? document.models : []
  const models = new Map()
  for (const entry of entries) {
    if (!listedChatModel(entry) || !compatible(entry)) continue
    const base = known.get(entry.slug)
    const name = typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name : base?.name ?? entry.slug
    models.set(entry.slug, {
      id: entry.slug, name, api: 'openai-responses', provider, baseUrl,
      contextWindow: positiveLimit(entry.context_window, base?.contextWindow, fallback.contextWindow),
      maxTokens: positiveLimit(entry.max_output_tokens, base?.maxTokens, fallback.maxTokens),
      input: inputTypes(entry.input_modalities, base?.input ?? (Object.hasOwn(openAI62Models, entry.slug) ? ['text', 'image'] : ['text'])), reasoning: base?.reasoning ?? false,
      ...(base?.thinkingLevelMap ? { thinkingLevelMap: base.thinkingLevelMap } : {}),
      ...(base?.compat ? { compat: base.compat } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
  }
  return [...models.values()]
}

const accountPrefix = '/fig-chatgpt'

/** POST /fig-chatgpt/<endpoint>, for authenticated DSH browser sessions only. */
export const accountRoute = pageRoute({
  prefix: accountPrefix,
  endpoints: {
    models: (payload, { settingsModels }) => settingsModels(payload?.refresh === true),
    'models/save': (payload, { saveModels }) => saveModels(payload?.ids),
    // The account with the plan limits at hand; never waits for Codex.
    account: async (_payload, { session, limits }) => {
      const status = await session.status()
      const checkedAt = new Date().toISOString()
      return status.signedIn ? { ...status, checkedAt, limits: await limits.cached() } : { ...status, checkedAt }
    },
    // Live plan limits from Codex; takes a few seconds.
    limits: async (payload, { session, limits }) =>
      (await session.status()).signedIn ? limits.live({ refresh: payload?.refresh === true }) : {},
    login: (_payload, { session }) => session.start(),
    cancel: (_payload, { session }) => { session.cancel(); return {} },
    logout: async (_payload, { session, afterLogout }) => { await session.signOut(); afterLogout?.(); return {} }
  },
  // Only Fig's own messages pass through; upstream text may contain credentials.
  failure: error => ({
    code: 'CHATGPT_ACCOUNT',
    message: error instanceof PublicError ? error.message : uiText('ChatGPT 账号操作失败。', 'The ChatGPT account action failed.')
  })
})

/** The account's chat models from `GET /v1/models`; `LlmError` is DSH's, so the failures reach the model picker. */
async function fetchCatalog(LlmError, { access, known, session, lifecycle, refresh }) {
  const unreachable = uiText('无法获取 ChatGPT 模型目录，请检查网络后重试。', 'Could not get the ChatGPT model list. Check the network and retry.')
  let response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${access}` }, redirect: 'error',
      signal: AbortSignal.any([lifecycle, AbortSignal.timeout(10_000)])
    })
  } catch {
    throw new LlmError(unreachable, 'TRANSPORT')
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    if (response.status === 401) session.reject(access)
    const failure = safeFailure(response.status >= 500 ? 'TRANSPORT' : String(response.status), `${response.status} ${body}`)
    throw new LlmError(failure.message, failure.code)
  }
  const body = await directoryBody(response, LlmError, unreachable)
  if (!Array.isArray(body?.models)) throw new LlmError('Invalid ChatGPT model directory', 'DISCOVERY_FAILED')
  const extra = await publicOpenAIModels(body.models.filter(row => row?.visibility === 'list'
    && !row.input_modalities && !known.has(row.slug) && !Object.hasOwn(openAI62Models, row.slug)).map(row => row.slug), refresh)
  return {
    models: catalogModels(body, new Map([...known, ...extra])),
    unconfirmed: body.models.filter(entry => listedChatModel(entry) && !compatible(entry)).map(entry => entry.slug)
  }
}

export async function apply(ctx) {
  const unverified = await unverifiedDsh('Fig ChatGPT Subscription')
  if (unverified) return ctx.logger.warn(unverified)
  try {
    const { adapterPath, PiAiAdapter, llm: { LlmAdapter, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy }, piModule } = await loadPiAi()
    const fromAdapter = createRequire(adapterPath)
    // pi-ai's OpenAI protocol, sign-in and catalog, through its public `./api/*` and `./providers/*` exports.
    const [{ credentialKey }, { openAIResponsesApi }, { openaiProvider }, { OPENAI_MODELS }] = await Promise.all([
      import(pathToFileURL(fromAdapter.resolve('@deepseek-ai/dsh-credentials')).href),
      piModule('./api/*', 'openai-responses.lazy'),
      piModule('./providers/*', 'openai'),
      piModule('./providers/*', 'openai.models')
    ])
    const wire = openAIResponsesApi()
    const oauth = openaiProvider().auth.oauth
    if (typeof oauth?.login !== 'function' || typeof oauth.refresh !== 'function') throw new Error('pi-ai has no Sign in with ChatGPT')
    const openai = { ...OPENAI_MODELS }
    supplementOpenAIModels(openai)
    const known = new Map(Object.values(openai).map(model => [model.id, model]))

    const session = chatgptSession({
      credentials: ctx.credentials, key: credentialKey(provider, 'subscription'), oauth,
      hostPath: join(dshHome(), 'fig', 'chatgpt-host.json')
    })
    const limits = codexLimits()

    const lifecycle = new AbortController()
    const retryPolicy = resolveRetryPolicy(undefined, provider)

    // Only Fig's own sign-in messages reach the conversation; the credential store's own errors may carry anything.
    async function token() {
      try { return await session.accessToken() } catch (error) {
        throw new LlmError(error instanceof PublicError ? error.message : loginMessage(), /** @type {{ code?: string }} */ (error).code ?? loginRequired)
      }
    }

    ctx.provide('figChatgptSearch', {
      search: async (model, request, signal) => nativeSearch({
        model, baseURL: baseUrl, api: 'openai-responses', headers: { authorization: 'Bearer ' + await token(), accept: 'text/event-stream' }
      }, request, signal)
    })

    function makeAdapter(models, access) {
      // pi-ai recognizes a ChatGPT sign-in by provider `openai` on api.openai.com and then leaves out
      // the request fields the subscription rejects; the route itself is Fig's own.
      const call = method => (model, context, options) => wire[method]({ ...model, provider: 'openai' }, context, options)
      const profiles = piProfiles({ provider, displayName, baseUrl, models, call, retryPolicy, streamIdleTimeoutMs })
      return new PiAiAdapter({
        profiles: () => profiles, resolveApiKey: async () => access, auth: noStoredAuth,
        // Images (pasted, or opened with read_image) reach the model through DSH's attachment store, as in DSH's own pi-ai plugin.
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref)
      })
    }

    const preferences = subscriptionModelPreferences(join(dshHome(), 'fig', 'chatgpt-model-menu.json'))
    const { adapter, catalogs, settingsModels } = subscriptionAdapter({
      LlmAdapter, provider, displayName, loginRequired, ttl: catalogTtl, safeFailure,
      advertised: preferences.visible, resolved: withMediumDefault, preparedInfo: withMediumDefault,
      // Keyed by the access token, so a new sign-in or refresh reloads the catalog.
      current: async () => {
        const access = await token()
        const load = async refresh => {
          const { models, unconfirmed } = await fetchCatalog(LlmError, { access, known, session, lifecycle: lifecycle.signal, refresh })
          return { models, unconfirmed, adapter: makeAdapter(models, access), access }
        }
        return { key: createHash('sha256').update(access).digest('hex'), load }
      },
      rejected: ({ access }) => session.reject(access)
    })
    const menu = subscriptionMenuActions(preferences, settingsModels, () => ctx.emit('llm/models-updated', provider))
    const pageService = { session, limits, ...menu, afterLogout() {
      catalogs.clear()
      ctx.emit('llm/models-updated', provider)
    } }
    registerPageRoute(ctx, accountPrefix, 'fig-chatgpt: account route', (connection, req, res) => accountRoute(connection, req, res, pageService))
    const registration = ctx.llm.registerAdapter([provider], adapter)
    ctx.on('dispose', () => { lifecycle.abort(); session.cancel(); registration() })
  } catch {
    ctx.logger.warn('Fig ChatGPT Provider could not load with this DSH version.')
  }
}
