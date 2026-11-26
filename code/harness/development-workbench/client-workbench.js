import { t } from './client-locale.js'
import { pageRpc } from '../shared/page-rpc.js'
import { diffTab } from './client-diff.js'
import { iconFactory } from './client-icons.js'
import { card } from './client-card.js'
import { dialogs } from './client-dialogs.js'
import { pullDetail } from './client-pull-detail.js'
import { pullsKit } from './client-pulls.js'
import { workbenchStore, writePreference } from './client-store.js'
import { CARD_WIDTH, dockedAttribute, GAP, retainStyle } from './client-theme.js'
import { uiKit } from './client-ui.js'

export { CARD_WIDTH, GAP }
export { elapsed } from './client-ui.js'

// 研发工作台: a rounded card beside the conversation showing the repository, its changes and this Session's background
// tasks. A header button (in conversation.session.header.utilities) opens and closes it. When the conversation column
// leaves the chat at least 640px beside the card, the card docks between the chat and the right sidebar; otherwise it
// hides and the button opens it as a temporary popover.
// The parts live in client-card (the card), client-pulls (合并请求), client-pull-detail (PR 详情), client-dialogs,
// client-diff (代码变更), client-store (page state) and client-ui / client-theme (shared pieces); each module's factory
// takes `wb`, the parts built here.

/** The chat keeps at least this width beside a docked card. */
export const MIN_CHAT = 640
/** Column width from which the card docks. */
export const DOCK_FROM = MIN_CHAT + CARD_WIDTH + GAP * 2

/**
 * How the card shows: docked beside the chat, as a popover under the button, or not at all.
 * @param {{ open: boolean, wide: boolean, popover: boolean }} state
 * @returns {'docked' | 'popover' | 'hidden'}
 */
export function placement({ open, wide, popover }) {
  if (open && wide) return 'docked'
  return popover ? 'popover' : 'hidden'
}

/**
 * A button press. Wide: it switches the remembered preference (docked ↔ closed). Narrow: it toggles a temporary
 * popover and leaves the preference alone, so widening the window again restores what the user chose.
 * @param {{ open: boolean, wide: boolean, popover: boolean }} state
 */
export function press({ open, wide, popover }) {
  if (wide) return { open: !open, popover: false }
  return { open, popover: !popover }
}

/**
 * @param {typeof import('react')} react
 * @param {((node: any, container: Element) => any) | undefined} portal - react-dom createPortal
 */
