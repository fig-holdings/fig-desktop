import { isZh, sharedText } from './page-locale.js'
import { pageRpc } from './page-rpc.js'

// Styles and pieces shared by Fig's settings sections in the DSH page. They draw on DSH tokens,
// so they follow its light and dark themes. Bundled into each client by electron.vite.config.ts.

export const colors = {
  primary: 'var(--dsw-alias-label-primary)', secondary: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l2)', layer: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))'
}
export const row = { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 0', borderBottom: '.5px solid ' + colors.border }
export const label = { color: colors.primary, fontSize: 14, lineHeight: '22px' }
export const note = { color: colors.secondary, fontSize: 13, lineHeight: '20px' }
/** Also used on links that look like buttons. */
export const button = {
  border: '.5px solid ' + colors.border, borderRadius: 8, background: 'transparent', color: colors.primary,
  font: 'inherit', fontSize: 13, padding: '6px 14px', cursor: 'pointer', whiteSpace: 'nowrap', textDecoration: 'none'
}

export function formatTime(iso) {
  return new Date(iso).toLocaleString(isZh() ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** pageRpc with the caller's texts for an unanswered call and a failure the Host gave no message for. */
export const pageCaller = (prefix, unavailable, failed) => pageRpc(prefix, { unavailable, failed })

/** @param {typeof import('react').createElement} h */
export function accountPieces(h) {
  const heading = title => h('h2', { style: { color: colors.primary, margin: '0 0 8px', fontSize: 18, fontWeight: 500, lineHeight: '26px' } }, title)
  /** @param {{title?: string, description?: string, children?: import("react").ReactNode}} props - a row may carry only a description */
  function Field({ title, description, children }) {
    return h('div', { style: row },
      h('div', { style: { flex: 1, minWidth: 0 } },
        title && h('div', { style: label }, title),
        description && h('div', { style: note }, description)),
      children)
  }
  /**
   * A subscription allowance: percent used, the reset time when known, a bar in the provider's accent
   * and a line on where the numbers came from.
   * @param {{usedPercent: number, resetsAt?: string, accent: string, margin: string, source: string}} props
   */
  function UsageCard({ usedPercent, resetsAt, accent, margin, source }) {
    const percent = Math.round(usedPercent * 10) / 10
    return h('div', { style: { border: '.5px solid ' + colors.border, borderRadius: 12, padding: 16, margin, background: colors.layer } },
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
        h('div', { style: { color: colors.primary } },
          h('span', { style: { fontSize: 22, fontWeight: 600 } }, percent + '%'),
          h('span', { style: { ...note, marginLeft: 6 } }, sharedText('shared.used'))),
        resetsAt && h('div', { style: note }, sharedText('shared.resetsAt', { time: formatTime(resetsAt) }))),
      h('div', { style: { height: 8, borderRadius: 4, background: colors.border, marginTop: 12, overflow: 'hidden' }, role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('div', { style: { width: Math.max(percent, 1) + '%', height: '100%', borderRadius: 4, background: accent } })),
      h('div', { style: { ...note, marginTop: 10 } }, source))
  }
  return { heading, Field, UsageCard }
}
