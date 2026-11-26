// DSH rc.5's native model settings and pi-ai adapter share this account-scoped directory.
import { createHash } from 'node:crypto'
import { directoryBody, inputTypes, positiveLimit, publicOpenAIModels, supportedEntry } from '../shared/model-discovery.js'
import { ttlCache } from '../shared/cache.js'

const roots = { openai: 'https://api.openai.com/v1', xai: 'https://api.x.ai/v1' }

function scopedRoute(provider, profile, draft) {
  return [profile, draft].every(source => (!source?.baseURL || source.baseURL.replace(/\/+$/, '') === roots[provider])
    && (!source?.api || source.api === 'openai-responses'))
}

async function fetchDirectory(provider, headers, known, LlmError, force) {
  const url = roots[provider] + (provider === 'openai' ? '/models' : '/language-models')
  let response
  try { response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) }) }
  catch { throw new LlmError('Model directory is unreachable', 'TRANSPORT') }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError('Model directory returned HTTP ' + response.status,
      response.status === 401 || response.status === 403 ? 'AUTH' : response.status >= 500 ? 'TRANSPORT' : 'DISCOVERY_FAILED')
  }
  const body = await directoryBody(response, LlmError, 'Model directory is unreachable')
  const entries = provider === 'openai' ? body?.data : body?.models
  if (!Array.isArray(entries)) throw new LlmError('Invalid model directory', 'DISCOVERY_FAILED')
  const rows = entries.filter(entry => typeof entry?.id === 'string' && entry.id.length && !entry.hidden)
  const unknownIds = rows.filter(row => !Object.hasOwn(known, row.id)
    && (!row.input_modalities || !row.output_modalities)).map(row => row.id)
  const cards = provider === 'openai' ? await publicOpenAIModels(unknownIds, force) : new Map()
  const result = new Map()
  for (const row of rows) {
    const catalog = Object.hasOwn(known, row.id) ? known[row.id] : undefined
    const card = cards.get(row.id)
    const supported = supportedEntry(row)
    const compatible = supported && (provider === 'xai' || catalog || card
      || Array.isArray(row.input_modalities) && row.input_modalities.includes('text') && row.output_modalities?.includes('text'))
    const model = compatible ? {
      ...catalog, id: row.id, name: row.display_name ?? row.name ?? catalog?.name ?? row.id,
      provider, api: 'openai-responses', type: 'chat', baseUrl: roots[provider],
      input: inputTypes(row.input_modalities, card?.input ?? catalog?.input ?? ['text']),
      contextWindow: positiveLimit(row.context_window, row.max_prompt_length, card?.contextWindow, catalog?.contextWindow, 128_000),
      maxTokens: positiveLimit(row.max_output_tokens, card?.maxTokens, catalog?.maxTokens, 128_000),
      cost: catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: catalog?.reasoning ?? false
    } : undefined
    result.set(row.id, { id: row.id, model, supported })
    if (provider === 'xai' && model && Array.isArray(row.aliases)) {
      for (const id of row.aliases) if (typeof id === 'string' && id && !result.has(id)) result.set(id, { id, model: { ...model, id, name: id } })
    }
  }
  return result
}

export function apiDirectory(known, LlmError, credentialKey) {
  const caches = new Map()
  return async function directory(ctx, provider, draft = {}, force = false, storedProfile = undefined) {
    if (!Object.hasOwn(roots, provider)) return undefined
    const profile = storedProfile ?? ctx.get('settings')?.describe().find(item => item.ns === 'llm-pi-ai')?.value?.providers?.[provider] ?? {}
    if (!scopedRoute(provider, profile, draft)) return undefined
    const creds = ctx.get('credentials')
    let key = draft.apiKey
    if (!key && profile.apiKeyEnv) key = (await creds?.resolve(profile.apiKeyEnv))?.value
    else if (!key) {
      const record = await creds?.readRecord(credentialKey('llm-pi-ai', provider))
      if (record && record.kind !== 'api-key') return undefined
      key = record?.key || (await creds?.resolve(provider === 'openai' ? 'OPENAI_API_KEY' : 'XAI_API_KEY'))?.value
    }
    if (!key) {
      caches.get(provider)?.clear()
      return { rows: new Map(), profile, key: undefined }
    }
    const headers = new Headers(profile.headers)
    headers.set('authorization', 'Bearer ' + key)
    const account = createHash('sha256').update(JSON.stringify([...headers])).digest('hex')
    if (!caches.has(provider)) caches.set(provider, ttlCache(300_000))
    // A one-shot key belongs to an unsaved settings draft.
    const cache = draft.apiKey ? ttlCache(0) : caches.get(provider)
    if (force) cache.expire()
    const rows = await cache.get(() => fetchDirectory(provider, headers, known[provider], LlmError, force), account)
      .catch(error => {
        const last = cache.forKey(account)
        if (last && error.code === 'TRANSPORT') return last
        if (error.code === 'AUTH') cache.clearKey(account)
        throw error
      })
    return { rows, profile, key, invalidate: () => cache.clearKey(account) }
  }
}
