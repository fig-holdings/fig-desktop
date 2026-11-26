import {activityStyle} from './activity-style.js'
import {colors, button, note} from '../shared/page-ui.js'
import { t } from './client-locale.js'
import {isZh} from '../shared/page-locale.js'
import {pageRpc} from '../shared/page-rpc.js'
import {isTopmostWithin, openConversations} from '../shared/dsh-internals.js'
import {attentionContextGlobal, windowForegroundGlobal} from '../shared/page-contract.ts'
import {usageComponents} from './client-usage.js'
import {extensionBoundary} from './client-extensions.js'
const call = pageRpc('/fig-attention', { unavailable: () => t('dynamics.unavailable'), failed: () => t('dynamics.saveFailed') })
const listeners = new Set()
let current = {rows: [], workspaces: [], synced: false}
const publish = () => {for (const listener of listeners) listener(current)}
const activeFailures = row => row.failures.filter(f => !f.known)
const quotaFailure = failure => failure.category === 'quota' || failure.category === 'rate-limit'
const ordinaryFailures = row => activeFailures(row).filter(f => !quotaFailure(f))
const badge = rows => rows.filter(row => row.pendingKinds.length || activeFailures(row).length || row.results.length).length
const firstPending = row => Math.min(...ordinaryFailures(row).map(f => f.at), ...row.pendingKinds.map(k => row.pendingSince?.[k] ?? row.lastSignificantAt))
const rank = row => ordinaryFailures(row).length ? 0 : row.pendingKinds.includes('approval') ? 1 : row.pendingKinds.includes('question') ? 2 : 3
const receiptLabel = action => action === 'snooze' ? t('dynamics.remindIn1Hour')
  : action === 'known' ? t('dynamics.failureAcknowledged') : t('dynamics.failureAttentionEnded')
const errorCode = error => error instanceof Error && 'code' in error ? error.code : undefined

const pendingOrder = ['approval', 'question', 'other']
/** One row of figActivity v2's `sessions` (client-extensions.js), from the same rows as 「需要你处理」 and the badge. */
const sessionRow = row => {
  const failures = activeFailures(row), ordinary = failures.find(failure => !quotaFailure(failure))
  return {id: row.sessionId, title: row.title, workspaceId: row.workspaceId, pending: pendingOrder.find(kind => row.pendingKinds.includes(kind)) ?? null,
    running: Boolean(row.running), unreadResults: row.results.length, failure: ordinary ? 'error' : failures[0]?.category ?? null}
}
/** @type {{ source: any, rows: any[], text: string }} */
let sessionCache = {source: undefined, rows: [], text: '[]'}
/** figActivity v2's `sessions`: the same array while nothing in it changes. */
export const sessionStore = {
  get() {
    if (sessionCache.source !== current) {
      const rows = current.rows.map(sessionRow), text = JSON.stringify(rows)
      sessionCache = {source: current, rows: text === sessionCache.text ? sessionCache.rows : rows, text}
    }
    return sessionCache.rows
  },
  subscribe(listener) {const run = () => listener(); listeners.add(run); return () => {listeners.delete(run)}}
}

/** The board's groups. A session may sit in several; `list` orders a group itself, else rows with `items` are listed. */
const boardGroups = rows => [
  {kind: 'pending', label: t('dynamics.needsInput'), list: rows.filter(row => row.pendingKinds.length || ordinaryFailures(row).length)
    .sort((a,b) => rank(a)-rank(b) || firstPending(a)-firstPending(b)), items: ordinaryFailures},
  {kind: 'running', label: t('dynamics.running'), list: rows.filter(r => r.running).sort((a,b) => b.lastSignificantAt-a.lastSignificantAt)},
  {kind: 'result', label: t('dynamics.newResults'), items: row => row.results},
  {kind: 'failure', label: t('dynamics.failures'), items: activeFailures},
  {kind: 'known', label: t('dynamics.acknowledged'), items: row => row.failures.filter(f => f.known)}
]

