import { bundlePlugins } from '../plugins.ts'
import { t } from './client-locale.js'
import { slotFace } from '../shared/dsh-internals.js'
import { customPluginMeta } from './custom-plugin-meta.js'

// Exact package allowlist, derived from the shipped plugin table rather than an @local/* prefix.
export const customPluginNames = new Set(bundlePlugins.map(plugin => `@local/dsh-${plugin.name}`))

/** DSH 0.2.2-rc.1: plugins.tab is public; the main registration's injected controller face is not.
 * Reuse that face so switches, busy/error state and reloads keep the native mutation semantics.
 * Remove this bridge when DSH exposes a bundle-list filter/controller to tab contributors.
 * @param {typeof import('react')} react
 */
export function customPluginsTab({ createElement: h, useSyncExternalStore }, { Switch }) {
  const selectors = [...customPluginNames].map(name => `[data-plugin-package="${name}"]`)
  // Only hide native list cards, never package details. No DOM moves or mutation of the native store.
  const css = selectors.map(selector => `[data-plugin-group="bundles"] ${selector}{display:none!important}`).join('')
    + `[data-plugin-group="bundles"]:not(:has([data-plugin-package]:not(${selectors.join(',')}))){display:none!important}`
    + '[data-fig-custom-plugin]{display:flex;align-items:center;gap:16px;padding:18px 0;min-width:0}'
    + '[data-fig-custom-plugin] button{font:inherit;color:inherit;text-align:left;cursor:pointer}'
    + '[data-fig-custom-plugin] button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:4px}'
    + '[data-fig-custom-plugin] p{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1.6;overflow-wrap:anywhere}'

  function CustomPlugins({ ctx, openPackage }) {
    const face = slotFace(ctx, 'main', entry => entry.options?.key === 'plugins')
    const store = face?.hooks?.pluginManager
    if (!store) return h('p', { role: 'alert' }, t('custom-plugins.customPluginsAreUnavailableReopen'))
    return h(CustomList, { ctx, face, store, openPackage })
  }
  function CustomList({ ctx, face, store, openPackage }) {
    const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
    const packages = state.packages.filter(pkg => customPluginNames.has(pkg.name))
    if (state.status === 'loading' || state.status === 'idle') return h('p', { role: 'status' }, t('custom-plugins.loadingCustomPlugins'))
    return h('div', { 'data-fig-custom-plugins': '' },
      h('p', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 14, margin: '0 0 12px' } }, t('custom-plugins.pluginsProvidedByFigView')),
      state.status === 'error' && h('div', { role: 'alert' }, t('custom-plugins.couldNotLoadPluginsTry'), h('button', { onClick: face.refresh }, t('custom-plugins.retry'))),
      !packages.length && state.status === 'ready' && h('p', null, t('custom-plugins.noCustomPlugins')),
      packages.map(pkg => {
        // Fig's shipped titles in DSH's package-text form ({ zh, en }), resolved like the manifest's own.
        const shipped = customPluginMeta[pkg.name]
        const fallback = field => shipped ? ctx.locale.resolveText({ zh: shipped.zh[field], en: shipped.en[field] }) : undefined
        const title = pkg.meta?.title ? ctx.locale.resolveText(pkg.meta.title) : fallback('title') ?? pkg.name
        const description = pkg.meta?.description ? ctx.locale.resolveText(pkg.meta.description) : fallback('description') ?? ''
        const busy = state.busy.includes(pkg.name)
        return h('div', { key: pkg.name, 'data-fig-custom-plugin': pkg.name },
          h('span', { 'aria-hidden': true, style: { width: 48, height: 48, flexShrink: 0, display: 'grid', placeItems: 'center', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: 14, color: 'var(--dsw-alias-label-secondary)' } },
            h('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
              h('path', { d: 'M9 3H4v6h2a3 3 0 0 1 0 6H4v5h5v-2a3 3 0 0 1 6 0v2h5v-5h-2a3 3 0 0 1 0-6h2V3h-5v2a3 3 0 0 1-6 0Z' }))),
          h('button', { type: 'button', onClick: () => openPackage(pkg.name), style: { flex: 1, minWidth: 0, border: 0, background: 'transparent', padding: 0 } },
            h('span', { style: { fontWeight: 500, fontSize: 16 } }, title),
            description && h('p', null, description),
            pkg.error && h('p', { role: 'alert' }, String(pkg.error))),
          h(Switch, { label: t('custom-plugins.enable') + title, checked: pkg.enabled, disabled: busy || !!pkg.readOnlyReason || (!pkg.enabled && !!pkg.error), onChange: enabled => face.setEnabled(pkg.name, enabled) }))
      }))
  }
  return { CustomPlugins, css }
}
