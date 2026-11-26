import { sharedText } from './page-locale.js'
import { settingsActions } from './dsh-internals.js'

export function usageColor(percent) {
  return percent == null ? 'var(--dsw-alias-label-tertiary, #888)' : percent < 60 ? '#22a06b' : percent <= 90 ? '#d99a16' : '#e5484d'
}

/** Sent after a sign-in, sign-out or other account change, so the rings read again at once. */
export const subscriptionChanged = 'fig:subscription-changed'
export const announceSubscriptionChange = () => window.dispatchEvent(new Event(subscriptionChanged))

// Live reads start the provider's CLI; the rings take one at most every five minutes, or when the account changes.
const liveInterval = 5 * 60_000

export function usagePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined
}

// Both providers own their slot and data. Only this small renderer/layout is shared.
// DSH 0.2.2-rc.1 has no separate usage row: locally reflow the footer when a ring is present.
const subscriptionUsageCss = `
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage]){position:relative;display:grid!important;grid-template-columns:minmax(0,1fr);gap:4px 0}
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage])>[class*="_footerActions"]{display:contents!important}
[data-slot="sidebar.footer.action"]:has([data-fig-subscription-usage]){display:flex!important;flex-wrap:wrap;gap:4px;grid-column:1/-1;grid-row:1;align-items:center;padding:4px 0}
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage])>[class*="_settingsArea"]{grid-column:1;grid-row:2;min-width:0;box-sizing:border-box}
/* Anchor the out-of-flow gear to the account grid row, not the full footer.
   The skin sets height:auto with higher specificity; stretch deliberately. */
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage]) [data-fig-sidebar-settings]{position:absolute;grid-column:1;grid-row:2;right:0;top:0;bottom:0;height:auto!important;box-sizing:border-box}
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage])>[class*="_settingsArea"]{padding-right:36px}
[data-sidebar-collapsed] [class*="_footArea"]:has([data-fig-subscription-usage])>[class*="_settingsArea"]{padding-right:0}
[data-sidebar-collapsed] [data-slot="sidebar.footer.action"]:has([data-fig-subscription-usage]){flex-direction:column;flex-wrap:nowrap}
[data-sidebar-collapsed] [class*="_footArea"]:has([data-fig-subscription-usage])>[class*="_settingsArea"]{grid-column:1/-1}
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage]):hover{background:transparent!important}
/* Only the bottom account row shares hover; the usage row never participates. */
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage])>[class*="_settingsArea"]{border-radius:var(--dsw-radius-md)}
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage]):is(:has(>[class*="_settingsArea"]:hover),:has([data-fig-sidebar-settings]:hover))>[class*="_settingsArea"]{background:var(--dsw-alias-interactive-bg-hover)}
[data-slot="sidebar"] [class*="_footArea"]:has([data-fig-subscription-usage]) :is([data-fig-sidebar-settings],[data-slot="settings.launcher"] button[data-signed-out]):hover{background:transparent!important}
[data-fig-subscription-usage]{border:0;padding:0;background:transparent;cursor:pointer;font:inherit;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;flex:none;border-radius:50%;outline-offset:2px;color:var(--dsw-alias-label-secondary)}
[data-fig-subscription-usage]:hover,[data-fig-subscription-usage]:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
`

// One style element while any ring is mounted (each provider bundles its own copy of this module).
let style, users = 0
function installStyle() {
  if (users++ === 0) {
    style = document.createElement('style')
    style.textContent = subscriptionUsageCss
    document.head.append(style)
  }
  return () => { if (--users === 0) { style?.remove(); style = undefined } }
}

/**
 * One provider's ring. `read(account, live)` turns the account into {percent, description}; `live` asks for a fresh
 * read from the provider rather than the figures the account already carries.
 * @param {typeof import('react')} react
 * @param {any} createPortal
 * @param {{ id: string, glyph: string, section: string, name: () => string, call: (endpoint: string) => Promise<any>,
 *   read: (account: any, live: boolean) => Promise<{percent?: number, description?: string}> }} options
 */
export function subscriptionUsage(react, createPortal, options) {
  const { id, glyph, section, name, call, read } = options
  const { createElement: h, useEffect, useState, useRef } = react
  return function SubscriptionUsage({ ctx }) {
    const [value, setValue] = useState(/** @type {{percent?: number, description?: string} | null} */ (null))
    const [tip, setTip] = useState(/** @type {{left: number, bottom: number} | null} */ (null))
    const target = useRef(/** @type {HTMLButtonElement | null} */ (null))
    useEffect(() => {
      const removeStyle = installStyle()
      let disposed = false, busy = false, lastLive = 0
      async function update(force = false) {
        if (busy || document.hidden) return
        busy = true
        try {
          const account = await call('account')
          const live = account.signedIn && (force || Date.now() - lastLive >= liveInterval)
          if (live) lastLive = Date.now()
          const next = account.signedIn ? await read(account, live) : null
          if (!disposed) setValue(next)
        } catch { if (!disposed) setValue(null) }
        finally { busy = false }
      }
      const refresh = () => void update()
      const changed = () => void update(true)
      void update()
      const timer = setInterval(refresh, 60_000)
      window.addEventListener('focus', refresh)
      document.addEventListener('visibilitychange', refresh)
      window.addEventListener(subscriptionChanged, changed)
      return () => { removeStyle(); disposed = true; clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.removeEventListener(subscriptionChanged, changed) }
    }, [])
    if (!value) return null
    const percent = usagePercent(value.percent)
    const description = name() + '\n' + (value.description || sharedText('shared.usageUnavailable'))
    const show = () => { const box = target.current?.getBoundingClientRect(); if (box) setTip({ left: Math.max(8, Math.min(box.left, window.innerWidth - 288)), bottom: window.innerHeight - box.top + 8 }) }
    const open = () => {
      setTip(null)
      const actions = settingsActions(ctx)
      if (typeof actions?.openSection === 'function') actions.openSection(section)
      else console.warn('[fig-subscription] Account settings could not be opened')
    }
    return h(react.Fragment, null,
      h('button', { ref: target, type: 'button', 'aria-label': description, 'aria-haspopup': 'dialog', 'data-fig-subscription-usage': id, onClick: open,
        onMouseEnter: show, onMouseLeave: () => setTip(null), onFocus: show, onBlur: () => setTip(null), onKeyDown: event => { if (event.key === 'Escape') setTip(null) } },
        h('svg', { width: 32, height: 32, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': true },
          h('circle', { cx: 18, cy: 18, r: 14, stroke: 'var(--dsw-alias-border-l2, #8884)', strokeWidth: 3 }),
          percent != null && h('circle', { cx: 18, cy: 18, r: 14, pathLength: 100, stroke: usageColor(percent), strokeWidth: 3, strokeDasharray: `${percent} 100`, transform: 'rotate(-90 18 18)' }),
          h('text', { x: 18, y: 22, textAnchor: 'middle', fill: 'currentColor', fontSize: 11, fontFamily: 'system-ui', fontWeight: 600 }, glyph))),
      tip && createPortal(h('div', { role: 'tooltip', 'data-fig-usage-tooltip': id, style: { position: 'fixed', ...tip, zIndex: 10000, boxSizing: 'border-box', maxWidth: 'min(280px, calc(100vw - 16px))', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2, #262626)', color: 'var(--dsw-alias-label-primary)', font: '12px/1.6 system-ui', whiteSpace: 'pre-line', overflowWrap: 'anywhere', pointerEvents: 'none', boxShadow: '0 4px 16px #0002' } }, description), document.body))
  }
}
