// These requests are made only after DSH dispatches the user's web_search tool.
// The owner of the selected model route supplies its endpoint and authentication.
import { uiText } from './ui-text.ts'

export const unsupportedSearch = () => new Error(uiText(
  '当前模型接入未提供可用的原生搜索。可在联网搜索设置中选择独立服务。',
  'This model connection does not provide native search. You can select an independent service in Web search settings.'))

/** The search started but the service stopped it (a quota, a rate limit, an outage): not a model without search. */
function searchFailed(event) {
  const code = [event.error?.code, event.response?.error?.code, event.code].find(value => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value))
  return new Error(uiText('搜索服务中途出错', 'The search service stopped with an error') + (code ? ` (${code})` : '')
    + uiText('。请稍后重试，或检查账号的用量额度。', '. Try again later, or check the account’s usage limits.'))
}

function sources(entries) {
  const unique = new Map()
  for (const item of entries) {
    if (typeof item?.url !== 'string' || !/^https?:$/.test(URL.parse(item.url)?.protocol ?? '')) continue
    if (!unique.has(item.url)) unique.set(item.url, {
      url: item.url, ...(typeof item.title === 'string' && { title: item.title }),
      ...(typeof item.snippet === 'string' && { snippet: item.snippet })
    })
  }
  return { sources: [...unique.values()], truncated: false }
}

export async function searchResponse(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(uiText('搜索服务返回 HTTP ', 'Search service returned HTTP ') + response.status
      + uiText('。请检查该端点、模型与账号的搜索权限。', '. Check search access for this endpoint, model and account.'))
  }
  return response
}

async function responsesResult(response) {
  const contentType = response.headers.get('content-type')?.toLowerCase()
  if (contentType?.includes('json')) return response.json()
  // A Responses stream carries all finalized output in response.completed. Ignore partial text.
  // The subscription gateway can send that stream without a Content-Type header.
  const reader = response.body?.getReader()
  if (!reader) throw unsupportedSearch()
  const decoder = new TextDecoder()
  let pending = ''
  let format = contentType?.includes('text/event-stream') ? 'event-stream' : undefined
  const items = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      if (!format) {
        const start = pending.trimStart()[0]
        if (start) format = start === '{' ? 'json' : 'event-stream'
      }
      if (format === 'json') {
        if (pending.length > 4_000_000) throw unsupportedSearch()
        if (done) return JSON.parse(pending)
        continue
      }
      if (done) pending += '\n'
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trimEnd()
        pending = pending.slice(end + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        const event = JSON.parse(data)
        if (event.type === 'response.output_item.done' && event.item) items.push(event.item)
        // An incomplete response (a token limit) still carries the searches it finished.
        if (['response.completed', 'response.done', 'response.incomplete'].includes(event.type)) {
          const output = event.response?.output
          return { ...event.response, output: output?.length ? output : items }
        }
        if (event.type === 'error' || event.type === 'response.failed') throw searchFailed(event)
      }
      if (done || pending.length > 4_000_000) throw unsupportedSearch()
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function nativeSearch({ api, baseURL, headers, model }, request, signal) {
  const root = baseURL.replace(/\/+$/, '')
  const prompt = 'Search the web and cite sources for: ' + request.query
  const post = (endpoint, body) => searchResponse(endpoint, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  if (api === 'openai-responses') {
    const result = await responsesResult(await post(root + '/responses', {
      model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      tools: [{ type: 'web_search' }], stream: true, store: false,
      ...(new URL(root).origin === 'https://api.openai.com' && { include: ['web_search_call.action.sources'] })
    }))
    const output = result?.output ?? []
    const citations = output.flatMap(item => (item.content ?? []).flatMap(block =>
      (block.annotations ?? []).filter(annotation => annotation.type === 'url_citation')))
    // Some Responses hosts also return the searched URLs directly on the tool or response.
    for (const item of output) if (item.type === 'web_search_call') citations.push(...(item.action?.sources ?? []))
    for (const url of result?.citations ?? []) if (typeof url === 'string') citations.push({ url })
    const found = sources(citations)
    if (!found.sources.length && !output.some(item => item.type === 'web_search_call' && item.status === 'completed')) throw unsupportedSearch()
    const content = output.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
      .filter(block => block.type === 'output_text' && typeof block.text === 'string').map(block => block.text).join(' ').slice(0, 4000)
    return found.sources.length && content ? { ...found, content } : found
  }
  if (api === 'google-generative-ai') {
    const response = await post(root + '/models/' + encodeURIComponent(model) + ':generateContent', {
      contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }]
    })
    const result = await response.json()
    const metadata = result.candidates?.[0]?.groundingMetadata
    if (!metadata?.webSearchQueries?.length && !metadata?.groundingChunks?.length) throw unsupportedSearch()
    return sources((metadata.groundingChunks ?? []).map(chunk => ({ url: chunk.web?.uri, title: chunk.web?.title })))
  }
  if (api === 'anthropic-messages') {
    const endpoint = root.endsWith('/v1') ? root + '/messages' : root + '/v1/messages'
    const response = await post(endpoint, { model, max_tokens: 1536, messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] })
    const result = await response.json()
    const blocks = (result.content ?? []).filter(block => block.type === 'web_search_tool_result')
    if (!blocks.length || blocks.some(block => !Array.isArray(block.content))) throw unsupportedSearch()
    return sources(blocks.flatMap(block => block.content.filter(item => item.type === 'web_search_result')))
  }
  throw unsupportedSearch()
}

export async function braveSearch(key, request, signal) {
  if (!key) throw new Error(uiText('请先在 Fig 的联网搜索设置中保存 Brave Search API Key。',
    'Save your Brave Search API key in Fig’s Web search settings first.'))
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', request.query)
  url.searchParams.set('count', String(Math.min(request.maxResults ?? 10, 20)))
  const response = await searchResponse(url, { headers: { 'X-Subscription-Token': key, accept: 'application/json' }, signal })
  const result = await response.json()
  return sources((result.web?.results ?? []).map(item => ({ url: item.url, title: item.title, snippet: item.description })))
}
