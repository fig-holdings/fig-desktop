import { t } from './client-locale.js'

// Window-scoped, not conversation-scoped: every main panel needs a way back from the rail.
// DSH 0.2.2-rc.1 has no public toggle command; forward to its existing sidebar control.
export function installRailToggle() {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('data-fig-rail-toggle', '')
  const update = () => {
    const label = t('rail-toggle.expandLeftSidebar')
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
  }
  const open = () => {
    const toggle = document.querySelector('[data-sidebar-collapsed] [data-slot="sidebar"] [data-window-drag] button[class*="_toggle"]')
    if (toggle instanceof HTMLButtonElement) toggle.click()
  }
  button.addEventListener('click', open)
  update()
  document.body.append(button)
  // The language lives on <html>, outside the body-rooted page observer: watch just that attribute.
  const locale = new MutationObserver(update)
  locale.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  return () => { locale.disconnect(); button.removeEventListener('click', open); button.remove() }
}
