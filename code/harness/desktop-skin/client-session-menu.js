import { useStore as readStore } from '../shared/page-client.js'
import { openSessionId } from '../shared/dsh-internals.js'

// DSH (from 0.2.2-rc.5) gathers the session header's actions (copy as Markdown, download the Session log, open the folder in
// an application, feedback) into its public context-menu service under the `sessionHeader` target, with its own …
// button. Fig keeps one … menu in the top bar: these rows resolve the same contributions through
// `ctx.contextMenus.resolve` (documented for embedded menus) and DSH's button is hidden (app/main/workbench.css).
// Labels, availability and execution stay DSH's; only the presentation is Fig's.

export function sessionMenuComponent(react, primitives, ctx) {
  const { createElement: h, useEffect, useState } = react
  const { MenuItemButton } = primitives
  // Contributions name their glyph by key and DSH renders it through a keyed slot the menu owner holds; Fig draws the
  // same primitives for the keys it knows and none for others. An application's own icon comes as a URL.
  const glyphs = {
    'session-log-download.copy': primitives.IconCopyOutlineRegular,
    'session-log-download.download': primitives.IconDownloadOutlineRegular,
    'session-log-download.feedback': primitives.IconPaperPlaneOutlineRegular,
    'open-in-app.application': primitives.IconFolderOpenOutlineRegular
  }
  const empty = []
  const icon = view => {
    if (view.icon?.src) return h('img', { src: view.icon.src, width: 16, height: 16, alt: '' })
    const Glyph = view.icon && glyphs[view.icon.key]
    return Glyph ? h(Glyph, { size: 16 }) : undefined
  }

  return function SessionMenuRows({ onDismiss }) {
    const sessionId = openSessionId()
    const [resolution, setResolution] = useState(null)
    const [expanded, setExpanded] = useState(null)
    useEffect(() => {
      if (sessionId === undefined) return undefined
      const occurrence = ctx.contextMenus.resolve({ kind: 'sessionHeader', value: { sessionId } })
      setResolution(occurrence)
      return () => { occurrence.dispose(); setResolution(null) }
    }, [sessionId])
    const views = readStore(react, resolution?.source, empty)
    // Select before dismissing: closing the menu disposes the occurrence, and a selected action keeps running.
    const select = id => { resolution?.select(id); onDismiss?.() }
    const row = (view, separatorBefore) => view.children?.length
      ? h('div', { key: view.id, 'data-fig-session-submenu': '' },
        h(MenuItemButton, {
          icon: icon(view), disabled: view.disabled, separatorBefore,
          onSelect: () => setExpanded(open => open === view.id ? null : view.id)
        }, view.label + ' ›'),
        expanded === view.id && h('div', {
          role: 'menu', 'aria-label': view.label,
          onKeyDown: event => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            setExpanded(null)
            const trigger = event.currentTarget.parentElement?.querySelector('button')
            if (trigger instanceof HTMLElement) trigger.focus()
          }
        }, view.children.map(child => row(child, false))))
      : h(MenuItemButton, {
        key: view.id, icon: icon(view), disabled: view.disabled, danger: view.danger, separatorBefore,
        onSelect: () => select(view.id)
      }, view.label)
    return h(react.Fragment, null, views.map((view, index) => row(view, index === 0 || view.separatorBefore === true)))
  }
}
