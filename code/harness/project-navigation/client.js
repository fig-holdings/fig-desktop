import { useStore } from '../shared/page-client.js'
import { install, t } from './client-locale.js'
import { pageRpc } from '../shared/page-rpc.js'
import { watchPage } from '../shared/page-observer.js'
import { colors, icons, projectFor, sessionState, recentSessions } from './model.js'
import { css } from './style.js'

// Compatibility adapter for DSH 0.2.2-rc.1 only: data-row-key + first cell and
// rail/search module-class fragments. Never replace the official browser or its actions.
const rpc = pageRpc('/fig-project-navigation')
async function call(endpoint, payload = {}) {
  try { return await rpc(endpoint, payload) } catch { throw new Error(t('main.couldNotLoadOrSave')) }
}
const defaultAppearance = { icon: 'folder', color: 'neutral' }
const color = key => { const pair = colors[key] ?? colors.neutral; return `light-dark(${pair[0]},${pair[1]})` }
const colorLabel = key => t(/** @type {`main.color.${keyof typeof colors}`} */ (`main.color.${key}`))
const labelState = state => state === 'running' ? t('main.running') : state === 'waiting' ? t('main.waitingForInput') : t('main.notRunning')
const untitled = () => t('main.untitledSession')
const message = error => error instanceof Error ? error.message : String(error)
const focusLater = element => requestAnimationFrame(() => element instanceof HTMLElement && element.focus())

/**
 * Finds the sidebar rows (project and session) and the collapsed rail beside the search button, and gives each a host
 * element of ours to render into. Rescans on sidebar changes that are not our own.
 */
function useSidebarHosts(useState, useEffect) {
  const [targets, setTargets] = useState(/** @type {{id:string,kind:string,cell:HTMLElement,host:Element}[]} */ ([]))
  const [rail, setRail] = useState(/** @type {Element | null} */ (null))
  useEffect(() => {
    const owned = new Set(), marked = new Set()
    let frame = 0
    function scan() {
      frame = 0
      const next = []
      for (const row of document.querySelectorAll('[data-slot="sidebar.workspaces"] [data-row-key]')) {
        const key = row.getAttribute('data-row-key') ?? '', cell = row.firstElementChild
        const kind = key.startsWith('workspace:') ? 'project' : key.startsWith('session:') ? 'session' : null
        if (!(cell instanceof HTMLElement) || !kind) continue
        let host = [...cell.children].find(element => element.hasAttribute('data-fig-nav-host'))
        if (!host) { host = document.createElement('span'); host.setAttribute('data-fig-nav-host', ''); cell.append(host); owned.add(host) }
        marked.add(cell)
        next.push({ id: key.slice(key.indexOf(':') + 1), kind, cell, host })
      }
      const active = new Set(next.map(item => item.cell))
      for (const cell of marked) if (!active.has(cell)) { cell.removeAttribute('data-fig-project-cell'); cell.removeAttribute('data-fig-project-icon'); marked.delete(cell) }
      for (const host of owned) if (!host.isConnected) owned.delete(host)
      const root = document.querySelector('[data-slot="sidebar.workspaces"] [class*="_root"][class*="_rail"]')
      const search = root?.querySelector(':scope > [class*="_search"]')
      let railHost = root?.querySelector(':scope > [data-fig-nav-rail-host]') ?? null
      if (search && !railHost) { railHost = document.createElement('div'); railHost.setAttribute('data-fig-nav-rail-host', ''); search.after(railHost); owned.add(railHost) }
      setRail(previous => previous === railHost ? previous : railHost)
      setTargets(previous => previous.length === next.length && previous.every((item, i) => item.host === next[i].host && item.id === next[i].id) ? previous : next)
    }
    const ours = record => record.target instanceof Element && record.target.closest('[data-fig-nav-host],[data-fig-nav-rail-host],.fig-nav-overlay,.fig-nav-popover')
    const observer = new MutationObserver(records => {
      if (records.every(ours)) return
      if (!frame) frame = requestAnimationFrame(scan)
    })
    observer.observe(document.querySelector('[data-slot="sidebar"]') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    scan()
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame)
      for (const cell of marked) { cell.removeAttribute('data-fig-project-cell'); cell.removeAttribute('data-fig-project-icon') }
      for (const node of owned) node.remove()
    }
  }, [])
  return { targets, rail }
}

