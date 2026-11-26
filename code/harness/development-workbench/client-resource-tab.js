// The 研发工作台's right-sidebar tabs (代码变更 and PR 详情) are DSH resources: an address
// dsh-resource://<protocol>/session/<id>?…, a resource that only echoes the parsed address, and a tab type whose slot
// component renders it. This registers both the way DSH's side chat does.

/** @param {string} protocol */
export const resourcePrefix = protocol => `dsh-resource://${protocol}/`

/**
 * The Session and query of a `dsh-resource://<protocol>/session/<id>` address, else undefined.
 * @param {string} address @param {string} protocol
 * @returns {{ session: string, params: URLSearchParams } | undefined}
 */
export function parseResourceAddress(address, protocol) {
  let url
  try { url = new URL(address) } catch { return undefined }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== protocol) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  try { return { session: decodeURIComponent(parts[1]), params: url.searchParams } } catch { return undefined }
}

/** @param {AbortSignal} signal */
const settled = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }))

/**
 * Registers one tab type and its resource; returns their disposer (the slot is the scope's effect).
 * @param {any} ctx - a scope with resources, sidebarRightTabs and slots
 * @param {{ protocol: string, typeId: string, parse: (address: string) => any, title: () => string, component: any }} tab
 */
export function registerResourceTab(ctx, { protocol, typeId, parse, title, component }) {
  const disposers = [
    ctx.resources.register({
      protocol,
      async *open(address, { signal }) {
        const parsed = parse(address)
        if (!parsed) throw new Error(typeId + ': invalid address')
        yield { ok: true, value: parsed }
        await settled(signal)
      }
    }),
    ctx.sidebarRightTabs.register({
      id: typeId, kind: typeId, patterns: [`${resourcePrefix(protocol)}**`], priority: 'extension',
      canOpen: address => parse(address) !== undefined,
      title
    })
  ]
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: typeId }, component)))
  return () => { for (const dispose of disposers.reverse()) dispose?.() }
}
