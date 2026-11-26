import { t } from './client-locale.js'
import { overlapOf, packageOf } from './plugin-overlaps.js'
import { pageRpc } from '../shared/page-rpc.js'
import { watchPage } from '../shared/page-observer.js'

const call = pageRpc('/fig-skin')

// Threshold ③ e: remind, never block, when a plugin duplicates a Fig feature (plugin-overlaps.js). DSH 0.2.2
// has no slot on its Plugins page, so this is a local DOM adaptation in two places:
// - the 添加插件 dialog: a line under the package field while the name typed is a listed one;
// - the Plugins page: a banner under its header listing installed duplicates, however they were installed.
// Removal condition: DSH offers an extension point on the Plugins page. Covered by tests/plugin-overlap-smoke.mjs.

// A card on the page (§4.3: no third background): the card face and the l2 line, amber kept to the leading edge.
const notice = 'margin:8px 0 0;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.6;'
  + 'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);'
  + 'border-left:3px solid #f5a524;color:var(--dsw-alias-label-primary)'

/** The reminder for one package. @param {string} name @param {import('./plugin-overlaps.js').Overlap} overlap */
function overlapText(name, overlap) {
  const feature = t(`plugin-overlaps.feature.${overlap.feature}`)
  return t(overlap.partial ? 'plugin-overlaps.partOfItBuiltIn' : 'plugin-overlaps.builtIn', { name, feature })
}

/** Watches the page for the 添加插件 dialog and the Plugins page. */
export function remindOverlaps(ctx) {
  // The hint and banner are plain DOM outside DSH's slots, so each keeps a way to write its text again on a language switch.
  /** @type {Set<{element: HTMLElement, render: () => void}>} */
  const texts = new Set()
  function watchDialog() {
    for (const input of document.querySelectorAll('[role="dialog"] input')) {
      const field = /** @type {HTMLInputElement} */ (input)
      if (field.dataset.figOverlapWatched) continue
      const dialog = field.closest('[role="dialog"]')
      if (!dialog || !/添加插件|Add plugin/i.test(dialog.textContent ?? '')) continue
      field.dataset.figOverlapWatched = '1'
      const hint = document.createElement('div')
      hint.dataset.figOverlapHint = ''
      hint.setAttribute('role', 'note')
      hint.style.cssText = notice
      hint.hidden = true
      ;(field.parentElement ?? field).after(hint)
      const update = () => {
        const overlap = overlapOf(field.value)
        hint.hidden = !overlap
        if (overlap) hint.textContent = overlapText(packageOf(field.value), overlap)
      }
      field.addEventListener('input', update)
      texts.add({element: hint, render: update})
      update()
    }
  }

  function watchPluginsPage() {
    const add = [...document.querySelectorAll('button')].find(button => !button.closest('[role="dialog"]')
      && /^(添加插件|Add plugin)/i.test((button.textContent ?? '').replace(/^\+\s*/, '').trim()))
    if (!add) return
    let header = /** @type {HTMLElement} */ (add)
    while (header.parentElement && !header.querySelector('h1, h2')) header = header.parentElement
    if (!header.parentElement || header.nextElementSibling?.hasAttribute('data-fig-overlap-banner')) return
    const banner = document.createElement('div')
    banner.dataset.figOverlapBanner = ''
    banner.setAttribute('role', 'note')
    banner.hidden = true
    banner.style.cssText = notice + ';margin:12px 0'
    header.after(banner)
    call('plugins/overlaps', {}).then(value => {
      const plugins = value?.plugins ?? []
      if (!plugins.length) return
      const render = () => {
        const items = plugins.map(plugin => t('plugin-overlaps.item', { name: plugin.name, feature: t(`plugin-overlaps.feature.${/** @type {import('./plugin-overlaps.js').Feature} */ (plugin.feature)}`),
          partly: plugin.partial ? t('plugin-overlaps.partly') : '' }))
        banner.textContent = t('plugin-overlaps.theseInstalledPluginsDuplicateFeatures', { plugins: items.join(t('shared.listSeparator')) })
      }
      render()
      texts.add({element: banner, render})
      banner.hidden = false
    }, () => {})
  }

  const scan = () => { watchDialog(); watchPluginsPage() }
  const stop = watchPage({ name: 'plugin overlaps', childList: true, run: scan })
  scan()
  const offLocale = ctx.locale.subscribe(() => {
    for (const text of texts) {
      if (text.element.isConnected) text.render()
      else texts.delete(text)
    }
  })
  return () => {
    stop()
    offLocale()
    texts.clear()
    for (const element of document.querySelectorAll('[data-fig-overlap-hint], [data-fig-overlap-banner]')) element.remove()
  }
}
