export type ModelSource = 'organization' | 'personal-subscription' | 'personal-api'

/** An id Cowork or Fig hands out: a member, organization, device, Profile, client or provider. */
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value)

export interface TeamModels {
  organizationProviders: string[]
  /** Organization providers the platform supplies (they use team quota); the rest are the tenant's own APIs. */
  platformProviders: string[]
  allowPersonal: boolean
  defaultModel?: { provider: string, model: string }
}

const personalOnly = ['deepseek-account', 'fig-grok-oauth', 'fig-chatgpt']

/** Cowork's model policy. `organizationProviders` items are provider ids, or
 * `{ id, source: "platform" | "tenant" }`; Fig keeps ids and a `platformProviders` list, read back the same way. */
export function teamModels(value: any): TeamModels {
  const items: unknown[] = Array.isArray(value?.organizationProviders) ? value.organizationProviders : []
  const idOf = (item: any) => typeof item === 'string' ? item : item?.id
  const organizationProviders = [...new Set<string>(items.map(idOf).filter((id: unknown) => validId(id) && !personalOnly.includes(id)))].slice(0, 128)
  const platform = new Set<string>([
    ...items.filter((item: any) => item && typeof item === 'object' && item.source === 'platform').map(idOf),
    ...Array.isArray(value?.platformProviders) ? value.platformProviders : []])
  const choice = value?.defaultModel
  return { organizationProviders, platformProviders: organizationProviders.filter(id => platform.has(id)), allowPersonal: value?.allowPersonal !== false,
    ...(organizationProviders.includes(choice?.provider) && typeof choice.model === 'string' && choice.model.length > 0
      ? { defaultModel: { provider: choice.provider, model: choice.model } } : {}) }
}

export function modelSource(provider: string, organizationProviders: readonly string[]): ModelSource | undefined {
  if (!provider || provider === 'deepseek-account') return undefined
  if (organizationProviders.includes(provider)) return 'organization'
  return provider === 'fig-grok-oauth' || provider === 'fig-chatgpt' ? 'personal-subscription' : 'personal-api'
}
