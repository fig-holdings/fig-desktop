// Task activity's extension points, offered to other page plugins as the `figActivity` service. They are generic: a
// plugin adds views, figures, blocks, session tags or projects; Task activity owns the layout and draws them with
// figUi (ui-kit). With nothing registered the panel looks exactly as before. The contract below is versioned: a
// version only adds, and a plugin checks `ctx.figActivity.version` before using what a later version added.
//
//   const handle = ctx.figActivity.register({ kind: 'summary', id: 'team-items', label: '工作项', value: 3 })
//   handle.update({ value: 4 }); handle.dispose()   // also disposed with the registering plugin's scope via ctx.effect
//
// Kinds and their fields (all registrations take `id` and an optional `order`, lower first):
// - view:       { label, component }      another view beside the panel's own; id 'default' with only `label` renames that one.
// - summary:    { label, value, caption } a figure after the panel's own four.
// - attention:  { count, label }          adds to "Needs attention"; the caption names each part ("3 sessions · 2 work items").
// - section:    { placement: 'top' | 'bottom', title, component, open } a full-width block: 'top' before
//               "Your attention", 'bottom' a collapsible block at the end.
// - decoration: { tags: { [sessionId]: [{ label, tone, title, onClick }] } } tags on that session's cards.
// - projects:   { projects: [{ id, name }] } more choices in the project filter.
// - tool:       { component } a control at the right end of the page heading, after the block index (Fig Cowork §4.7,
//               say a notification bell). It draws its own button and any popover (through a portal); it stays on top
//               with the heading. Tools are not counted in the sidebar badge.
// Components receive { project } (the selected project id, '' for all) and render inside the panel.
// A section can be added or disposed at any time (a team plugin does on a role change); the page index follows.
// `title` (section) and `label` (attention) may change through handle.update, say on a language switch.
//
// Version 2 adds two read-only stores, each { get(), subscribe(listener) };
// get() returns the same object while the data is unchanged:
// - sessions: [{ id, title, workspaceId, pending: 'approval' | 'question' | 'other' | null, running, unreadResults,
//              failure: null | 'error' | 'quota' | 'rate-limit' }], the rows 「需要你处理」 and the sidebar badge use;
// - usage:    the usage heat map's view (null while first read): { days, cells[7][24], peak, total, loading, failed },
//             each cell with total, input, cache, output, projects, models and sessions [{ id, total }] adding up to
//             total ('' for calls without a Session).

import { t } from './client-locale.js'
import { orderedRegistry } from '../shared/ordered-registry.js'

export const version = 2
const kinds = new Set(['view', 'summary', 'attention', 'section', 'decoration', 'projects', 'tool'])

/** @param {{ sessions?: { get(): any[], subscribe(listener: () => void): () => void }, usage?: { get(): any, subscribe(listener: () => void): () => void } }} [stores] */
export function activityExtensions(stores = {}) {
  // One table for every kind; the same id may be used once per kind.
  const registry = orderedRegistry()
  let project = ''

  function register(entry) {
    if (!entry || !kinds.has(entry.kind) || typeof entry.id !== 'string' || !entry.id) throw new TypeError('figActivity.register: kind and id are required')
    return registry.add(entry.kind + '\u0000' + entry.id, { order: 0, ...entry }, { kind: entry.kind, id: entry.id })
  }

  const list = kind => registry.list(item => item.kind === kind)
  const empty = { get: () => null, subscribe: () => () => {} }
  return {
    version,
    register,
    sessions: stores.sessions ? { get: stores.sessions.get, subscribe: stores.sessions.subscribe } : { ...empty, get: () => [] },
    usage: stores.usage ? { get: stores.usage.get, subscribe: stores.usage.subscribe } : empty,
    /** The project the panel's filter shows, '' for all. */
    getProject: () => project,
    setProject(value) { if (value !== project) { project = typeof value === 'string' ? value : ''; registry.publish() } },
    subscribe: registry.subscribe,
    /** For the panel: a version number that changes with every registration or project change. */
    getSnapshot: registry.getSnapshot,
    list,
    /** Tags for one session's cards, from every decoration. */
    tags: sessionId => list('decoration').flatMap(item => Array.isArray(item.tags?.[sessionId]) ? item.tags[sessionId] : []),
    /** Extra counts for "Needs attention". */
    attention: () => list('attention').filter(item => Number.isFinite(item.count) && item.count > 0)
  }
}

/**
 * Wraps another plugin's view or section: if it throws while rendering, only it is replaced by one line, and the panel
 * stays. A new component for the same registration (handle.update) gets another try.
 * @param {typeof import('react')} react
 */
export function extensionBoundary(react) {
  const { Component, createElement: h } = react
  return class ExtensionBoundary extends Component {
    /** @param {{ id: string, component: any, props: object }} props */
    constructor(props) { super(props); this.state = { failed: false, component: props.component } }
    static getDerivedStateFromError() { return { failed: true } }
    static getDerivedStateFromProps(props, state) { return props.component !== state.component ? { failed: false, component: props.component } : null }
    componentDidCatch(error) { console.warn('[fig-activity] Extension "' + this.props.id + '" failed to render', error) }
    render() {
      if (this.state.failed) return h('p', { role: 'status', 'data-fig-activity-extension-error': this.props.id, style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: 0 } },
        t('extensions.thisExtensionCouldNotBe'))
      return h(this.props.component, this.props.props)
    }
  }
}
