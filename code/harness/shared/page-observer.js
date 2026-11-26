// One MutationObserver on the DSH page's body for every Fig page plugin that watches the page (desktop-skin's local
// adaptations, the brand's running label, project navigation's header). Each plugin bundles its own copy of this
// module, so the observer itself is a page-wide singleton under a global symbol, with a version so a newer copy is
// never served by an older one. It observes the union of what its watchers ask for and hands each watcher only the
// records it asked for:
// - `ignore` (default: a conversation's content) drops records inside it, so streaming replies wake only the watchers
//   that look inside conversations. An attribute change on an ignored element itself still counts; pass null to see
//   everything.
// - `within` keeps only records inside it, or that add or remove an element that is or contains one.
// - 'sync' watchers run in the observer callback, before paint (text a person must never see change); 'frame' ones run
//   at most once per animation frame however many batches arrive.

const key = Symbol.for('fig.page-observer')
const version = 1
const defaultIgnore = '[data-conversation-content]'

/**
 * @typedef {{ name: string, run: (records?: MutationRecord[]) => void, timing?: 'sync' | 'frame', childList?: boolean,
 *   characterData?: boolean, attributes?: string[], within?: string, ignore?: string | null }} PageWatch
 */

/**
 * The observer behind watchPage, with its browser parts passed in (tests give stand-ins).
 * @param {{ root: () => Node, MutationObserver: typeof MutationObserver, requestAnimationFrame: (run: () => void) => number,
 *   cancelAnimationFrame: (id: number) => void }} env
 */
export function createPageObserver(env) {
  /** @type {Set<PageWatch & { due?: boolean }>} */
  const watchers = new Set()
  let observer, options = '', frame = 0

  const elementOf = node => node instanceof Element ? node : node.parentElement
  // Watchers were separate observers before; one that throws must not stop the others.
  const call = (watcher, records) => { try { watcher.run(records) } catch (error) { console.error('[fig-page-observer] ' + watcher.name, error) } }
  function dispatch(records) {
    // closest() per target and selector, once per batch.
    const cache = new Map()
    const inside = (element, selector) => {
      if (!element) return false
      let bySelector = cache.get(selector)
      if (!bySelector) cache.set(selector, bySelector = new Map())
      let found = bySelector.get(element)
      if (found === undefined) bySelector.set(element, found = element.closest(selector) !== null)
      return found
    }
    const carries = (record, selector) => record.type === 'childList' && [...record.addedNodes, ...record.removedNodes]
      .some(node => node instanceof Element && (node.querySelector(selector) !== null || node.matches(selector)))
    const wants = (watcher, record) => {
      if (record.type === 'childList' ? !watcher.childList : record.type === 'characterData' ? !watcher.characterData
        : !watcher.attributes?.includes(record.attributeName ?? '')) return false
      const ignoreAt = record.type === 'attributes' ? record.target.parentElement : elementOf(record.target)
      if (watcher.ignore && inside(ignoreAt, watcher.ignore)) return false
      return !watcher.within || inside(elementOf(record.target), watcher.within) || carries(record, watcher.within)
    }
    let schedule = false
    for (const watcher of [...watchers]) {
      if (watcher.timing === 'frame' && watcher.due) continue
      const mine = records.filter(record => wants(watcher, record))
      if (!mine.length) continue
      if (watcher.timing === 'sync') call(watcher, mine)
      else { watcher.due = true; schedule = true }
    }
    if (schedule && !frame) frame = env.requestAnimationFrame(runFrame)
  }
  function runFrame() {
    frame = 0
    for (const watcher of [...watchers]) if (watcher.due) { watcher.due = false; call(watcher) }
  }

  // Observe the union of the watchers' needs; re-observing keeps records already queued.
  function reconnect() {
    const childList = [...watchers].some(watcher => watcher.childList)
    const characterData = [...watchers].some(watcher => watcher.characterData)
    const attributeFilter = [...new Set([...watchers].flatMap(watcher => watcher.attributes ?? []))].sort()
    const next = JSON.stringify([childList, characterData, attributeFilter])
    if (next === options && observer) return
    const pending = observer?.takeRecords() ?? []
    observer?.disconnect()
    options = next
    if (!watchers.size) { observer = undefined; return }
    observer ??= new env.MutationObserver(dispatch)
    observer.observe(env.root(), { subtree: true, childList, characterData, ...(attributeFilter.length ? { attributeFilter } : {}) })
    if (pending.length) dispatch(pending)
  }

  return {
    version,
    /** @param {PageWatch} spec @returns {() => void} */
    watch(spec) {
      /** @type {PageWatch & { due?: boolean }} */
      const watcher = { ...spec, timing: spec.timing ?? 'frame', ignore: spec.ignore === undefined ? defaultIgnore : spec.ignore }
      watchers.add(watcher)
      reconnect()
      return () => {
        if (!watchers.delete(watcher)) return
        reconnect()
        if (frame && ![...watchers].some(item => item.due)) { env.cancelAnimationFrame(frame); frame = 0 }
      }
    }
  }
}

/** The page-wide observer: created on first use, shared by every bundle with this version or older. */
function pageObserver() {
  const existing = globalThis[key]
  if (existing && existing.version >= version) return existing
  const created = createPageObserver({ root: () => document.body, MutationObserver,
    requestAnimationFrame: run => requestAnimationFrame(run), cancelAnimationFrame: id => cancelAnimationFrame(id) })
  globalThis[key] = created
  return created
}

/**
 * Calls `run` when the page changes in a way `spec` asks for; returns the call that stops it.
 * @param {PageWatch} spec
 */
export const watchPage = spec => pageObserver().watch(spec)
