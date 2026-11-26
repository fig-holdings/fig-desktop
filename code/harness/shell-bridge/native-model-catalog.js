// rc.5 does not offer a hook between native credential resolution and its cached pi-ai model list.
// Decorate the native registrations at startup. Other providers and custom URLs keep their original adapters.
import { uiText } from '../shared/ui-text'
import { apiDirectory } from './api-model-discovery.js'

function withDirectory(base, ctx, directory, PiAiAdapter) {
  const lastAdapter = new Map()
  const settingsByProfile = new WeakMap()
  async function forCall(provider) {
    if (provider !== 'openai' && provider !== 'xai') return base
    const profiles = base.config.profiles()
    const profile = profiles.get(provider)
    if (!profile?.piProvider) return base
    const live = await directory(ctx, provider, {}, false, settingsByProfile.get(profile))
    if (!live) { lastAdapter.delete(provider); return base }
    settingsByProfile.set(profile, live.profile)
    // Settings may restrict the catalog, capacities and input types per model.
    const previous = lastAdapter.get(provider)
    if (previous?.rows === live.rows && previous.profile === profile) return previous.adapter
    const selected = live.profile.models?.length ? new Map(live.profile.models.map(row => [row.id, row])) : undefined
    const configuredModels = new Map(profile.piProvider.getModels().map(model => [model.id, model]))
    const models = []
    for (const candidate of live.rows.values()) {
      const { id } = candidate
      if (selected && !selected.has(id)) continue
      const override = selected?.get(id) ?? live.profile.modelOverrides?.[id]
      const configured = configuredModels.get(id)
      // A private id may have no public capability card. Honor an explicitly declared
      // input for that id on a supported protocol, while leaving bare candidates unserved.
      const model = candidate.model ?? (candidate.supported && override?.input?.length ? configured : undefined)
      if (!model) continue
      const resolved = { ...model }
      if (configured) {
        for (const field of ['name', 'contextWindow', 'maxTokens']) {
          if (override?.[field] !== undefined) resolved[field] = configured[field]
        }
        if (override?.input?.length) resolved.input = configured.input
        if (override?.reasoningEfforts !== undefined) {
          resolved.reasoning = configured.reasoning
          resolved.thinkingLevelMap = configured.thinkingLevelMap
        }
        if (configured.compat) resolved.compat = { ...model.compat, ...configured.compat }
      }
      models.push(resolved)
    }
    const snapshot = new Map([[provider, { ...profile, piProvider: { ...profile.piProvider, getModels: () => models } }]])
    const adapter = new PiAiAdapter({ ...base.config, profiles: () => snapshot, resolveApiKey: async () => live.key })
    const prepare = adapter.prepareCall.bind(adapter)
    adapter.prepareCall = async (...args) => {
      const prepared = await prepare(...args)
      async function* stream(options) {
        for await (const chunk of prepared.stream(options)) {
          if (chunk.type === 'finish' && chunk.reason?.failure?.code === 'AUTH') {
            live.invalidate?.()
            ctx.emit('llm/models-updated', provider)
          }
          yield chunk
        }
      }
      return { ...prepared, stream }
    }
    lastAdapter.set(provider, { adapter, profile, rows: live.rows })
    return adapter
  }
  const facade = Object.create(base)
  for (const method of ['listModels', 'resolveModel', 'prepareCall']) {
    facade[method] = async (provider, ...args) => (await forCall(provider))[method](provider, ...args)
  }
  facade.stream = async function* (options) {
    const prepared = await facade.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }
  facade.imageRequestTarget = (provider, model, image) => (lastAdapter.get(provider)?.adapter ?? base).imageRequestTarget(provider, model, image)
  return facade
}

export function installNativeDiscovery({ LlmRuntime, LlmError, PiAiAdapter, credentialKey, known }) {
  const directory = apiDirectory(known, LlmError, credentialKey)
  const originalDiscovery = LlmRuntime.prototype.registerModelDiscovery
  LlmRuntime.prototype.registerModelDiscovery = function (ns, original) {
    if (ns !== 'llm-pi-ai') return originalDiscovery.call(this, ns, original)
    return originalDiscovery.call(this, ns, async (request, signal) => {
      const live = await directory(this.ctx, request.provider, request, true)
      if (!live) return original(request, signal)
      if (!request.apiKey) this.ctx.emit('llm/models-updated', request.provider)
      return [...live.rows.values()].map(({ id, model }) => model ? {
        id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, inputModalities: model.input
      } : { id, name: id + uiText('（能力待确认）', ' (capabilities unconfirmed)') })
    })
  }
  const originalRegistration = LlmRuntime.prototype.registerAdapter
  LlmRuntime.prototype.registerAdapter = function (providers, adapter) {
    return originalRegistration.call(this, providers, adapter instanceof PiAiAdapter
      ? withDirectory(adapter, this.ctx, directory, PiAiAdapter) : adapter)
  }
}
