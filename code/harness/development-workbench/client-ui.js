import { t } from './client-locale.js'
import { colors, dialogShell, floatingMenu, muted } from './client-theme.js'

// Small parts the 研发工作台's card, dialogs and PR 详情 share: menus that close on a press outside or Escape, the
// dialog frame, whether a Session runs, and the row pieces (icon, counts, fold toggles).

/** "2m 18s" for a running job's elapsed time. @param {number} ms */
export function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "~/Documents/Workspace/projects" → "~/Documen…projects" when long. @param {string} value */
export const middle = (value, max = 24) => value.length <= max ? value : value.slice(0, Math.ceil(max / 2) - 1) + '…' + value.slice(-Math.floor(max / 2))

/** @param {any} wb - the workbench's shared parts (client-workbench.js) */
export function uiKit(wb) {
  const { h, Icon } = wb
  const { useCallback, useEffect, useSyncExternalStore } = wb.react

  /** A row's leading icon. @param {string} name @param {string} [color] */
  const lead = (name, color) => h(Icon, { key: 'icon', name, color: color ?? colors.secondary })

  /**
   * While `open`, a press outside `holder` or Escape calls `close` (Escape stops there, so it does not also close what
   * holds the menu). @param {boolean} open @param {() => void} close @param {{ current: HTMLElement | null }} holder
   */
  function useDismiss(open, close, holder) {
    useEffect(() => {
      if (!open) return
      const down = event => { if (!holder.current?.contains(/** @type {Node} */ (event.target))) close() }
      const key = event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
      document.addEventListener('mousedown', down, true)
      document.addEventListener('keydown', key, true)
      return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true) }
    }, [open])
  }

  /**
   * A floating menu: rows with an icon and a label each (a separator where an item says so), or the caller's own
   * `children`. Picking a row closes the menu.
   * @param {{ attributes?: Record<string, any>, style?: any, close?: () => void, children?: any,
   *   items?: ({ key: string, separator: true } | { key: string, icon: string, label: string, disabled?: boolean | string, title?: string, attributes?: Record<string, any>, run: () => void })[] }} props
   */
  function MenuList({ attributes, style, close = () => {}, items, children }) {
    return h('div', { role: 'menu', ...attributes, style: { ...floatingMenu, ...style } },
      ...(items ?? []).map(item => 'separator' in item ? h('div', { key: item.key, style: { height: 0, borderTop: '.5px solid ' + colors.border, margin: '3px 6px' } })
        : h('button', { key: item.key, type: 'button', role: 'menuitem', className: 'fig-wb-row', disabled: Boolean(item.disabled), title: item.title, ...item.attributes,
          style: { margin: 0, width: '100%', fontSize: 13, ...(item.disabled ? { opacity: .5, cursor: 'default' } : {}) },
          onClick: () => { close(); if (!item.disabled) item.run() } }, lead(item.icon), h('span', null, item.label))), children)
  }

  /**
   * A modal dialog: a dimmed backdrop that closes it on a press or Escape (not while `busy`), and a panel with a title.
   * @param {{ attributes: Record<string, any>, title: string, width: number, maxHeight?: string, busy: boolean, close: () => void, children?: any }} props
   */
  function DialogShell({ attributes, title, width, maxHeight, busy, close, children }) {
    return h('div', { ...attributes, role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
      onMouseDown: event => { if (event.target === event.currentTarget && !busy) close() },
      onKeyDown: event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); close() } },
      style: dialogShell.backdrop },
    h('div', { style: { width: `min(${width}px, calc(100vw - 32px))`, ...(maxHeight ? { maxHeight } : {}), ...dialogShell.panel } },
      h('div', { style: { fontSize: 15, fontWeight: 600 } }, title), ...(Array.isArray(children) ? children : [children])))
  }

  /** Whether the Session's turn is running, from DSH's session list. @param {string} sessionId */
  const useSessionRunning = sessionId => useSyncExternalStore(
    useCallback(listener => wb.ctx()?.sessions?.list?.subscribe(listener) ?? (() => {}), []),
    () => Boolean(wb.ctx()?.sessions?.list?.getSnapshot().byId[sessionId]?.running))

  /** Files, added and deleted lines. `atLeast`: some new files' lines were not counted, so the added total is a lower bound ("+120+"). */
  const Counts = ({ value, atLeast = false }) => value.files === 0
    ? h('span', { style: muted }, t('ui.noChanges'))
    : h('span', { style: { display: 'flex', gap: 6, fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
      h('span', { style: { color: colors.secondary } }, t(value.files === 1 ? 'ui.files.one' : 'ui.files.other', { files: value.files })),
      h('span', { style: { color: colors.added }, ...(atLeast ? { 'data-fig-workbench-partial-count': '' } : {}) }, '+' + value.added + (atLeast ? '+' : '')),
      h('span', { style: { color: colors.deleted } }, '−' + value.deleted))

  /** A chevron that turns when open. @param {boolean} open @param {string} [color] */
  const chevron = (open, color) => h(Icon, { name: 'chevron', size: 12, color, style: { transform: open ? 'rotate(90deg)' : 'none' } })

  /** A section's fold toggle: "label · count". @param {{ name: string, open: boolean, onToggle: () => void, label: string, count: number }} props */
  const Fold = ({ name, open, onToggle, label, count }) => h('button', { type: 'button', className: 'fig-wb-link', 'aria-expanded': open, [`data-fig-workbench-${name}`]: '',
    style: { alignSelf: 'flex-start', padding: '2px 0', display: 'inline-flex', alignItems: 'center', gap: 4 }, onClick: onToggle },
  chevron(open), `${label} · ${count}`)

  return { lead, useDismiss, MenuList, DialogShell, useSessionRunning, Counts, chevron, Fold }
}
