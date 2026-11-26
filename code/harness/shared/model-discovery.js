// OpenAI's public cards supply capabilities when the authenticated list contains only ids.
// Match public ids from the index before asking for a card: private model names never leave the route.
import { ttlCache } from './cache.js'

const day = 86_400_000
const publicIndex = ttlCache(300_000)
const cards = new Map()

export function allowsText(values) {
  return values === undefined || Array.isArray(values) && values.includes('text')
}

/** Backends whose models speak the Responses API. */
export const responsesBackends = Object.freeze(['responses', 'openai-responses'])

/** A directory entry Fig can chat with: on one of `backends` (or unnamed) and answering in text. */
export function supportedEntry(entry, backends = responsesBackends) {
  return (!entry.api_backend || backends.includes(entry.api_backend)) && allowsText(entry.output_modalities)
}

/**
 * A model directory's JSON body. A body that is not JSON (a proxy's or captive portal's page) reads as `null`, which the
 * caller's shape check reports as an invalid directory; a read cut short is a transport failure, as before the response.
 */
export async function directoryBody(response, LlmError, transportMessage) {
  try { return await response.json() } catch (error) {
    if (error instanceof SyntaxError) return null
    throw new LlmError(transportMessage, 'TRANSPORT')
  }
}

export function positiveLimit(...values) {
  return values.find(value => Number.isSafeInteger(value) && value > 0)
}

export function inputTypes(values, fallback = ['text']) {
  if (!Array.isArray(values) || !values.length) return fallback
  const input = ['text', 'image'].filter(type => values.includes(type))
  return input.length ? input : ['text']
}

async function documentText(url) {
  const res = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error('Model metadata unavailable')
  return res.text()
}

async function publicCard(slug) {
  const text = await documentText('https://developers.openai.com/api/docs/models/' + slug + '.md')
  const field = name => text.match(new RegExp('^- ' + name + ': (.+)$', 'im'))?.[1].trim().toLowerCase().split(/,\s*/)
  const inputs = field('Input modalities'), outputs = field('Output modalities')
  if (!inputs?.includes('text') || !outputs?.includes('text') || !/^\| Responses \| `\/?v1\/responses` \| Supported \|/im.test(text)) return undefined
  const capacity = label => Number(text.match(new RegExp('^- ([\\d,]+) ' + label, 'im'))?.[1].replaceAll(',', '')) || undefined
  return { input: inputTypes(inputs), contextWindow: capacity('context window'), maxTokens: capacity('max output tokens') }
}

export async function publicOpenAIModels(ids, force = false) {
  const result = new Map()
  if (!ids.length) return result
  if (force) publicIndex.expire()
  const index = await publicIndex.get(async () => {
    const page = await documentText('https://developers.openai.com/api/docs/models.md')
    return new Set([...page.matchAll(/\(\/api\/docs\/models\/([\w.-]+)\)/g)].map(match => match[1].replace(/\.md$/, '')))
  }).catch(() => publicIndex.last)
  if (!index) return result
  const published = ids.filter(id => index.has(id))
  // Bound concurrent requests even when a new installation has many unknown models.
  async function worker() {
    for (let id; (id = published.pop()) !== undefined;) {
      if (!cards.has(id)) cards.set(id, ttlCache(day))
      const card = cards.get(id)
      if (force) card.expire()
      const value = await card.get(() => publicCard(id)).catch(() => card.last)
      if (value) result.set(id, value)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, published.length) }, worker))
  return result
}
