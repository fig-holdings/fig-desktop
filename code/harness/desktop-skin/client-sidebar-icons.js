import { t } from './client-locale.js'
import { watchPage } from '../shared/page-observer.js'

// DSH 0.2.2-rc.1 adapter: preserve native buttons and handlers, replace only their visual icon.
export function installSidebarIcons() {
  const owned = new Map()
  const scan = () => {
    for (const button of owned.keys()) if (!button.isConnected) owned.delete(button)
    const buttons = document.querySelectorAll('[data-slot="sidebar"] [data-sidebar-toggle], [data-fig-rail-toggle], [data-sidebar-right-expand], [data-sidebar-right-toggle]')
    for (const button of buttons) {
      const left = button.matches('[data-sidebar-toggle], [data-fig-rail-toggle]')
      const expand = left ? button.matches('[data-fig-rail-toggle]') || !!button.closest('[data-sidebar-collapsed]') : button.hasAttribute('data-sidebar-right-expand')
      const label = left ? expand ? t('sidebar-icons.expandLeftSidebar') : t('sidebar-icons.collapseLeftSidebar')
        : expand ? t('sidebar-icons.expandRightSidebar') : t('sidebar-icons.collapseRightSidebar')
      if (!owned.has(button)) owned.set(button, { title: button.getAttribute('title'), aria: button.getAttribute('aria-label') })
      // Only on a real change: each write is a mutation the page's observers hear again.
      if (button.hasAttribute('title')) button.removeAttribute('title')
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
      const direction = left ? expand ? 'right' : 'left' : expand ? 'left' : 'right'
      const key = `${left ? 'left' : 'right'}-${direction}`
      let icon = button.querySelector('[data-fig-sidebar-icon]')
      if (icon?.getAttribute('data-fig-sidebar-icon') === key) continue
      icon?.remove()
      icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('data-fig-sidebar-icon', key)
      icon.setAttribute('width', '18'); icon.setAttribute('height', '18'); icon.setAttribute('viewBox', '0 0 24 24')
      icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.6')
      icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('aria-hidden', 'true')
      // Collapse arrows point toward the divider: offset them into the content pane so the strokes never touch.
      const arrow = expand ? direction === 'right' ? 'M12 9l3 3-3 3' : 'M12 9l-3 3 3 3'
        : left ? 'M16 9l-3 3 3 3' : 'M8 9l3 3-3 3'
      icon.innerHTML = `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M${left ? 9 : 15} 4v16"/><path d="${arrow}"/>`
      button.append(icon)
    }
  }
  const stop = watchPage({ name: 'sidebar icons', childList: true, ignore: '[data-conversation-content],[data-fig-sidebar-icon]',
    attributes: ['data-sidebar-collapsed', 'data-sidebar-right-expand', 'data-sidebar-right-collapse', 'lang'], run: scan })
  scan()
  return () => {
    stop()
    for (const [button, original] of owned) {
      button.querySelector('[data-fig-sidebar-icon]')?.remove()
      for (const [name, value] of [['title', original.title], ['aria-label', original.aria]]) {
        if (value === null) button.removeAttribute(name); else button.setAttribute(name, value)
      }
    }
  }
}
