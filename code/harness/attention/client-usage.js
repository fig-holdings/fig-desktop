import { isZh } from '../shared/page-locale.js'
import {colors, note} from '../shared/page-ui.js'
import { t } from './client-locale.js'
import {pageRpc} from '../shared/page-rpc.js'

// The 7×24 token heat map at the top of Task activity. Data comes from fig-attention's `usage`
// endpoint, polled only while someone reads it (the heat map, or a plugin through figActivity v2's `usage`); the grid,
// scale and hover card are figUi's Heatmap (ui-kit).
const call = pageRpc('/fig-attention', { unavailable: () => t('usage.unavailable'), failed: () => t('usage.readFailed') })

/**
 * The usage view as a store: `get()` is the last view (null until the first read), the same object until the data
 * changes; `error()` the last read's failure. Reads every 30 seconds (2 while the history loads) while subscribed.
 */
export function usageStore() {
  const listeners = new Set()
  let state = {view: null, error: '', text: ''}, timer, running = false
  const set = next => { state = next; for (const listener of listeners) listener() }
  async function load() {
    let next = 30_000
    try {
      const value = await call('usage'); if (!running) return
      const text = JSON.stringify(value)
      if (text !== state.text || state.error) set({view: text === state.text ? state.view : value, error: '', text})
      if (value.loading) next = 2000
    } catch (e) { if (running) set({...state, error: e instanceof Error ? e.message : t('usage.couldNotReadUsage')}) }
    if (running) timer = setTimeout(load, next)
  }
  return {
    get: () => state.view,
    error: () => state.error,
    /** For React: changes whenever the view or the error does. */
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      if (!running) { running = true; void load() }
      return () => { listeners.delete(listener); if (!listeners.size) { running = false; clearTimeout(timer) } }
    }
  }
}
const weekday = day => isZh() ? '日一二三四五六'[new Date(day).getDay()] : new Date(day).toLocaleDateString('en-US', {weekday: 'short'})
const date = day => { const d = new Date(day); return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

/** @param {typeof import('react')} react @param {any} ui the figUi service */
export function usageComponents(react, ui, store) {
  const {createElement: h, useSyncExternalStore} = react
  const {formatTokens, Heatmap} = ui
  function Shares({title, items, other}) {
    if (!items.length) return null
    return h('div', {style: {marginTop: 8}},
      h('div', {style: {color: colors.secondary, fontSize: 12, marginBottom: 2}}, title),
      items.map(item => h('div', {key: item.name || '\u0000', style: {display: 'flex', justifyContent: 'space-between', gap: 16}},
        h('span', {style: {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}, item.name || other),
        h('span', {style: {fontVariantNumeric: 'tabular-nums'}}, formatTokens(item.total)))))
  }
  function Tooltip({view, row, hour}) {
    const cell = view.cells[row][hour], day = view.days[row]
    const line = (label, value) => h('div', {style: {display: 'flex', justifyContent: 'space-between', gap: 16}}, h('span', null, label), h('span', {style: {fontVariantNumeric: 'tabular-nums'}}, formatTokens(value)))
    return h(react.Fragment, null,
      h('div', {style: {fontWeight: 600, marginBottom: 4}}, `${date(day)} ${weekday(day)} ${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00`),
      cell.total ? [
        h('div', {key: 'total', style: {display: 'flex', justifyContent: 'space-between', fontWeight: 600}}, h('span', null, t('usage.total')), h('span', null, formatTokens(cell.total))),
        h('div', {key: 'split', style: {color: colors.secondary, fontSize: 12}}, line(t('usage.input'), cell.input), line(t('usage.cache'), cell.cache), line(t('usage.output'), cell.output)),
        h(Shares, {key: 'projects', title: t('usage.projects'), items: cell.projects, other: t('usage.otherProjects')}),
        h(Shares, {key: 'models', title: t('usage.models'), items: cell.models, other: t('usage.otherModels')})
      ] : h('div', {style: {color: colors.secondary}}, t('usage.noUsage')),
      cell.unmetered > 0 && h('div', {style: {color: colors.secondary, fontSize: 12, marginTop: 8}}, t(cell.unmetered === 1 ? 'usage.callsWithoutUsage.one' : 'usage.callsWithoutUsage.other', { count: cell.unmetered })))
  }
  /** `header` false: the block around it (Task activity's fold heading) shows the title. */
  function UsageHeatmap({header = true}) {
    const {view, error} = useSyncExternalStore(store.subscribe, store.snapshot)
    return h('section', {'aria-label': t('usage.usage'), 'data-fig-usage': '', style: {marginBottom: 28}},
      header && h('div', {style: {display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12}},
        h('h2', {style: {fontSize: 15, fontWeight: 600, margin: 0}}, t('usage.usage')),
        h('span', {style: note}, t('usage.last7DaysHourlyIncl'))),
      error && h('p', {role: 'alert', style: note}, error),
      view && h(Heatmap, {
        cells: view.cells,
        rowLabel: row => date(view.days[row]) + ' ' + weekday(view.days[row]),
        columnLabel: hour => hour % 6 === 0 ? hour : '',
        cellLabel: (row, hour) => `${date(view.days[row])} ${hour}:00 ${formatTokens(view.cells[row][hour].total)}`,
        cellProps: (row, hour) => ({'data-fig-usage-cell': row + ':' + hour}),
        tooltipProps: {'data-fig-usage-tooltip': ''},
        tooltip: (row, hour) => h(Tooltip, {view, row, hour}),
        legend: [
          h('span', {key: 'peak'}, ' · ' + t('usage.peakHour') + formatTokens(view.peak) + ' · ' + t('usage.7DayTotal') + formatTokens(view.total)),
          view.loading && h('span', {key: 'loading', role: 'status'}, ' · ' + t('usage.readingTheLast7Days')),
          view.failed && !view.loading && h('span', {key: 'failed', role: 'status'}, ' · ' + t('usage.someSessionsCouldNotBe'))
        ]
      }))
  }
  return {UsageHeatmap}
}
