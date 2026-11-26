import { ttlCache } from './cache.js'
import { mediumDefault } from './medium-effort.ts'

// The DSH LLM adapter of a subscription provider (Grok, ChatGPT): the account's model catalog, cached per
// sign-in, behind a PiAiAdapter built for that catalog. The provider supplies the sign-in, the catalog load and
// its own failure mapping; this file holds what both do the same way.

/** A model's info with the Medium default (medium-effort.ts) applied; the same object when nothing changes. */
export function withMediumDefault(info) {
  const reasoning = mediumDefault(info.reasoning)
  return reasoning === info.reasoning ? info : { ...info, reasoning }
}

/** Signed out: no models, as DSH shows any provider without a credential. Other failures stay visible. */
export async function signedInModels(list, loginRequired) {
  try { return await list() } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code === loginRequired) return []
    throw error
  }
}

/**
 * @param {object} options
 * @param {any} options.LlmAdapter - DSH's adapter base class
 * @param {string} options.provider @param {string} options.displayName
 * @param {string} options.loginRequired - the failure code that means "sign in again"
 * @param {number} options.ttl - how long a catalog is kept
 * @param {() => Promise<{ key: string, load: (refresh?: boolean) => Promise<{ models: any[], adapter: any }> }>} options.current - the
 *   current sign-in's cache key and the load of its catalog; throws `loginRequired` when signed out
 * @param {(code: string, message: string) => { code: string, message: string }} options.safeFailure - a stream failure as fixed text
 * @param {(catalog: any) => unknown} options.rejected - the server refused the catalog's sign-in
 * @param {(models: any[]) => Promise<any[]>} [options.advertised] - limits catalog discovery, not exact model routing
 * @param {(model: any) => object} [options.listed] - extra fields of a listed model
 * @param {(info: any, model: string, catalog: any) => any} [options.resolved] - adjusts a resolved model
 * @param {(info: any, model: string, catalog: any) => any} [options.preparedInfo] - adjusts the metadata DSH uses to apply call defaults
 * @param {(stream: (options: any) => AsyncIterable<any>, options: any) => AsyncIterable<any>} [options.around] - wraps each stream
 */
export function subscriptionAdapter({ LlmAdapter, provider, displayName, loginRequired, ttl, current, safeFailure, rejected,
  advertised = async models => models, listed = () => ({}), resolved = info => info, preparedInfo = info => info,
  around = (stream, options) => stream(options) }) {
  const catalogs = ttlCache(ttl)

  async function catalog(force = false) {
    const { key, load } = await current().catch(error => {
      if (error.code === loginRequired) catalogs.clear()
      throw error
    })
    if (force) catalogs.expire()
    return catalogs.get(() => load(force), key).catch(error => {
      if (error.code === loginRequired) catalogs.clearKey(key)
      const last = catalogs.forKey(key)
      if (last && error.code === 'TRANSPORT') return last
      throw error
    })
  }

  async function settingsModels(force) {
    const loaded = await catalog(force)
    return { models: [...loaded.models.map(({ id, input }) => ({ id, input })), ...(loaded.unconfirmed ?? []).map(id => ({ id }))] }
  }

  class SubscriptionAdapter extends LlmAdapter {
    providerInfo() { return { id: provider, name: displayName } }

    async listModels() {
      return signedInModels(async () => (await advertised((await catalog()).models)).map(model => ({
        provider, id: model.id, name: model.name, inputModalities: model.input, ...listed(model)
      })), loginRequired)
    }

    async resolveModel(route, model, signal) {
      const loaded = await catalog()
      return resolved(await loaded.adapter.resolveModel(route, model, signal), model, loaded)
    }

    async prepareCall(route, model, signal) {
      const loaded = await catalog()
      const prepared = await loaded.adapter.prepareCall(route, model, signal)
      // Upstream failure text may contain credentials; a refused sign-in reloads the catalog on the next call.
      async function* mapped(options) {
        for await (const chunk of prepared.stream(options)) {
          if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') { yield chunk; continue }
          const { code, message } = chunk.reason.failure
          const failure = safeFailure(code, message)
          if (failure.code === loginRequired) {
            await rejected(loaded)
            if (catalogs.last === loaded) catalogs.clear()
          }
          yield { ...chunk, reason: { kind: 'error', failure } }
        }
      }
      return { ...prepared, model: preparedInfo(prepared.model, model, loaded), stream: options => around(mapped, options) }
    }

    async *stream(options) {
      const prepared = await this.prepareCall(options.provider, options.model, options.signal)
      yield* prepared.stream(options)
    }
  }

  return { adapter: new SubscriptionAdapter(), catalogs, catalog, settingsModels }
}