export function developmentWorkbench(react, portal) {
  const { createElement: h, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = react
  /** The plugin's page context, DSH's job roster and its workspace UI (to open a Session the workbench created), when mounted. */
  let pageCtx, jobs, uiWorkspace
  const call = pageRpc('/fig-development-workbench')
  const store = workbenchStore(call, () => pageCtx)
  /** The parts every module's factory takes. */
  const wb = /** @type {any} */ ({ react, h, Icon: iconFactory(h), call, store, ctx: () => pageCtx, jobs: () => jobs, workspace: () => uiWorkspace })
  wb.ui = uiKit(wb)
  wb.pulls = pullsKit(wb)
  const { CommitDialog, ActionDialog } = dialogs(wb)
  const { Card, Tasks } = card(wb)
  const details = pullDetail(wb)
  const diffs = diffTab(react, call, store.quote, store.subscribeData, store.extensionEpoch)

  /** The header button; it also places the Session's card, docked into the conversation body or as a popover. */
  function WorkbenchButton({ sessionId, useProjection }) {
    const current = useSyncExternalStore(store.subscribe, store.snapshot)
    const button = useRef(/** @type {HTMLButtonElement | null} */ (null))
    const [body, setBody] = useState(/** @type {HTMLElement | null} */ (null))
    const [wide, setWide] = useState(false)
    const [anchor, setAnchor] = useState(/** @type {DOMRect | null} */ (null))
    useLayoutEffect(() => {
      // This Session's conversation body only: docking into another Session's would cover the wrong chat.
      const root = button.current?.closest('[data-slot="main.conversation"]')
      const content = root?.querySelector(`[data-conversation-content][data-conversation-session="${CSS.escape(sessionId)}"]`)
      if (!(content instanceof HTMLElement)) return
      setBody(content)
      // The column's width, which the docked card's padding does not change.
      const column = content.parentElement ?? content
      const measure = () => setWide(column.getBoundingClientRect().width >= DOCK_FROM)
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(column)
      return () => observer.disconnect()
    }, [sessionId])
    const popover = current.popovers.has(sessionId)
    const where = body ? placement({ open: current.open, wide, popover }) : 'hidden'
    useLayoutEffect(() => {
      if (!body) return
      body.toggleAttribute(dockedAttribute, where === 'docked')
      return () => body.removeAttribute(dockedAttribute)
    }, [body, where])
    // A popover drops when the window widens enough to dock, and closes on Escape or a press outside it.
    useEffect(() => {
      if (where !== 'popover') return
      // Horizontal alignment belongs to the conversation column, not the toolbar button.
      const column = body?.parentElement ?? body
      const place = () => {
        const trigger = button.current?.getBoundingClientRect()
        const edge = column?.getBoundingClientRect()
        setAnchor(trigger && edge ? new DOMRect(edge.left, trigger.top, edge.width, trigger.height) : null)
      }
      const observer = new ResizeObserver(place)
      if (column) observer.observe(column)
      place()
      const close = () => setPopover(false)
      const key = event => { if (event.key === 'Escape') close() }
      const down = event => {
        const target = /** @type {Node} */ (event.target)
        if (button.current?.contains(target) || document.querySelector(`[data-fig-workbench="popover"][data-session="${CSS.escape(sessionId)}"]`)?.contains(target)) return
        close()
      }
      window.addEventListener('resize', place)
      document.addEventListener('keydown', key, true)
      document.addEventListener('mousedown', down, true)
      return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', down, true) }
    }, [where, sessionId, body])
    useEffect(() => { if (wide && popover) setPopover(false) }, [wide, popover])
    function setPopover(show) {
      const popovers = new Set(store.state.popovers)
      if (show) popovers.add(sessionId); else popovers.delete(sessionId)
      store.setState({ ...store.state, popovers })
    }
    const onClick = () => {
      const state = store.state
      const next = press({ open: state.open, wide, popover: state.popovers.has(sessionId) })
      if (next.open !== state.open) writePreference(next.open)
      const popovers = new Set(state.popovers)
      if (next.popover) popovers.add(sessionId); else popovers.delete(sessionId)
      store.setState({ ...state, open: next.open, popovers })
    }
    const label = where === 'hidden' ? t('workbench.openDevelopmentWorkbench') : t('workbench.closeDevelopmentWorkbench')
    const control = h('button', { key: 'button', ref: button, type: 'button', 'data-fig-workbench-button': '', 'aria-label': label,
      'aria-pressed': where !== 'hidden', onClick }, h(wb.Icon, { name: 'pull', size: 16 }))
    const dialog = !portal ? null : current.commitFor === sessionId ? portal(h(CommitDialog, { sessionId }), document.body)
      : current.action && current.action.sessionId === sessionId ? portal(h(ActionDialog, { key: current.action.kind + ':' + (current.action.data.pull?.url ?? ''), action: current.action }), document.body) : null
    if (!portal || !body || where === 'hidden') return dialog ? [control, h(react.Fragment, { key: 'dialog' }, dialog)] : control
    const docked = where === 'docked'
      ? portal(h(Card, { sessionId, useProjection, mode: 'docked', style: { position: 'absolute', top: GAP, right: GAP, maxHeight: `calc(100% - ${GAP * 2}px)`, zIndex: 3 } }), body)
      : anchor && portal(h('div', { 'data-session': sessionId, 'data-fig-workbench': 'popover', style: { position: 'fixed', zIndex: 2147482000,
        top: anchor.bottom + 8, left: Math.max(GAP, Math.min(anchor.right - CARD_WIDTH - GAP, window.innerWidth - CARD_WIDTH - GAP)) } },
      h(Card, { sessionId, useProjection, mode: 'popover-card', style: { maxHeight: `calc(100vh - ${Math.round(anchor.bottom) + 24}px)`,
        boxShadow: '0 12px 36px rgba(0,0,0,.18)' } })), document.body)
    return [control, docked && h(react.Fragment, { key: 'card' }, docked), dialog && h(react.Fragment, { key: 'dialog' }, dialog)]
  }

  /** @param {any} ctx */
  function register(ctx) {
    ctx.provide('figDevelopmentView', Object.freeze({ version: 1, openComparison: store.openComparison }))
    ctx.effect(() => store.watchExtension())
    pageCtx = ctx
    // The style sheet lives as long as the plugin: an update's dispose takes the old sheet with it.
    ctx.effect(() => retainStyle())
    if (typeof ctx.inject === 'function') {
      ctx.inject(['jobs'], scope => { jobs = scope.jobs; scope.effect(() => () => { jobs = undefined }) })
      ctx.inject(['uiWorkspace'], scope => { uiWorkspace = scope.uiWorkspace; scope.effect(() => () => { uiWorkspace = undefined }) })
      ctx.inject(['resources', 'sidebarRightTabs'], scope => { scope.effect(() => diffs.registerDiff(scope)); scope.effect(() => details.register(scope)) })
    }
    ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities', id: 'fig-development-workbench', order: -7,
      inject: sessionId => ({ sessionId })
    }, WorkbenchButton)))
  }

  return { register, Tasks }
}
