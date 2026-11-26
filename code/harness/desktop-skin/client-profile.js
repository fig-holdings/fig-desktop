import { useStore } from '../shared/page-client.js'
import { t } from './client-locale.js'
import { pageRpc } from '../shared/page-rpc.js'
import { slotFace } from '../shared/dsh-internals.js'
import { blockedRequired } from '../shared/profile-contract.ts'
import { figDanger } from '../shared/brand-colors.js'
import { watchPage } from '../shared/page-observer.js'

// The Profile's look in the page (app/main/profile.ts, harness/shared/profile-contract.ts):
// - the `figProfile` service: edition, shell look and external plugin states, for Fig's panels and other plugins;
// - which sidebar panels show (all of them unless the descriptor names some), the rest under More; 「自定义侧栏…」 at the
//   end of More lets the user choose, in every edition, kept per Profile;
// - DSH's plugin browse/create rows are off unless the descriptor turns them on (main switches off
//   dsh-client-ui-entry-customization), so the More menus list the folded panels and views themselves;
// - a required plugin that is not running: its switch on the Plugins page is locked and the sidebar foot says why.
// The defaults are the same in every edition (shared/profile-contract.ts).

const call = pageRpc('/fig-skin')

/** The `figProfile` service: a snapshot store of the Profile, loaded once per page. */
export function profileStore() {
  let state, pins = {}
  const listeners = new Set()
  const publish = () => { for (const listener of listeners) listener() }
  const ready = Promise.all([call('profile/state'), call('profile/pins').catch(() => ({}))]).then(([value, saved]) => {
    state = value; pins = saved; publish(); return value
  }, () => undefined)
  return {
    ready,
    /** The Profile, or undefined until it is read. */
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** Whether a panel shows in the sidebar: the user's choice, else the Profile's default; undefined: DSH decides. */
    pinned(id) {
      if (!state) return undefined
      if (typeof pins[id] === 'boolean') return pins[id]
      return state.shell.pinnedPanels ? state.shell.pinnedPanels.includes(id) : undefined
    },
    async setPinned(id, pinned) {
      pins = { ...pins, [id]: pinned }
      // A new snapshot, so readers of the pins re-render (the Plugins panel's pin changes nothing in DSH's own state).
      if (state) state = { ...state }
      publish()
      await call('profile/pin', { id, pinned }).catch(() => {})
    }
  }
}

/**
 * Applies the pins through the sidebar's own pin call. DSH 0.2.2-rc.1 keeps pins in memory only and offers the call to
 * its More menu rows, which render only while the menu is open; the defaults must apply at load, so this reuses the
 * sidebar registration's injected face (as client-custom-plugins.js does for the Plugins page). The face is looked up
 * again whenever the sidebar slot changes, so a sidebar registered after this plugin still gets the pins. A pin the user
 * changes in DSH's own UI is kept as their choice in the Profile, not undone. Remove when DSH offers persisted or
 * default pins. Re-check on each DSH upgrade (npm run dsh:verify).
 */
export function applyPins(ctx, store) {
  let face, stops = [], seen = new Map()
  const pinState = () => {
    const unpinned = new Set(face.hooks.entryPins?.getSnapshot?.() ?? [])
    return new Map((face.hooks.panels.getSnapshot() ?? []).map(panel => [panel.id, !unpinned.has(panel.id)]))
  }
  // The user's choices and the Profile's defaults, when the store publishes or the sidebar's panels change.
  const apply = () => {
    if (!face) return
    for (const [id, pinned] of pinState()) {
      const want = store.pinned(id)
      if (want !== undefined && want !== pinned) face.setPinned(id, want)
    }
    seen = pinState()
  }
  // A pin that changed since we last looked, to other than what the store wants, was changed in DSH's own UI.
  const keepUserChange = () => {
    if (!face) return
    const now = pinState()
    if (store.getSnapshot()) for (const [id, pinned] of now) {
      if (seen.has(id) && seen.get(id) !== pinned && store.pinned(id) !== pinned) void store.setPinned(id, pinned)
    }
    seen = now
  }
  const attach = () => {
    for (const stop of stops) if (typeof stop === 'function') stop()
    face = slotFace(ctx, 'sidebar', undefined, { accept: item => typeof item?.setPinned === 'function' && Boolean(item?.hooks?.panels?.getSnapshot) })
    stops = face ? [face.hooks.panels.subscribe?.(apply), face.hooks.entryPins?.subscribe?.(keepUserChange)] : []
    apply()
  }
  const offStore = store.subscribe(() => { if (face) apply(); else attach() })
  const offSlots = typeof ctx.on === 'function' ? ctx.on('slots/changed', key => { if (key === 'sidebar') attach() }) : undefined
  attach()
  return () => {
    offStore()
    if (typeof offSlots === 'function') offSlots()
    for (const stop of stops) if (typeof stop === 'function') stop()
  }
}