/** Tab cycles inside `container`; Escape closes it. */
function trapFocus(event, container, close) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab') return
  const buttons = [...container.querySelectorAll('button:not(:disabled)')]
  if (!buttons.length) return
  if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus() }
  else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus() }
}

window.__ModuleLoader__.load({
  id: '@local/dsh-project-navigation',
  factory(require) {
    const react = require('react')
    const { createPortal } = require('react-dom')
    const { createElement: h, useEffect, useState, useRef } = react
    const useSource = source => useStore(react, source, undefined)
    const Icon = ({ name }) => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: icons[name] ?? icons.folder }))
    const Dot = ({ state }) => h('span', { className: 'fig-nav-dot', 'data-state': state, 'aria-hidden': true })

    /** The project's icon on its row; a session row's project-colored status dot. */
    function RowMarks({ targets, appearances, view }) {
      return targets.map(target => {
        if (target.kind === 'project') {
          const appearance = appearances[target.id]
          return appearance ? createPortal(h('span', { style: { color: color(appearance.color) } }, h(Icon, { name: appearance.icon })), target.host, target.id) : null
        }
        const session = view.visible(target.id)
        if (!session) return null
        const state = view.state(session)
        return createPortal(h('span', { style: { display: 'flex', padding: 4, '--fig-project-color': view.projectColor(session) }, ...view.tipEvents(`${view.projectName(session)} · ${labelState(state)}`) },
          h(Dot, { state })), target.host, target.id)
      })
    }

    /** A recent session as a rail button or, inside the more menu, a menu item with its title and project. */
    function RecentButton({ session, view, inMenu = false, open }) {
      const state = view.state(session)
      return h('button', {
        type: 'button', role: inMenu ? 'menuitem' : undefined, className: inMenu ? undefined : 'fig-nav-button', 'data-fig-recent-session': session.id,
        'aria-label': view.describe(session), 'aria-current': (session.retainedBy?.mainView ?? 0) > 0 ? 'true' : undefined,
        style: { '--fig-project-color': view.projectColor(session) }, ...(!inMenu ? view.tipEvents(view.describe(session)) : {}), onClick: () => open(session)
      }, h(Dot, { state }), inMenu && h('span', { className: 'fig-nav-menu-label' },
        h('span', null, session.title || untitled()), h('small', null, `${view.projectName(session)} · ${labelState(state)}`)))
    }

    function RecentMenu({ position, sessions, view, open, menuRef, close }) {
      function keyDown(event) {
        if (event.key === 'Escape') { close(true); return }
        if (event.key === 'Tab') { close(false); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = [...(menuRef.current?.querySelectorAll('button') ?? [])], i = buttons.findIndex(button => button === document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
      return createPortal(h('div', { ref: menuRef, role: 'menu', 'aria-label': t('main.moreRecentSessions'), className: 'fig-nav-popover fig-nav-menu', style: position, onKeyDown: keyDown },
        sessions.map(session => h(RecentButton, { key: session.id, session, view, inMenu: true, open }))), document.body)
    }

    function AppearanceDialog({ editor, draft, setDraft, busy, error, loadError, save, close, dialog }) {
      return createPortal(h('div', { className: 'fig-nav-overlay', onMouseDown: event => { if (event.target === event.currentTarget) close() } },
        h('section', { ref: dialog, role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'fig-nav-title', className: 'fig-nav-popover fig-nav-dialog', onKeyDown: event => trapFocus(event, dialog.current, close) },
          h('h2', { id: 'fig-nav-title' }, t('main.iconAndColor')),
          h('p', null, editor.displayTitle),
          h('div', { className: 'fig-nav-colors', 'aria-label': t('main.color') }, Object.keys(colors).map(key =>
            h('button', { key, type: 'button', 'aria-label': colorLabel(key), 'aria-pressed': draft.color === key, style: { '--fig-project-color': color(key) }, onClick: () => setDraft({ ...draft, color: key }) }))),
          h('div', { className: 'fig-nav-icons', style: { '--fig-project-color': color(draft.color) }, 'aria-label': t('main.icon') }, Object.keys(icons).map(key =>
            h('button', { key, type: 'button', 'aria-label': key, 'aria-pressed': draft.icon === key, onClick: () => setDraft({ ...draft, icon: key }) }, h(Icon, { name: key })))),
          error && h('p', { role: 'alert' }, error),
          h('div', { className: 'fig-nav-actions' },
            h('button', { type: 'button', disabled: busy, onClick: () => save(true) }, t('main.reset')),
            h('button', { type: 'button', disabled: busy, onClick: close }, t('main.cancel')),
            h('button', { type: 'button', disabled: busy || !!(loadError && error), onClick: () => save(false) }, busy ? t('main.saving') : t('main.save'))))),
      document.body)
    }

    /** DSH 0.2.2-rc.1 exposes no title-prefix slot; keep this adapter local and removable. */
    function HeaderProject({ workspaces, appearances }) {
      const [hosts, setHosts] = useState(/** @type {{id:string,host:HTMLElement}[]} */ ([]))
      useEffect(() => {
        const owned = new Set()
        const scan = () => {
          const next = []
          for (const conversation of document.querySelectorAll('[data-slot="main.conversation"] [data-conversation-session]')) {
            const id = conversation.getAttribute('data-conversation-session')
            const header = conversation.querySelector('[data-slot="conversation.session.header"]')
              ?? conversation.closest('[data-slot="main.conversation"]')?.querySelector('[data-slot="conversation.session.header"]')
            const nav = header?.querySelector('nav')
            if (!id || !nav) continue
            let host = nav.querySelector(':scope > [data-fig-header-project]')
            if (!(host instanceof HTMLElement)) {
              host = document.createElement('span'); host.setAttribute('data-fig-header-project', '')
              nav.prepend(host); owned.add(host)
            }
            next.push({ id, host })
          }
          setHosts(previous => previous.length === next.length && previous.every((item, i) => item.id === next[i].id && item.host === next[i].host) ? previous : next)
        }
        // The header sits outside the conversation's content, so streaming replies do not wake this.
        const stop = watchPage({ name: 'header project', childList: true, attributes: ['data-conversation-session'],
          ignore: '[data-conversation-content],[data-fig-header-project]', run: scan })
        scan()
        return () => { stop(); for (const host of owned) host.remove() }
      }, [])
      return hosts.map(({ id, host }) => {
        const project = projectFor(id, workspaces)
        if (!project) return null
        const appearance = appearances[project.workspaceId] ?? defaultAppearance
        return createPortal(h('span', { className: 'fig-header-project', title: project.title },
          h('span', { style: { color: color(appearance.color), display: 'inline-flex', flexShrink: 0 } }, h(Icon, { name: appearance.icon })),
          h('span', { className: 'fig-header-project-name' }, project.title),
          h('span', { className: 'fig-header-project-separator', 'aria-hidden': true }, '/')), host, id)
      })
    }

    /** The saved project looks; a failed first read is retried when the editor opens. */
    function useAppearances() {
      const [appearances, setAppearances] = useState({}), [loadError, setLoadError] = useState(false)
      useEffect(() => {
        let live = true
        call('list').then(value => { if (live) setAppearances(value) }).catch(() => { if (live) setLoadError(true) })
        return () => { live = false }
      }, [])
      return { appearances, setAppearances, loadError, setLoadError, appearance: id => appearances[id] ?? defaultAppearance }
    }

    /** The 图标与颜色 dialog's state: opened from the workspace context menu, saved through the Host. */
    function useEditor(subscribeEditor, { appearances, setAppearances, loadError, setLoadError, appearance }) {
      const [editor, setEditor] = useState(/** @type {{workspaceId:string,displayTitle:string} | null} */ (null)), [draft, setDraft] = useState(defaultAppearance)
      const [busy, setBusy] = useState(false), [error, setError] = useState('')
      const dialog = useRef(/** @type {HTMLElement | null} */ (null)), focusReturn = useRef(/** @type {Element | null} */ (null))
      useEffect(() => subscribeEditor(async target => {
        focusReturn.current = document.activeElement
        setError(''); setEditor(target); setDraft(appearance(target.workspaceId))
        if (!loadError) return
        try {
          const value = await call('list')
          setAppearances(value); setDraft(value[target.workspaceId] ?? defaultAppearance); setLoadError(false)
        } catch (e) { setError(message(e)) }
      }), [appearances, loadError])
      useEffect(() => { if (editor) dialog.current?.querySelector('button')?.focus() }, [editor])
      function close() { if (busy) return; setEditor(null); focusLater(focusReturn.current) }
      async function save(reset) {
        if (!editor) return
        setBusy(true); setError('')
        try {
          setAppearances(await call('set', { workspaceId: editor.workspaceId, appearance: reset ? null : draft }))
          setEditor(null); focusLater(focusReturn.current)
        } catch (e) { setError(message(e)) } finally { setBusy(false) }
      }
      return editor && { editor, draft, setDraft, busy, error, loadError, save, close, dialog }
    }

    /** The rail's 「···」 menu of more recent sessions: closes on a click outside or a resize. */
    function useRecentMenu(setTip) {
      const [menu, setMenu] = useState(/** @type {{left:number,top:number} | null} */ (null))
      const menuRef = useRef(/** @type {HTMLElement | null} */ (null)), moreRef = useRef(/** @type {HTMLButtonElement | null} */ (null))
      useEffect(() => {
        if (!menu) return
        menuRef.current?.querySelector('button')?.focus()
        const outside = event => { if (!menuRef.current?.contains(event.target) && !moreRef.current?.contains(event.target)) setMenu(null) }
        const resize = () => { setMenu(null); setTip(null) }
        document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize)
        return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize) }
      }, [menu])
      function toggle(event) {
        const rect = event.currentTarget.getBoundingClientRect()
        setTip(null)
        setMenu(menu ? null : { left: rect.right + 8, top: Math.max(8, Math.min(rect.top, innerHeight - 330)) })
      }
      return { menu, setMenu, menuRef, moreRef, toggle }
    }

    /** What the row marks, rail and menu need to know about one session. */
    function sessionView({ list, workspaces, statuses, appearance, setTip }) {
      function showTip(event, value) {
        const rect = event.currentTarget.getBoundingClientRect()
        setTip({ value, left: Math.min(rect.right + 10, Math.max(8, innerWidth - 308)), top: Math.max(8, Math.min(rect.top, innerHeight - 100)) })
      }
      const view = {
        visible: id => { const session = list.byId[id]; return session && !session.blank && !workspaces.archivedSessionIds.includes(id) ? session : undefined },
        state: session => sessionState(session, statuses, list),
        projectName: session => projectFor(session.id, workspaces)?.title || t('main.ungrouped'),
        projectColor: session => color(appearance(projectFor(session.id, workspaces)?.workspaceId).color),
        describe: session => `${session.title || untitled()}\n${view.projectName(session)} · ${labelState(view.state(session))}`,
        tipEvents: value => ({ onMouseEnter: event => showTip(event, value), onMouseLeave: () => setTip(null), onFocus: event => showTip(event, value), onBlur: () => setTip(null), onKeyDown: event => { if (event.key === 'Escape') setTip(null) } })
      }
      return view
    }

    /** Row cells: an icon replaces DSH's folder glyph; a session dot replaces the row's leading glyph unless DSH shows state there. */
    function useRowCells(targets, appearances, view, { list, workspaces, statuses }) {
      useEffect(() => {
        for (const target of targets) {
          if (target.kind === 'project') { target.cell.toggleAttribute('data-fig-project-icon', !!appearances[target.id]); continue }
          const session = view.visible(target.id)
          if (!session) { target.cell.removeAttribute('data-fig-project-cell'); continue }
          const status = statuses.get(session.id)
          const nativeMark = !session.running && [...target.cell.children].some(child => !child.hasAttribute('data-fig-nav-host') && (child.querySelector('svg') || child.textContent?.trim()))
          target.cell.setAttribute('data-fig-project-cell', status?.pendingInteraction || status?.completionUnread || nativeMark ? 'preserve' : 'replace')
        }
      }, [targets, appearances, list, workspaces, statuses])
    }

    function Controller({ ctx, subscribeEditor }) {
      const list = useSource(ctx.sessions.list), workspaces = useSource(ctx.workspaces.list), statuses = useSource(ctx.uiSession.sessionStatus)
      const { targets, rail } = useSidebarHosts(useState, useEffect)
      const looks = useAppearances(), { appearances } = looks
      const editing = useEditor(subscribeEditor, looks)
      const [tip, setTip] = useState(/** @type {{value:string,left:number,top:number} | null} */ (null))
      const { menu, setMenu, menuRef, moreRef, toggle: toggleMenu } = useRecentMenu(setTip)
      const view = sessionView({ list, workspaces, statuses, appearance: looks.appearance, setTip })
      const recent = recentSessions(list, workspaces)
      useEffect(() => { setTip(null); if (!rail) setMenu(null) }, [rail])
      useRowCells(targets, appearances, view, { list, workspaces, statuses })

      function open(session) {
        setMenu(null); setTip(null)
        Promise.resolve().then(() => ctx.uiWorkspace.openSession(session.id))
          .catch(() => setTip({ value: t('main.couldNotOpenSessionTry'), left: 64, top: 100 }))
      }

      return h(react.Fragment, null, h('style', null, css),
        h(RowMarks, { targets, appearances, view }),
        h(HeaderProject, { workspaces, appearances }),
        h('style', null, '[data-fig-header-project]{display:contents}.fig-header-project{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:180px;flex-shrink:1;font-size:13px;font-weight:500}.fig-header-project-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fig-header-project-separator{color:var(--dsw-alias-label-caption);margin-inline:2px;flex-shrink:0}'),
        rail && createPortal(h('nav', { className: 'fig-nav-rail', 'aria-label': t('main.recentSessions') },
          recent.length > 0 && h('hr', { className: 'fig-nav-divider' }),
          recent.slice(0, 5).map(session => h(RecentButton, { key: session.id, session, view, open })),
          recent.length > 5 && h('button', { ref: moreRef, type: 'button', className: 'fig-nav-button', 'data-fig-recent-more': '', 'aria-label': t('main.moreRecentSessions'),
            'aria-haspopup': 'menu', 'aria-expanded': !!menu, onClick: toggleMenu }, '···')), rail),
        tip && createPortal(h('div', { role: 'tooltip', className: 'fig-nav-popover fig-nav-tooltip', style: { left: tip.left, top: tip.top } }, tip.value), document.body),
        menu && h(RecentMenu, { position: menu, sessions: recent.slice(5, 10), view, open, menuRef, close: refocus => { setMenu(null); if (refocus) moreRef.current?.focus() } }),
        editing && h(AppearanceDialog, editing))
    }

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'contextMenus', 'locale'],
      apply(ctx) {
        install(ctx)
        const listeners = new Set()
        const appearanceIcon = { key: 'fig-project-navigation.appearance' }
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: appearanceIcon.key }, () => h(Icon, { name: 'palette' })))
        ctx.effect(() => ctx.contextMenus.register({ id: 'fig-project-appearance', target: 'workspace', order: 90,
          resolve: target => [{ id: 'appearance', label: t('main.iconAndColorMenu'), icon: appearanceIcon, run: () => listeners.forEach(listener => listener(target)) }] }))
        const subscribeEditor = listener => { listeners.add(listener); return () => listeners.delete(listener) }
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'fig-project-navigation', order: 150 }, () => h(Controller, { ctx, subscribeEditor })))
      }
    }
  }
})
