// Fig offers Chinese and English only (the main process, the startup page and Fig's own page text follow DSH's
// language in those two). DSH 0.2.2 registers six more languages with no switch to leave them out, and its
// Language row renders choices as plain menu items labelled by language name. This local DOM adaptation hides
// those six in any open menu that also lists 中文 and English, which only the Language row's menu does.
// Removal condition: DSH lets a deployment choose its languages. Covered by tests/language-smoke.mjs.

import { watchPage } from '../shared/page-observer.js'

/** The locales Fig offers. */
export const figLocales = ['zh', 'en']

/** Hides the other languages' rows while their menu is open. */
export function limitLanguageMenu(ctx) {
  if (!ctx.locale) return () => {}
  const labels = () => {
    const locales = ctx.locale.getSnapshot().locales
    return {
      kept: locales.filter(item => figLocales.includes(item.id)).map(item => item.label),
      hidden: new Set(locales.filter(item => !figLocales.includes(item.id)).map(item => item.label))
    }
  }
  const limit = () => {
    const { kept, hidden } = labels()
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const items = [...menu.querySelectorAll('[role="menuitem"]')]
      const names = items.map(item => item.textContent.trim())
      if (!kept.every(label => names.includes(label))) continue
      for (const item of items) if (hidden.has(item.textContent.trim())) /** @type {HTMLElement} */ (item.parentElement ?? item).hidden = true
    }
  }
  // Before paint, so the hidden rows never show; menus may open anywhere, conversations included.
  return watchPage({ name: 'language menu', timing: 'sync', childList: true, within: '[role="menu"]', ignore: null, run: limit })
}