/** A store that forwards to whichever foldPlugins store is attached (made before the plugin's ctx exists). */
export function relayStore() {
  let source, stop = () => {}
  const listeners = new Set()
  const publish = () => { for (const listener of listeners) listener() }
  return {
    attach(next) { stop(); source = next; stop = next?.subscribe(publish) ?? (() => {}); publish() },
    getSnapshot: () => source?.getSnapshot(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}

/** DSH's Plugins panel id: DSH 0.2.2-rc.5 keeps it pinned (FIXED_PANEL_ID) and leaves it out of the More menu. */
const pluginsPanel = 'plugins'

/**
 * The Plugins panel folds into More like any other (user 2026-11-21). DSH 0.2.2-rc.5 refuses to unpin it, always draws
 * its sidebar row and leaves it out of the More menu's entries, so Fig keeps that one pin itself (the same per-Profile
 * choice over the descriptor's `pinnedPanels`): its row is hidden while folded, and PanelRows adds it to More, in the
 * sidebar's order, opened through the sidebar face's `selectPanel`. The row is found by its label (DSH's rows carry no
 * id). Remove when DSH lets the Plugins panel be unpinned. Re-check on each DSH upgrade (npm run dsh:verify).
 * Returns the store PanelRows reads: { label, order (panel ids in sidebar order), active, open }.
 */
export function foldPlugins(ctx, store) {
  const listeners = new Set()
  let snapshot = { label: '', order: [], active: false, open: () => {} }, face, stops = [], marked
  const publish = next => { snapshot = next; for (const listener of listeners) listener() }
  const read = () => {
    const panels = face?.hooks?.panels?.getSnapshot?.() ?? []
    const label = panels.find(panel => panel.id === pluginsPanel)?.label ?? ''
    const active = ctx.layout?.panelInfo?.getSnapshot?.()?.activePanelId === pluginsPanel
    const order = panels.map(panel => panel.id)
    if (label !== snapshot.label || active !== snapshot.active || order.join('\u0000') !== snapshot.order.join('\u0000'))
      publish({ label, order, active, open: () => face?.selectPanel?.(pluginsPanel) })
    mark()
  }
  function mark() {
    const folded = store.pinned(pluginsPanel) === false && snapshot.label
    const row = folded ? [...document.querySelectorAll('[data-slot="sidebar"] nav button[aria-label]')]
      .find(button => button.getAttribute('aria-label') === snapshot.label)?.closest('[class*="_panelEntry"]') : null
    if (marked && marked !== row) { marked.removeAttribute('data-fig-panel-folded'); marked = undefined }
    if (row && row !== marked) { row.setAttribute('data-fig-panel-folded', ''); marked = row }
  }
  const attach = () => {
    for (const stop of stops) if (typeof stop === 'function') stop()
    face = slotFace(ctx, 'sidebar', undefined, { accept: item => typeof item?.selectPanel === 'function' && Boolean(item?.hooks?.panels?.getSnapshot) })
    stops = [face?.hooks?.panels?.subscribe?.(read), ctx.layout?.panelInfo?.subscribe?.(read)]
    read()
  }
  const offStore = store.subscribe(() => { if (face) read(); else attach() })
  const offSlots = typeof ctx.on === 'function' ? ctx.on('slots/changed', key => { if (key === 'sidebar') attach() }) : undefined
  const stopRows = watchPage({ name: 'folded plugins panel', childList: true, within: '[data-slot="sidebar"]', run: mark })
  const style = document.createElement('style')
  style.textContent = '[data-fig-panel-folded]{display:none!important}'
  document.head.append(style)
  attach()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() {
      offStore(); stopRows()
      if (typeof offSlots === 'function') offSlots()
      for (const stop of stops) if (typeof stop === 'function') stop()
      marked?.removeAttribute('data-fig-panel-folded'); style.remove()
    }
  }
}

/** @param {typeof import('react')} react */
export function profileComponents(react, primitives, store, plugins) {
  const { createElement: h, useState } = react
  const { MenuItemButton, IconCheckOutlineRegular } = primitives
  const useProfile = () => useStore(react, store, undefined)
  const blank = h('span', { style: { display: 'inline-block', width: 16, height: 16 } })
  // Read by screen readers only.
  const hidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }

  /**
   * The sidebar's More menu, in every edition (user decision 2026-11-17): the folded panels to open, a separator, then
   * 「自定义侧栏…」, which unfolds in place into a check for each panel. The choices are kept per Profile over its defaults.
   */
  function PanelRows({ entries = [], onOpen, onPinnedChange, onDismiss }) {
    const state = useProfile()
    const panel = useStore(react, plugins, undefined)
    const [customizing, setCustomizing] = useState(false)
    if (!state) return null
    // DSH leaves its Plugins panel out of these entries; Fig adds it in the sidebar's order (foldPlugins).
    if (panel?.label && !entries.some(entry => entry.id === pluginsPanel)) {
      const own = { id: pluginsPanel, label: panel.label, pinned: store.pinned(pluginsPanel) !== false, active: panel.active }
      const after = panel.order.slice(0, panel.order.indexOf(pluginsPanel))
      const at = entries.findIndex(entry => !after.includes(entry.id))
      entries = at < 0 ? [...entries, own] : [...entries.slice(0, at), own, ...entries.slice(at)]
    }
    const open = id => id === pluginsPanel ? panel?.open() : onOpen(id)
    const folded = entries.filter(entry => !entry.pinned)
    return h(react.Fragment, null,
      // MenuItemButton forwards neither data attributes nor a role, so the marks sit on the label.
      folded.map(entry => h(MenuItemButton, { key: 'open:' + entry.id, current: entry.active === true,
        onSelect: () => { onDismiss?.(); open(entry.id) } }, h('span', { 'data-fig-panel-open': entry.id }, entry.label))),
      h(MenuItemButton, { key: 'customize', separatorBefore: folded.length > 0, onSelect: () => setCustomizing(value => !value) },
        h('span', { 'data-fig-customize-sidebar': '', 'aria-expanded': customizing }, t('profile.customizeSidebar'))),
      customizing && entries.map(entry => h(MenuItemButton, { key: 'pin:' + entry.id,
        icon: entry.pinned ? h(IconCheckOutlineRegular, { size: 16 }) : blank,
        onSelect: () => { if (entry.id !== pluginsPanel) onPinnedChange(entry.id, !entry.pinned); void store.setPinned(entry.id, !entry.pinned) } },
        h('span', { 'data-fig-panel-pin': entry.id, 'data-pinned': entry.pinned }, entry.label,
          h('span', { style: hidden }, entry.pinned ? t('profile.shownInTheSidebar') : t('profile.notShownInTheSidebar'))))),
      // DSH's own browse/create rows follow when the descriptor turns them on, and draw no separator of their own in this menu.
      state.shell.pluginMenuActions && h('div', { role: 'separator', style: { height: 1, margin: '4px 12px', background: 'var(--dsw-alias-border-l2)' } }))
  }

  /** The views the session header folded, when DSH's own rows for them are off in this Profile. */
  function FoldedViews({ entries = [], onOpen, onDismiss }) {
    const state = useProfile()
    if (!state || state.shell.pluginMenuActions) return null
    return h(react.Fragment, null, entries.map(entry => h(MenuItemButton, { key: entry.id, current: entry.active === true,
      onSelect: () => { onDismiss?.(); onOpen(entry.id) } }, entry.label)))
  }

  /** A warning at the sidebar foot while a required plugin is not running; it names each one and why. */
  function RequiredNotice() {
    const state = useProfile()
    const [open, setOpen] = useState(/** @type {{left: number, bottom: number, width: number} | null} */ (null))
    const blocked = state ? blockedRequired(state) : []
    if (!blocked.length) return null
    const title = t('profile.aRequiredPluginIsNot')
    return h('span', { style: { position: 'relative', display: 'inline-flex' } },
      h('button', { type: 'button', 'data-fig-required-notice': '', 'aria-label': title, title, 'aria-expanded': Boolean(open),
        onClick: event => {
          // The sidebar foot is narrower than the card: place it in the window, above the button and inside the edges.
          const rect = event.currentTarget.getBoundingClientRect(), width = Math.min(280, innerWidth - 16)
          setOpen(value => value ? null : { left: Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)), bottom: innerHeight - rect.top + 6, width })
        },
        style: { width: 28, height: 28, padding: 0, border: 'none', borderRadius: 'var(--dsw-radius-sm)', background: 'transparent', color: figDanger, cursor: 'pointer', display: 'inline-grid', placeItems: 'center' } },
        h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true },
          h('path', { d: 'm10 3 8 14H2l8-14Zm0 5v4m0 2v.2' }))),
      open && h('div', { role: 'dialog', 'aria-label': title, style: { position: 'fixed', left: open.left, bottom: open.bottom, width: open.width, boxSizing: 'border-box', zIndex: 20, padding: '12px 14px',
        borderRadius: 10, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        border: '.5px solid var(--dsw-alias-border-l2)', boxShadow: '0 8px 24px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, title),
        blocked.map(plugin => h('p', { key: plugin.origin, style: { margin: '4px 0', overflowWrap: 'anywhere' } },
          h('strong', null, plugin.name ?? plugin.origin), ' · ', plugin.reason ?? t('profile.notLoaded'))),
        h('p', { style: { margin: '8px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
          t('profile.figLoadsItAgainAt'))))
  }

  return { PanelRows, FoldedViews, RequiredNotice }
}

/**
 * Locks the Plugins page switch of each required plugin: it is selected again at every start anyway. The style dims
 * the switch and blocks the pointer; a capture listener also refuses the keyboard (Space, Enter) and any click that
 * still arrives, and marks the switch aria-disabled when it is reached.
 */
export function lockRequired(store) {
  const style = document.createElement('style')
  style.dataset.figRequiredPlugins = ''
  let selector = ''
  const marked = new Set()
  const render = () => {
    const names = (store.getSnapshot()?.plugins ?? []).filter(plugin => plugin.required && plugin.name).map(plugin => JSON.stringify(plugin.name))
    selector = names.map(name => `[data-plugin-package=${name}] [role="switch"]`).join(',')
    style.textContent = names.map(name => `[data-plugin-package=${name}] [role="switch"]{pointer-events:none;opacity:.45}`).join('')
  }
  const locked = target => selector && target instanceof Element ? target.closest(selector) : null
  const refuse = event => {
    const control = locked(event.target)
    if (!control) return
    if (event.type === 'keydown' && event.key !== ' ' && event.key !== 'Enter') return
    if (event.type !== 'focusin') { event.preventDefault(); event.stopPropagation() }
    if (control.getAttribute('aria-disabled') !== 'true') { control.setAttribute('aria-disabled', 'true'); marked.add(control) }
  }
  const events = ['keydown', 'click', 'focusin']
  for (const type of events) document.addEventListener(type, refuse, true)
  document.head.append(style)
  const stop = store.subscribe(render)
  render()
  return () => {
    stop(); style.remove()
    for (const type of events) document.removeEventListener(type, refuse, true)
    for (const control of marked) control.removeAttribute('aria-disabled')
  }
}
