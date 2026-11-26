import { findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJsonFile } from './atomic-json.ts'
import { dshResolve, fromDsh } from './dsh-plugin.js'

// pi-ai as Fig's subscription providers use it: the PiAiAdapter of the installed DSH pi-ai plugin, DSH's LLM
// classes, and pi-ai's own protocol and provider modules, all from the DSH that runs.

/** Resolve pi-ai's import-only public exports from the DSH adapter that owns the dependency. */
export async function piModuleLoader(adapterPath = dshResolve('@deepseek-ai/dsh-llm-pi-ai')) {
  const piManifest = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(adapterPath))
  if (!piManifest) throw new Error('pi-ai not found')
  const exports = (await readJsonFile(piManifest))?.exports
  /** @param {string} pattern @param {string} name */
  const piModule = (pattern, name) => {
    const target = exports?.[pattern]?.import
    if (typeof target !== 'string' || !target.startsWith('./') || !target.includes('*')) throw new Error('Unsupported pi-ai exports')
    return import(pathToFileURL(join(dirname(piManifest), target.replaceAll('*', name))).href)
  }
  return piModule
}

export async function loadPiAi() {
  const adapterPath = dshResolve('@deepseek-ai/dsh-llm-pi-ai')
  const [{ PiAiAdapter }, llm, piModule] = await Promise.all([
    import(pathToFileURL(adapterPath).href), fromDsh('@deepseek-ai/dsh-llm'), piModuleLoader(adapterPath)
  ])
  return { adapterPath, PiAiAdapter, llm, piModule }
}

/**
 * No stored or ambient credentials are visible to pi-ai. Each request receives only the access token the
 * provider resolves itself.
 */
export const noStoredAuth = {
  credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
  authContext: { env: async () => undefined, fileExists: async () => false }
}

/**
 * The PiAiAdapter profiles for one provider route serving `models`. `call(method)` sends a request through pi-ai's
 * protocol for a model; the API key pi-ai passes along is the token the adapter's `resolveApiKey` returned.
 * @param {{ provider: string, displayName: string, baseUrl: string, models: any[], call: (method: 'stream' | 'streamSimple') => Function,
 *   retryPolicy: unknown, headers?: Record<string, string>, streamIdleTimeoutMs: number }} options
 */
export function piProfiles({ provider, displayName, baseUrl, models, call, retryPolicy, headers = {}, streamIdleTimeoutMs }) {
  const piProvider = {
    id: provider, name: displayName, baseUrl, getModels: () => models,
    auth: { apiKey: { name: displayName, resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: displayName }) } },
    stream: call('stream'), streamSimple: call('streamSimple')
  }
  return new Map([[provider, {
    provider, displayName, piProvider, retryPolicy, headers, modelErrors: new Map(),
    configuredMaxTokens: new Map(), streamIdleTimeoutMs, maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048, requestImageMaxBytes: 1024 * 1024
  }]])
}
