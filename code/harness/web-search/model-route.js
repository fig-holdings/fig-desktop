import { fromDsh } from '../shared/dsh-plugin.js'
import { piModuleLoader } from '../shared/pi-ai.js'
import { nativeSearch, unsupportedSearch } from '../shared/native-search.js'

const catalogs = new Map([['openai', 'OPENAI_MODELS'], ['xai', 'XAI_MODELS'], ['anthropic', 'ANTHROPIC_MODELS'],
  ['google', 'GOOGLE_MODELS']])

// Read the active model configuration from the same settings namespace the model picker uses.
// A route with an explicit credential reference must never borrow an ambient or subscription key.
export async function searchModelRoute(ctx, route, request, signal) {
  const { provider, model } = route
  if (provider === 'fig-chatgpt' || provider === 'fig-grok-oauth') {
    const owner = ctx.get(provider === 'fig-chatgpt' ? 'figChatgptSearch' : 'figGrokSearch')
    if (!owner) throw unsupportedSearch()
    return owner.search(model, request, signal)
  }
  const entry = ctx.get('llm')?.listConfigurableProviders().find(item => item.provider === provider)
  const descriptor = entry && ctx.get('settings')?.describe().find(item => item.ns === entry.settingsNs)
  if (!descriptor) throw unsupportedSearch()
  const configured = entry.settingsPath.reduce((data, key) => data && Object.hasOwn(data, key) ? data[key] : undefined, descriptor.value)
  const profile = configured ?? (entry.declared === false ? {} : undefined)
  if (!profile || entry.error) throw unsupportedSearch()

  if (provider === 'deepseek-official' || provider === 'deepseek-account') {
    const { resolveDeepSeekAccountToken, resolveDeepSeekApiKey, resolveAdapterOptions } = await fromDsh('@deepseek-ai/dsh-llm-deepseek')
    const { launchEnvironmentOf } = await fromDsh('@deepseek-ai/dsh-launch-environment')
    const { DeepSeekSearchProvider, DEEPSEEK_DEFAULT_API_VERSION, DEEPSEEK_DEFAULT_MAX_TOKENS,
      DEEPSEEK_DEFAULT_MAX_USES } = await fromDsh('@deepseek-ai/dsh-web-search-deepseek')
    const root = resolveAdapterOptions({ baseURL: profile.baseURL }, launchEnvironmentOf(ctx)).baseURL.replace(/\/+$/, '')
    const baseURL = root.endsWith('/v1') ? root : root + '/v1'
    const account = provider === 'deepseek-account'
    const key = account ? await resolveDeepSeekAccountToken(ctx, baseURL + '/messages')
      : await resolveDeepSeekApiKey(ctx, profile.apiKeyEnv ?? 'DEEPSEEK_API_KEY')
    if (!key) throw unsupportedSearch()
    return new DeepSeekSearchProvider(() => ({ baseURL, model, apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
      maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS, maxUses: DEEPSEEK_DEFAULT_MAX_USES,
      ...(account ? { resolveAccountToken: async () => key } : { apiKey: key })
    })).search(request, signal)
  }
  if (entry.settingsPath[0] !== 'providers') throw unsupportedSearch()
  let catalog, nativeProvider
  const table = catalogs.get(provider)
  if (table) {
    const piModule = await piModuleLoader()
    const module = await piModule('./providers/*', provider + '.models')
    catalog = Object.values(module[table] ?? {}).find(item => item.id === model)
    const factory = await piModule('./providers/*', provider)
    nativeProvider = factory[provider + 'Provider']()
  }
  const baseURL = profile.baseURL ?? catalog?.baseUrl ?? entry.defaultBaseURL
  const api = profile.api ?? catalog?.api
  if (!baseURL || !['openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(api)) throw unsupportedSearch()
  const credentials = ctx.get('credentials')
  const headers = new Headers(profile.headers)
  let key
  if (profile.apiKeyEnv) {
    key = (await credentials?.resolve(profile.apiKeyEnv))?.value
    if (!key) throw unsupportedSearch()
  } else if (nativeProvider) {
    const { credentialKey } = await fromDsh('@deepseek-ai/dsh-credentials')
    const record = await credentials?.readRecord(credentialKey('llm-pi-ai', provider))
    // An OAuth grant belongs to its adapter, which may refresh it or select another endpoint.
    if (record && record.kind !== 'api-key') throw unsupportedSearch()
    const resolution = await nativeProvider.auth.apiKey.resolve({
      ctx: { env: async name => (await credentials?.resolve(name))?.value },
      credential: record && { type: 'api_key', key: record.key, env: record.env },
      signal: signal ?? new AbortController().signal
    })
    key = resolution?.auth.apiKey
    for (const [name, value] of Object.entries(resolution?.auth.headers ?? {})) headers.set(name, String(value))
  }
  if (api === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01')
  if (key) {
    if (api === 'anthropic-messages') headers.set('x-api-key', key)
    else if (api === 'google-generative-ai') headers.set('x-goog-api-key', key)
    else headers.set('authorization', 'Bearer ' + key)
  } else if (!entry.declared && !headers.has('authorization') && !headers.has('x-api-key') && !headers.has('x-goog-api-key')) {
    throw unsupportedSearch()
  }
  return nativeSearch({ api, baseURL, headers: Object.fromEntries(headers), model }, request, signal)
}
