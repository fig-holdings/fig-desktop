import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import { parsePullUrl, safeBranch } from './actions.js'

export const workbenchContractVersion = 1
export const unavailable = () => ({ problem: 'extension-unavailable', clear: true })
export const repoId = value => typeof value === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(value) && !value.split('/').some(part => part === '.' || part === '..')
  ? value.toLowerCase() : undefined
export const targetRepo = url => {
  const pull = parsePullUrl(url)
  return pull && pull.number > 0 && Number.isSafeInteger(pull.number) ? repoId(`${pull.owner}/${pull.repo}`) : undefined
}
export const checkId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value)

/** DSH's loader owns entry identity. A signed bundle's installed module must be the module of that exact live entry. */
async function installedEntry(caller, allowed) {
  if (!allowed || !isAbsolute(allowed.module ?? '') || !/^[\w.-]{1,128}$/.test(allowed.id ?? '')) return undefined
  // The Loader records the imported namespace immediately after attaching its fiber.
  await Promise.resolve()
  let fiber = caller?.fiber
  while (fiber && !fiber.entry) fiber = fiber.parent?.fiber
  const entry = fiber?.entry
  if (!entry || entry.disabled || entry.options?.id !== allowed.id || entry.parent?.tree?.store?.[allowed.id] !== entry || !entry.fiber) return undefined
  const module = await import(/* @vite-ignore */ pathToFileURL(allowed.module).href)
  if (entry.moduleNamespace !== module || entry.parent?.tree?.store?.[allowed.id] !== entry || entry.disabled) return undefined
  return entry
}

/** One generation per active capability; consumers never see a reply after the generation is invalidated. */
export function workbenchExtension(ctx, config, invalidated = () => {}) {
  const mode = !config || config.githubSource === undefined && config.workbenchProvider === undefined ? 'local'
    : ['local', 'mixed', 'extension-only'].includes(config.githubSource) ? config.githubSource : 'disabled'
  let registration, epoch = 0, controller = new AbortController()
  function invalidate() {
    controller.abort()
    controller = new AbortController()
    epoch++
    invalidated()
  }
  const denied = () => { ctx.logger?.warn?.('fig-development-workbench: refused provider registration'); throw new Error('WORKBENCH_PROVIDER_REGISTRATION') }
  // Cordis rebinds this.ctx at the service call site. Neither a caller-selected context nor a supplied name can claim the slot.
  const service = { [Symbol.for('cordis.tracker')]: { property: 'ctx' }, ctx, version: workbenchContractVersion, async register(extension) {
    if (mode === 'local' || mode === 'disabled' || registration || extension?.version !== workbenchContractVersion ||
      typeof extension.provider?.owns !== 'function' || typeof extension.sessionPolicy !== 'function' || typeof extension.pullPolicy !== 'function') return denied()
    let entry
    try { entry = await installedEntry(this.ctx, config?.workbenchProvider) } catch { /* absent signed file or stopped bundle */ }
    if (!entry || registration) return denied()
    const accepted = { entry, extension }
    registration = accepted
    invalidate()
    const dispose = () => { if (registration === accepted) { registration = undefined; invalidate() } }
    entry.fiber.effect(() => dispose)
    return Object.freeze({ dispose, invalidate: () => { if (registration === accepted) invalidate() } })
  } }
  const snapshot = () => ({ mode, epoch, signal: controller.signal, extension: registration?.entry.disabled ? undefined : registration?.extension })
  return { service, snapshot, dispose: () => { registration = undefined; invalidate() } }
}

/** Apply a deadline even when an extension ignores cancellation. Its failures never reach page logs verbatim. */
export async function extensionCall(snapshot, owner, method, args, { maxBytes = 2 * 1024 * 1024, ms = 15_000 } = {}) {
  if (typeof owner?.[method] !== 'function' || snapshot.signal.aborted) return undefined
  const signal = AbortSignal.any([snapshot.signal, AbortSignal.timeout(ms)])
  let stop
  try {
    const value = await Promise.race([Promise.resolve().then(() => owner[method](...args, signal)), new Promise(resolve => {
      stop = () => resolve(undefined)
      signal.addEventListener('abort', stop, { once: true })
    })])
    const json = signal.aborted || value === undefined ? undefined : JSON.stringify(value)
    if (json === undefined || Buffer.byteLength(json) > maxBytes) return undefined
    // A copy: what the caller validates is what it later reads (no getters, no later changes by the extension).
    return JSON.parse(json)
  } catch { return undefined }
  finally { if (stop) signal.removeEventListener('abort', stop) }
}

export function cleanAction(value) {
  if (!value || typeof value.id !== 'string' || !/^[\w.-]{1,100}$/.test(value.id) ||
    typeof value.version !== 'string' || !/^[\w.-]{1,128}$/.test(value.version) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 160)
    return undefined
  return { id: value.id, version: value.version, label: value.label }
}

export function cleanSessionPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return { deliver: cleanAction(value.deliver), linkedPulls: Array.isArray(value.linkedPulls)
    ? [...new Set(value.linkedPulls.filter(url => targetRepo(url)))].slice(0, 30) : [], branchFor: safeBranch(value.branchFor) ? value.branchFor : undefined,
    allowPush: value.allowPush === true, allowCreatePull: value.allowCreatePull === true }
}

export function cleanPullPolicy(value) {
  if (!value || typeof value.managed !== 'boolean') return undefined
  const merge = value.merge
  const label = textLabel(value.label)
  const mergeLabel = textLabel(merge?.label)
  const allowed = Array.isArray(value.allowed) ? ['fix', 'agent-review', 'fetch-branch', 'pull-worktree', 'submit-review', 'merge', 'autofix']
    .filter(name => value.allowed.includes(name) && (!value.managed || name !== 'merge' && name !== 'autofix')) : []
  return { managed: value.managed, label, merge: value.managed && mergeLabel ? { label: mergeLabel } : undefined, allowed,
    actions: Array.isArray(value.actions) ? value.actions.slice(0, 12).map(cleanAction).filter(Boolean) : [] }
}

const textLabel = value => typeof value === 'string' ? value.slice(0, 160) : undefined
