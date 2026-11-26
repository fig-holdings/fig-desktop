// What Fig's page plugins read from DSH 0.2.2-rc.1 beyond its public interface: page markup that is not a slot, and
// other registrations' injected faces. Kept together so a DSH upgrade is checked in one place; each use is guarded by
// the isolated smokes npm run dsh:verify runs. Bundled into each client that imports it.

/** DSH markup Fig's page plugins match in more than one place. */
export const dshSelectors = Object.freeze({
  /** Each open conversation, marked with its Session id in `data-conversation-session`. */
  conversation: '[data-slot="main.conversation"] [data-conversation-session]',
  /** A conversation's message flow: streaming replies change only this. */
  conversationContent: '[data-conversation-content]',
  /** The running row at the end of a conversation that is working. */
  chatRunning: '[data-chat-running]',
  /** Any open menu (DSH's Menu component and Fig's own). */
  menu: '[role="menu"]'
})

/** The open conversations' elements. */
export const openConversations = () => [...document.querySelectorAll(dshSelectors.conversation)]
/** The first open conversation's element, or null. */
export const openConversation = () => document.querySelector(dshSelectors.conversation)
/** The Session id of the first open conversation, or undefined. */
export const openSessionId = () => openConversation()?.getAttribute('data-conversation-session') ?? undefined

/** A slot's registrations, or none when the slots service cannot list them. */
export function slotEntries(ctx, slot) {
  return typeof ctx?.slots?.entries === 'function' ? ctx.slots.entries(slot) : []
}

/**
 * The injected face of another plugin's registration on `slot`: the first registration `match` accepts (read before
 * injecting, so others are never injected) whose `inject(...args)` returns a face `accept` takes. A registration
 * whose inject throws is skipped, so DSH changing one degrades to "not found" rather than breaking the caller.
 * @param {any} ctx
 * @param {string} slot
 * @param {(entry: any) => boolean} [match]
 * @param {{ accept?: (face: any) => boolean, args?: unknown[] }} [options]
 */
export function slotFace(ctx, slot, match = () => true, { accept = face => face != null, args = [] } = {}) {
  for (const entry of slotEntries(ctx, slot)) {
    if (typeof entry?.inject !== 'function' || !match(entry)) continue
    let face
    try { face = entry.inject(...args) } catch { continue }
    if (accept(face)) return face
  }
  return undefined
}

/**
 * DSH 0.2.2-rc.1 has no public call to open or close settings from outside its shell; the shell store rides on the
 * sidebar.settings registration. Its actions (openSection, close), or undefined.
 * @param {any} ctx
 */
export function settingsActions(ctx) {
  for (const entry of slotEntries(ctx, 'sidebar.settings')) {
    if (typeof entry?.store?.create !== 'function') continue
    try { return entry.store.create()?.actions } catch { return undefined }
  }
  return undefined
}

/**
 * Whether `element` is what the person sees: the window's hit test at a point in its visible part (its box within
 * `clip`'s box, if given, and the window) lands inside it. The point is the centre, or `probeTop` px below the top
 * edge when given (half the height at most). A visible part narrower or shorter than `min` px counts as hidden.
 * @param {Element} element
 * @param {{ clip?: Element, min?: number, probeTop?: number }} [options]
 */
export function isTopmostWithin(element, { clip, min = 1, probeTop } = {}) {
  const box = element.getBoundingClientRect(), outer = clip?.getBoundingClientRect()
  const left = Math.max(box.left, outer?.left ?? -Infinity, 0), right = Math.min(box.right, outer?.right ?? Infinity, innerWidth)
  const top = Math.max(box.top, outer?.top ?? -Infinity, 0), bottom = Math.min(box.bottom, outer?.bottom ?? Infinity, innerHeight)
  if (right - left < min || bottom - top < min) return false
  const y = probeTop === undefined ? (top + bottom) / 2 : top + Math.min(probeTop, (bottom - top) / 2)
  const hit = document.elementFromPoint((left + right) / 2, y)
  return Boolean(hit && element.contains(hit))
}
