import { isZh } from '../shared/page-locale.js'
import { diffAddress } from './client-diff.js'
import { pullDetailAddress } from './client-pull-detail.js'

// The 研发工作台 page's state, shared by every card, dialog and tab of the page: which cards and dialogs are open, and
// per Session the repository status, pull requests and outputs the Host last returned.

const preferenceKey = 'fig.developmentWorkbench.open'
const readPreference = () => {
  try { return localStorage.getItem(preferenceKey) !== 'closed' } catch { return true }
}
/** Remembers the docked card's open/closed choice. @param {boolean} open */
export const writePreference = open => {
  try { localStorage.setItem(preferenceKey, open ? 'open' : 'closed') } catch { /* page storage is a convenience */ }
}

/** Logs a page failure the user cannot act on. @param {unknown} error */
export const logError = error => console.error('[fig-development-workbench]', error)

/** The page language for the Host's instructions. */
export const language = () => isZh() ? 'zh' : 'en'

/**
 * @param {(endpoint: string, payload: any) => Promise<any>} call
 * @param {() => any} pageCtx - the plugin's page context when mounted
 */
export function workbenchStore(call, pageCtx) {
  // Page-wide state: the remembered open/closed choice and which Sessions show a popover.
  /** `commitFor`: the Session whose 提交 dialog is open, rendered by its header button so it outlives a popover. */
  /** `action`: the Session and kind of the open push / pull request / fix / merge / auto-fix dialog, rendered the same way. */
  let state = { open: readPreference(), popovers: /** @type {Set<string>} */ (new Set()), commitFor: /** @type {string | undefined} */ (undefined),
    action: /** @type {{ sessionId: string, kind: string, data: any } | undefined} */ (undefined) }
  const listeners = new Set()
  /** @param {typeof state} next */
  const setState = next => { state = next; for (const listener of listeners) listener() }
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }

  /** Everything read from the Host, by Session: one listener set for all of it. */
  const dataListeners = new Set()
  let epoch = 0
  const subscribeData = listener => { dataListeners.add(listener); return () => dataListeners.delete(listener) }
  const changed = () => { for (const listener of dataListeners) listener() }
  /**
   * Session id → { value, error, loading } of one endpoint, read once at a time per Session.
   * @param {(sessionId: string, ...rest: any[]) => Promise<any>} read
   * @param {(value: any, previous: any) => any} [accept] - the entry for a reply
   */
  const keyedLoader = (read, accept = value => ({ value, loading: false })) => {
    const entries = new Map()
    /** @param {string} sessionId @param {...any} rest */
    const load = (sessionId, ...rest) => {
      const current = entries.get(sessionId)
      if (current?.loading) return
      const pending = { ...current, loading: true }
      entries.set(sessionId, pending)
      changed()
      read(sessionId, ...rest).then(
        value => { if (entries.get(sessionId) === pending) entries.set(sessionId, accept(value, current)) },
        error => { if (entries.get(sessionId) === pending) entries.set(sessionId, { ...current, error: String(error?.message ?? error), loading: false }) }
      ).finally(changed)
    }
    return { get: (/** @type {string} */ sessionId) => entries.get(sessionId), load, clear: () => entries.clear(), keys: () => [...entries.keys()] }
  }

  const statuses = keyedLoader(sessionId => call('status', { session: sessionId }))
  /** Session id → when its pull requests were last asked for, so two pollers (card and PR 详情) do not both hit gh. */
  const pullsAskedAt = new Map()
  /**
   * Session id → its pull requests, read with gh; `force` skips the Host's one-minute reuse; `checks` re-reads only
   * those pull requests (their checks are running) into the Host's list. A gh problem keeps the last lists.
   */
  const pulls = keyedLoader((sessionId, force = false, checks = []) => {
    pullsAskedAt.set(sessionId, Date.now())
    return call('pulls', { session: sessionId, force, checks })
  }, (value, current) => value.problem ? { ...(!value.clear ? current : {}), loading: false, error: value.problem, failedAt: Date.now() } : { value, loading: false })
  const outputs = keyedLoader(sessionId => call('outputs', { session: sessionId }))
  /** @param {string} sessionId */
  const refreshAll = (sessionId, force = false) => { statuses.load(sessionId); pulls.load(sessionId, force); outputs.load(sessionId) }

  /**
   * Closes the Session's popover (the sidebar or a dialog now holds what it opened), with `patch` applied to the state.
   * @param {string} sessionId @param {Partial<typeof state>} [patch]
   */
  const closePopover = (sessionId, patch) => {
    if (!patch && !state.popovers.has(sessionId)) return
    const popovers = new Set(state.popovers)
    popovers.delete(sessionId)
    setState({ ...state, popovers, ...patch })
  }
  /** Opens a resource in the right sidebar; a popover closes. @param {string} sessionId @param {string} address */
  const openInSidebar = (sessionId, address) => {
    closePopover(sessionId)
    void pageCtx()?.sidebarRight?.openResource(address)?.catch?.(logError)
  }

  function watchExtension() {
    let active = true, timer
    const refresh = async () => {
      if (!active) return
      const value = await call('extension-state', {}).catch(() => undefined)
      if (!active || value?.mode === 'local') return
      const next = Number.isSafeInteger(value?.epoch) ? value.epoch : -1
      if (next !== epoch) {
        epoch = next
        const sessions = pulls.keys()
        pulls.clear(); pullsAskedAt.clear()
        setState({ ...state, action: undefined })
        changed()
        if (value) for (const session of sessions) pulls.load(session, true)
      }
      timer = setTimeout(refresh, 1000)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }

  return {
    get state() { return state }, setState, subscribe, snapshot: () => state,
    subscribeData, statuses, pulls, outputs, pullsAskedAt, refreshAll, closePopover, watchExtension, extensionEpoch: () => epoch,
    async openComparison(sessionId, grant) {
      const result = await call('open-comparison', { session: sessionId, grant })
      if (!result?.handle) return false
      openInSidebar(sessionId, diffAddress(sessionId, 'compare', result.handle))
      return true
    },
    /** 代码变更 of one scope, or a pull request's diff for review (`url`). */
    openDiff: (/** @type {string} */ sessionId, /** @type {any} */ scope, /** @type {string} */ url) => openInSidebar(sessionId, diffAddress(sessionId, scope, url)),
    /** One pull request's details. */
    openPullDetail: (/** @type {string} */ sessionId, /** @type {string} */ url) => openInSidebar(sessionId, pullDetailAddress(sessionId, url)),
    /** The 提交 dialog. */
    openCommit: (/** @type {string} */ sessionId) => closePopover(sessionId, { commitFor: sessionId }),
    /** One action dialog. */
    openAction: (/** @type {string} */ sessionId, /** @type {string} */ kind, /** @type {any} */ data) => closePopover(sessionId, { action: { sessionId, kind,
      data: kind === 'worktree' ? { ...data, branchFor: pulls.get(sessionId)?.value?.sessionPolicy?.branchFor } : data } }),
    /** Puts a quote in the Session's input through DSH's public input facade (as its own message quotes do); never sends. */
    quote: (/** @type {string} */ sessionId, /** @type {string} */ value) => {
      try {
        const scope = pageCtx()?.sessions?.scope?.(sessionId)
        const conversation = scope?.get?.('conversation')
        if (!scope || !conversation?.input?.for) return false
        const input = conversation.input.for(scope)
        if (!input.insertQuote(value)) return false
        input.focus?.()
        return true
      } catch (error) { logError(error); return false }
    }
  }
}