const allParts = {views: true, figures: true, usage: true, filter: true, sessionGroups: true}
const foldKey = profile => 'fig-activity-folds:' + (profile?.id ?? '')
const readFolds = profile => { try { const value = JSON.parse(localStorage.getItem(foldKey(profile)) ?? '{}'); return value && typeof value === 'object' ? value : {} } catch { return {} } }
const saveFolds = (profile, folds) => { try { localStorage.setItem(foldKey(profile), JSON.stringify(folds)) } catch {} }
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * @param {any} ui the figUi service (ui-kit) @param {ReturnType<typeof import('./client-extensions.js').activityExtensions>} extensions
 * @param {{ getSnapshot(): any, subscribe(listener: () => void): () => void }} profile the figProfile snapshot, undefined outside Fig
 * @param {ReturnType<typeof import('./client-usage.js').usageStore>} usage
 */
export function activityComponents(react, ctx, ui, extensions, profile, usage) {
  const {createElement: h, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore} = react
  const {UsageHeatmap} = usageComponents(react, ui, usage)
  const {Metric, RingMetric, GroupCard, StatusTag} = ui
  // Another plugin's view or section that throws hides itself, never the panel.
  const ExtensionBoundary = extensionBoundary(react)
  const useActivity = () => {
    const [state, setState] = useState(current)
    useEffect(() => {listeners.add(setState); setState(current); return () => {listeners.delete(setState)}}, [])
    return state
  }
  const action = (label, run, disabled = false) => h('button', {type: 'button', style: button, disabled, onClick: run}, label)
  function ActivityIcon({size = 16}) {
    const count = badge(useActivity().rows)
    return h('span', {style: {position: 'relative', display: 'inline-flex'}, 'data-fig-activity-badge': count, 'aria-label': t('dynamics.needsAttention') + count},
      h('svg', {width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true}, h('path', {d: 'M2 4h12M2 8h8M2 12h10', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round'})),
      count > 0 && h('span', {style: {fontSize: 9, minWidth: 12, padding: '0 2px', borderRadius: 8, background: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-static-neutral-00)', position: 'absolute', left: 10, top: -6, lineHeight: '13px', textAlign: 'center'}}, count > 99 ? '99+' : count))
  }

  /** One session's card in a group: title, project and status, extension tags, and the group's actions. */
  function sessionCard(group, row, {names, open, acknowledge}) {
    const items = group.items?.(row) ?? []
    const unresolved = items.length && ['pending', 'failure'].includes(group.kind)
    const snoozable = items.length && ['result', 'failure'].includes(group.kind)
    const status = [
      unresolved && items.some(item => !quotaFailure(item)) && t('dynamics.failureToAcknowledge'),
      group.kind === 'failure' && items.some(item => item.category === 'quota') && t('dynamics.usageLimitReached'),
      group.kind === 'failure' && items.some(item => item.category === 'rate-limit') && t('dynamics.rateLimitedTryAgainShortly'),
      row.pendingKinds.includes('approval') && t('dynamics.approvalPlan'),
      row.pendingKinds.includes('question') && t('dynamics.question'),
      row.pendingKinds.includes('other') && t('dynamics.otherInput'),
      row.running && t('dynamics.running'),
      row.results.length && t('dynamics.unreadResults') + row.results.length
    ].filter(Boolean)
    return h('article', {key: row.sessionId, 'data-fig-activity-session': row.sessionId, className: 'fa-row'},
      h('div', {className: 'fa-info'},
        h('button', {type: 'button', className: 'fa-title', title: row.title, onClick: () => open(row)}, row.title),
        h('span', {className: 'fa-meta'}, [names.get(row.workspaceId) ?? t('dynamics.noProject'), ...status.filter(label => label !== t('dynamics.running'))].join(' · ')),
        extensions.tags(row.sessionId).map((tag, index) => h(StatusTag, {key: index, tone: tag.tone, title: tag.title,
          onClick: typeof tag.onClick === 'function' ? () => tag.onClick(row.sessionId) : undefined}, tag.label))),
      group.kind === 'known'
        ? h('details', null,
            h('summary', null, t('dynamics.acknowledged') + ' · ' + items.length),
            h('ul', {style: note}, items.map(item => h('li', {key: item.identity},
              t('dynamics.turn') + item.turn + ' · ' + new Date(item.at).toLocaleString()))),
            action(t('dynamics.endFailureAttention'), () => void acknowledge(row, items, 'end')))
        : h('div', {className: 'fa-actions'},
            h('button', {type: 'button', className: 'fa-action fa-open', 'aria-label': t('dynamics.openConversation'), onClick: () => open(row)}, '↗'),
            group.kind === 'result' ? h('button', {type: 'button', className: 'fa-action', onClick: () => void acknowledge(row, items, 'read')}, t('dynamics.read')) : null,
            unresolved ? h('button', {type: 'button', className: 'fa-action', 'aria-label': t('dynamics.acknowledgeFailure'), onClick: () => void acknowledge(row, items, 'known')}, t('dynamics.acknowledge')) : null,
            (snoozable || unresolved) ? h('details', {className: 'fa-more'}, h('summary', {'aria-label': t('dynamics.moreActions')}, '···'),
              h('div', {className: 'fa-menu', onClick: event => {event.currentTarget.closest('details').open = false}}, snoozable ? action(t('dynamics.remindLater'), () => void acknowledge(row, items, 'snooze')) : null,
                unresolved ? action(t('dynamics.endFailureAttention'), () => void acknowledge(row, items, 'end')) : null)) : null))
  }

  /** The figures row: needs attention (with other plugins' counts), one figure per group, then other plugins' figures. */
  function Overview({rows, groups}) {
    const extraAttention = extensions.attention(), extraSummaries = extensions.list('summary')
    const extra = extraAttention.reduce((sum, item) => sum + item.count, 0)
    return h('section', {className: 'fa-overview', 'aria-label': t('dynamics.sessionOverview'), style: extraSummaries.length ? {'--fa-metrics': 4 + extraSummaries.length} : undefined},
      h(RingMetric, {className: 'fa-attention', value: badge(rows) + extra,
        total: rows.length + extra, label: t('dynamics.needsAttentionLabel'),
        caption: extraAttention.length
          ? [(count => t(count === 1 ? 'dynamics.sessions.one' : 'dynamics.sessions.other', { count }))(badge(rows)), ...extraAttention.map(item => `${item.count} ${item.label ?? ''}`.trim())].join(' · ')
          : t(rows.length === 1 ? 'dynamics.ofSessions.one' : 'dynamics.ofSessions.other', { count: rows.length })}),
      groups.filter(g => g.kind !== 'known').map(group => h(Metric, {key: group.kind, label: group.label,
        value: (group.list ?? rows.filter(row => group.items?.(row).length)).length,
        caption: group.kind === 'failure' ? t('dynamics.inclUsageLimits') : group.kind === 'pending' ? t('dynamics.awaitingInput') : group.kind === 'result' ? t('dynamics.hasUnreadResults') : t('dynamics.executing')})),
      extraSummaries.map(item => h(Metric, {key: 'extension:' + item.id, label: item.label, value: item.value, caption: item.caption, 'data-fig-activity-summary': item.id})))
  }

  /** Undo receipts for the last actions, until each expires. */
  function Receipts({receipts, undo}) {
    if (!receipts.length) return null
    return h('div', {'aria-live': 'polite', style: {position: 'sticky', top: 'var(--fa-head-height, 0px)', zIndex: 1, background: 'var(--dsw-alias-bg-base, Canvas)'}},
      receipts.map(receipt => h('div', {key: receipt.token, style: {display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0'}},
        h('span', {style: {...note, overflowWrap: 'anywhere'}}, receiptLabel(receipt.kind) + ' · ' + receipt.title),
        action(t('dynamics.undo'), () => void undo(receipt)))))
  }

  /** "Your attention": the groups side by side, then the acknowledged failures folded away. */
  function Board({rows, groups, cards}) {
    const known = rows.filter(row => row.failures.some(f => f.known))
    return h(react.Fragment, null,
      h('div', {className: 'fa-board'}, groups.filter(group => group.kind !== 'known').map(group => {
        const items = group.items ?? (() => [])
        const list = group.list ?? rows.filter(row => items(row).length).sort((a,b) => items(b).at(-1).at-items(a).at(-1).at)
        const tone = group.kind === 'pending' ? 'accent' : group.kind === 'result' ? 'success' : group.kind === 'failure' ? 'danger' : 'neutral'
        return h(GroupCard, {key: group.kind, icon: group.kind, tone, title: group.label, count: list.length, empty: t('dynamics.noSessions'), className: 'fa-group'},
          list.map(row => sessionCard(group, row, cards)))
      })),
      h('section', {'aria-label': t('dynamics.acknowledged')},
        h('details', {className: 'fa-known'},
          h('summary', null, t('dynamics.acknowledged') + ' · ' + known.length),
          known.map(row => sessionCard(groups.find(group => group.kind === 'known'), row, cards)))))
  }

  /** Acknowledge, undo and their receipts and error line. */
  function useReadingActions() {
    const [receipts, setReceipts] = useState([]), [error, setError] = useState('')
    const undoing = useRef(new Set())
    useEffect(() => {
      if (!receipts.length) return
      const timer = setTimeout(() => setReceipts(previous => previous.filter(receipt => receipt.expiresAt > Date.now())),
        Math.max(0, Math.min(...receipts.map(receipt => receipt.expiresAt)) - Date.now()))
      return () => clearTimeout(timer)
    }, [receipts])
    const refresh = () => window.dispatchEvent(new Event('fig:activity-refresh'))
    const acknowledge = async (row, items, kind) => {
      setError('')
      try {
        const {undo} = await call('acknowledge', {sessionId: row.sessionId, identities: items.map(item => item.identity), action: kind})
        if (undo?.expiresAt > Date.now()) setReceipts(previous => [...previous, {...undo, kind, title: row.title}])
        refresh()
      } catch (failure) {
        setError(kind === 'snooze' && errorCode(failure) === 'ATTENTION_STORAGE'
          ? t('dynamics.couldNotSaveTheReminder')
          : t('dynamics.couldNotConfirmTheAction'))
      }
    }
    const undo = async receipt => {
      if (undoing.current.has(receipt.token)) return
      undoing.current.add(receipt.token)
      setError('')
      try {
        await call('undo', {token: receipt.token})
        setReceipts(previous => previous.filter(item => item.token !== receipt.token))
        refresh()
      } catch (failure) {
        setError(errorCode(failure) === 'ATTENTION_UNDO_EXPIRED'
          ? t('dynamics.theUndoWindowHasExpired')
          : t('dynamics.couldNotSaveTheUndo'))
      } finally {undoing.current.delete(receipt.token)}
    }
    return {receipts, error, acknowledge, undo}
  }

  /**
   * The page's blocks under one heading each, folding from it: usage, other
   * plugins' top blocks, 「需要你处理」, their bottom blocks. A personal Profile keeps each block's fold (bottom blocks start
   * as their `open` says) and highlights the block in view; a team Profile shows one block at a time, the first on
   * arrival, and highlights the open one.
   */
  function useBlocks(blocks, single, profileState) {
    // Folds are saved per Profile, which arrives after the first render: read them again once its id is known.
    const id = profileState?.id
    const [saved, setSaved] = useState(() => ({id, folds: readFolds(profileState)}))
    if (saved.id !== id) setSaved({id, folds: readFolds(profileState)})
    const folds = saved.id === id ? saved.folds : {}
    const [openId, setOpenId] = useState(/** @type {string | null} */ (null))
    const ids = blocks.map(block => block.id)
    const current = openId === null || (openId && !ids.includes(openId)) ? ids[0] ?? '' : openId
    const isOpen = block => single ? block.id === current : folds[block.id] ?? block.defaultOpen
    const setOpen = (block, open) => {
      if (single) { setOpenId(open ? block.id : ''); return }
      const next = {...folds, [block.id]: open}
      setSaved({id, folds: next})
      if (id) saveFolds(profileState, next)
    }
    return {isOpen, setOpen, current}
  }

  function BlockHead({block, open, onToggle}) {
    return h('div', {className: 'fa-block-head'},
      h('button', {type: 'button', className: 'fa-fold', 'aria-expanded': open, onClick: onToggle},
        h('svg', {width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true}, h('path', {d: 'M3 4.5 6 7.5 9 4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round'})),
        h('h2', null, block.title)),
      block.aside && h('span', null, block.aside))
  }

  function ActivityPanel() {
    const value = useActivity()
    useSyncExternalStore(extensions.subscribe, extensions.getSnapshot)
    const profileState = useSyncExternalStore(profile?.subscribe ?? (() => () => {}), profile?.getSnapshot ?? (() => undefined))
    const parts = {...allParts, ...profileState?.shell?.activity}
    const single = profileState?.edition === 'team'
    const project = parts.filter ? extensions.getProject() : '', setProject = extensions.setProject
    const [view, setView] = useState('default')
    const {receipts, error, acknowledge, undo} = useReadingActions()
    const rows = value.rows.filter(row => !project || row.workspaceId === project)
    const names = new Map(value.workspaces.map(w => [w.id, w.name]))
    // Choices other plugins add to the project filter (client-extensions.js), after the workspaces.
    const projects = [...value.workspaces, ...extensions.list('projects').flatMap(item => Array.isArray(item.projects) ? item.projects : [])
      .filter(item => typeof item?.id === 'string' && !names.has(item.id))]
    const views = extensions.list('view'), defaultView = views.find(item => item.id === 'default')
    const otherViews = parts.views ? views.filter(item => item.id !== 'default' && item.component) : []
    const shownView = otherViews.find(item => item.id === view)
    const groups = boardGroups(rows)
    const cards = {names, acknowledge, open: row => {ctx.uiWorkspace.openSession(row.sessionId)}}
    const sections = placement => extensions.list('section').filter(item => item.placement === placement && item.component).map(item => ({
      id: item.id, title: item.title ?? item.id, extension: item.id, defaultOpen: placement === 'top' || item.open === true,
      render: () => h(ExtensionBoundary, {id: item.id, component: item.component, props: {project}})}))
    const blocks = shownView ? [] : [
      parts.usage && {id: 'fig:usage', title: t('usage.usage'), aside: t('usage.last7DaysHourlyIncl'), defaultOpen: true, render: () => h(UsageHeatmap, {header: false})},
      ...sections('top'),
      parts.sessionGroups && {id: 'fig:attention', title: t('dynamics.yourAttention'), aside: t('dynamics.sessionsMayAppearInMultiple'), defaultOpen: true, render: () => h(Board, {rows, groups, cards})},
      ...sections('bottom')
    ].filter(Boolean)
    const {isOpen, setOpen, current} = useBlocks(blocks, single, profileState)
    const main = useRef(/** @type {HTMLElement | null} */ (null)), head = useRef(/** @type {HTMLElement | null} */ (null))
    const [inView, setInView] = useState('')
    const index = blocks.length >= 2
    // The sticky heading's height, so a block scrolled to sits below it however the heading wraps.
    useLayoutEffect(() => {
      const node = head.current, root = main.current
      if (!node || !root || typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(() => root.style.setProperty('--fa-head-height', node.offsetHeight + 'px'))
      observer.observe(node)
      return () => observer.disconnect()
    }, [])
    // A personal Profile highlights the block in view: the last whose top passed the heading, the last one at the page end.
    useEffect(() => {
      const root = main.current
      if (!root || single || !index) return
      const update = () => {
        const nodes = blocks.map(block => root.querySelector(`[data-fa-block="${CSS.escape(block.id)}"]`)).filter(Boolean)
        if (!nodes.length) return
        const edge = (head.current?.getBoundingClientRect().bottom ?? root.getBoundingClientRect().top) + 8
        const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 2
        const passed = atEnd ? nodes.at(-1) : nodes.filter(node => node.getBoundingClientRect().top <= edge).at(-1) ?? nodes[0]
        setInView(passed.getAttribute('data-fa-block'))
      }
      update()
      root.addEventListener('scroll', update, {passive: true})
      return () => root.removeEventListener('scroll', update)
    }, [single, index, blocks.map(block => block.id).join('\u0000')])
    const go = block => {
      setOpen(block, true)
      if (!single) setInView(block.id)
      requestAnimationFrame(() => main.current?.querySelector(`[data-fa-block="${CSS.escape(block.id)}"]`)
        ?.scrollIntoView({behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start'}))
    }
    const highlighted = single ? current : inView || blocks[0]?.id
    const showSync = parts.figures || parts.sessionGroups
    // Other plugins' controls at the heading's right end, in registration order.
    const tools = extensions.list('tool').filter(item => item.component)
    // A plugin group, or one of its business plugins, that is off this launch (app/main/external-plugins.ts): one line
    // per reason, naming the package and why, or that the organization has not enabled it.
    const stoppedGroups = [...new Map((profileState?.plugins ?? []).filter(plugin => plugin.group && plugin.reason && !['ready', 'off'].includes(plugin.status))
      .map(plugin => [plugin.reason, plugin.plugin ? `${plugin.group}/${plugin.plugin}` : plugin.group])).entries()]
      // Fig's reasons are 「中文 / English」: the page shows its language's half.
      .map(([text, unit]) => [unit, text.includes(' / ') ? isZh() ? text.slice(0, text.indexOf(' / ')) : text.slice(text.indexOf(' / ') + 3) : text])
    return h('main', {ref: main, 'data-fig-activity': '', 'data-fig-activity-mode': single ? 'single' : 'each', style: {height: '100%', overflow: 'auto', scrollbarGutter: 'stable', boxSizing: 'border-box', color: colors.primary}},
      h('style', null, activityStyle),
      h('div', {className: 'fa-page'},
        h('div', {ref: head, className: 'fa-page-head'},
          h('h1', null, t('dynamics.taskActivity')),
          (index || tools.length > 0) && h('div', {className: 'fa-head-end'},
            index && h('nav', {className: 'fa-index', 'aria-label': t('dynamics.blocksOnThisPage')},
              blocks.map(block => h('button', {key: block.id, type: 'button', 'data-fig-activity-index': block.extension ?? block.id,
                'aria-current': highlighted === block.id ? 'true' : undefined, onClick: () => go(block)}, block.title))),
            tools.length > 0 && h('div', {className: 'fa-head-tools'}, tools.map(item => h('div', {key: item.id, 'data-fig-activity-tool': item.id},
              h(ExtensionBoundary, {id: item.id, component: item.component, props: {}})))))),
        stoppedGroups.map(([group, text]) => h('p', {key: text, role: 'alert', 'data-fig-activity-group-stopped': group, style: {...note, margin: '0 0 16px', color: 'var(--dsw-alias-label-danger, #d33)'}}, text)),
        otherViews.length > 0 && h('div', {role: 'tablist', className: 'fa-views', 'aria-label': t('dynamics.views')},
          [{id: 'default', label: defaultView?.label ?? t('dynamics.overview')}, ...otherViews].map(item => h('button', {key: item.id, type: 'button', role: 'tab',
            'aria-selected': (shownView?.id ?? 'default') === item.id, 'data-fig-activity-view': item.id, onClick: () => setView(item.id)}, item.label))),
        shownView ? h(ExtensionBoundary, {key: shownView.id, id: shownView.id, component: shownView.component, props: {project}}) : h(react.Fragment, null,
        parts.figures && h(Overview, {rows, groups}),
        parts.filter && h('div', {className: 'fa-tools', style: {marginBottom: 20}},
          h('select', {'aria-label': t('dynamics.filterProject'), value: project, onChange: e => setProject(e.target.value), style: button},
            h('option', {value: ''}, t('dynamics.allProjects')), projects.map(w => h('option', {key: w.id, value: w.id}, w.name))),
          action(t('dynamics.markTheseResultsRead'), () => {
            const selected = rows.map(row => ({row, items: row.results})).filter(({items}) => items.length)
            for (const {row, items} of selected) void acknowledge(row, items, 'read')
          }, !rows.some(row => row.results.length))),
        showSync && !value.synced && h('p', {role: 'status', style: note}, t('dynamics.awaitingSyncShowingTheLast')),
        showSync && value.readingHealthy === false && h('p', {role: 'alert', style: note}, t('dynamics.readingStateIsNotSaved')),
        error && h('div', {role: 'alert', style: {position: 'sticky', top: 'var(--fa-head-height, 0px)', zIndex: 2, padding: '10px 14px', background: 'var(--dsw-alias-bg-base, Canvas)'}}, error),
        h(Receipts, {receipts, undo}),
        blocks.map(block => {
          const open = isOpen(block)
          return h('section', {key: block.id, className: 'fa-block' + (block.extension ? ' fa-extension' : ''), 'data-fa-block': block.id,
            'data-fig-activity-section': block.extension, 'data-fig-activity-block': block.extension ? undefined : block.id.slice(4), 'aria-label': block.title},
            h(BlockHead, {block, open, onToggle: () => single && !open ? go(block) : setOpen(block, !open)}),
            open && h('div', {className: 'fa-block-body'}, block.render()))
        }))))
  }

  return {ActivityIcon, ActivityPanel}
}

/** DSH 0.2.2-rc.1 read-only DOM adapter. Uses the native node identity and real viewport hit test.
 * Never marks a card, click promise, process summary or hidden conversation as read. */
function visibleNode(row, item, kind) {
  if (!document.hasFocus() || document.visibilityState !== 'visible') return false
  // Fig's shell-bridge also says which conversation its window shows; other hosts rely on the checks below alone.
  const shown = window[attentionContextGlobal]?.()
  if (shown && shown.sessionId !== row.sessionId) return false
  const conversation = openConversations().find(e => e.getAttribute('data-conversation-session') === row.sessionId)
  if (!conversation) return false
  const key = kind === 'assistant-step' && item.step !== undefined ? `${kind.length}:${kind}${item.turn}:${item.step}` : kind === 'turn-error' ? `${kind.length}:${kind}${item.turn}` : undefined
  if (!key) return false
  for (const element of conversation.querySelectorAll('[data-chat-node-key]')) {
    if (element.getAttribute('data-chat-node-key') !== key || element.getAttribute('data-chat-flow-kind') !== kind || element.getAttribute('data-chat-group-part') === 'reasoning') continue
    if (element.closest('[hidden], [inert], [data-turn-process-hidden="true"]')) continue
    const content = kind === 'assistant-step' ? [...element.querySelectorAll('[data-text-interaction-source], [data-message-attachments]')].find(e => !e.closest('[class*="thinkBody"]')) : element
    if (!content || !content.getClientRects().length || getComputedStyle(content).visibility !== 'visible') continue
    // Its first line, inside the conversation's box and the window, must be what the person sees.
    if (isTopmostWithin(content, {clip: conversation, min: 4, probeTop: 12})) return true
  }
  return false
}
export function installActivity(ctx) {
  if (!ctx.layout?.panelInfo || typeof window.addEventListener !== 'function') return () => {}
  let disposed = false, busy = false
  const refresh = async () => {
    if (busy || disposed) return
    busy = true
    try {
      const value = await call('dynamics'); if (disposed) return
      current = value; publish()
      if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null || !value.synced || value.readingHealthy === false) return
      const foreground = window[windowForegroundGlobal]
      if (typeof foreground === 'function' && await foreground() !== true) return
      for (const row of value.rows) {
        const results = row.results.filter(item => visibleNode(row, item, 'assistant-step')).map(item => item.identity)
        const failures = row.failures.filter(item => !item.known && visibleNode(row, item, 'turn-error')).map(item => item.identity)
        if (results.length) await call('acknowledge', {sessionId: row.sessionId, identities: results, action: 'read', automatic: true})
        if (failures.length) await call('acknowledge', {sessionId: row.sessionId, identities: failures, action: 'known', automatic: true})
      }
    } catch {if (!disposed) {current = {...current, synced: false}; publish()}} finally {busy = false}
  }
  const timer = setInterval(() => {void refresh()}, 1000)
  window.addEventListener('fig:activity-refresh', refresh); void refresh()
  return () => {disposed = true; clearInterval(timer); window.removeEventListener('fig:activity-refresh', refresh); current = {rows: [], workspaces: [], synced: false}; publish()}
}
