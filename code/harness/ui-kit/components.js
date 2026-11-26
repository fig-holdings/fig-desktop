import { isZh } from '../shared/page-locale.js'
import { t } from './client-locale.js'
import {figDanger, figOrange, figOrangeText} from '../shared/brand-colors.js'
import {colors as projectColorTable, icons as projectIconTable} from '../shared/project-appearance.js'

// Fig's shared page pieces, offered to every page plugin as the `figUi` service (client.js): Fig's own panels and
// team plugins draw from here so the same card, figure or icon never drifts between copies. Everything is drawn in
// Fig's own SVG and styled with DSH's theme tokens, so it follows the light and dark themes; no chart or icon library.
// The contract is the exports below: a version keeps their names and props, and only adds.

export const version = 1

/**
 * Colours: DSH theme tokens, plus Fig's accent and status tints that read in both themes. `accent` (Fig orange, one value
 * in both themes) is for fills, rings, heat map steps and focus rings; orange *text* takes `accentText`, the theme's
 * brand text (#b64000 light, #ff8a4c dark, desktop-skin/client-brand.js), since #ff6a1a on the light surfaces is below
 * 3:1. `accentHover` and `onAccent` are an orange fill's hover and the text on it; `accentWash` and `accentLine` the
 * tint and line of a selected or tagged item. Outside Fig the fallbacks apply.
 */
export const tokens = Object.freeze({
  primary: 'var(--dsw-alias-label-primary)', secondary: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l2)', layer: 'var(--dsw-alias-bg-layer-1,transparent)', base: 'var(--dsw-alias-bg-base, Canvas)',
  accent: figOrange, success: '#35a878', danger: figDanger,
  accentText: figOrangeText, accentHover: 'var(--fig-orange-hover, #e85a0c)', onAccent: 'var(--fig-on-orange, #14161b)',
  accentWash: `color-mix(in srgb, ${figOrange} 8%, transparent)`, accentLine: `color-mix(in srgb, ${figOrange} 35%, transparent)`
})

/** Fig's status and navigation glyphs: SVG path data on a 20×20 grid, stroked. */
export const icons = Object.freeze({
  pending: 'M4 5h12v9H9l-5 3V5Z',
  running: 'm7 4 9 6-9 6V4Z',
  result: 'm4 10 4 4 8-8',
  failure: 'm10 3 8 14H2l8-14Zm0 5v4m0 2v.2',
  activity: 'M3 5h14M3 10h10M3 15h12',
  open: 'M8 4h8v8M16 4 5 15',
  check: 'm4 10 4 4 8-8',
  alert: 'M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm0 4v4m0 2.5v.2'
})

/** Status tones: what a tag or icon tint means, the same in every panel. They colour text and glyphs, so accent is accentText. */
export const tones = Object.freeze({neutral: tokens.secondary, accent: tokens.accentText, success: tokens.success, danger: tokens.danger})

/** Token counts in the reader's language: 万／亿 in Chinese, K／M／B otherwise. */
export function formatTokens(value) {
  if (isZh()) {
    if (value >= 1e8) return (value / 1e8).toFixed(2).replace(/\.?0+$/, '') + ' 亿'
    if (value >= 1e4) return (value / 1e4).toFixed(value >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' 万'
    return String(Math.round(value))
  }
  for (const [unit, size] of /** @type {[string, number][]} */ ([['B', 1e9], ['M', 1e6], ['K', 1e3]])) if (value >= size) return (value / size).toFixed(1).replace(/\.0$/, '') + unit
  return String(Math.round(value))
}

/** Default heat map steps: a faint tint of the label colour for empty, then the accent in four soft steps (20/40/60/80%,
 * user 2026-11-21; were 30/52/76/100). The peak stays below full orange so the grid reads calm in both themes. */
export const heatShades = Object.freeze([`color-mix(in srgb, ${tokens.primary} 7%, transparent)`, ...[20, 40, 60, 80].map(p => `color-mix(in srgb, ${tokens.accent} ${p}%, transparent)`)])

export const css = `
.fig-ui-card{border:1px solid ${tokens.border};border-radius:10px;background:${tokens.layer};min-width:0}
.fig-ui-metric{padding:14px 12px}
.fig-ui-label{font-size:12px;color:${tokens.secondary}}
.fig-ui-number{font-size:27px;font-weight:600;font-variant-numeric:tabular-nums;margin:7px 0}
.fig-ui-caption{font-size:11px;color:${tokens.secondary}}
.fig-ui-ring-metric{display:flex;align-items:center;gap:10px}
.fig-ui-ring{position:relative;width:60px;height:60px;flex-shrink:0}
.fig-ui-ring svg{width:60px;height:60px;transform:rotate(-90deg)}
.fig-ui-ring strong{position:absolute;inset:0;display:grid;place-items:center;font-size:22px;font-variant-numeric:tabular-nums}
.fig-ui-group>h3{display:flex;gap:8px;align-items:center;font-size:13px;font-weight:600;margin:0;padding:12px 14px;border-bottom:1px solid ${tokens.border}}
.fig-ui-count{font-size:11px;font-weight:400;color:${tokens.secondary}}
.fig-ui-empty{padding:22px 14px;font-size:12px;color:${tokens.secondary}}
.fig-ui-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:1px 7px;border-radius:999px;font-size:11px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid color-mix(in srgb, currentColor 35%, transparent);background:color-mix(in srgb, currentColor 8%, transparent)}
button.fig-ui-tag{font:inherit;font-size:11px;cursor:pointer}
button.fig-ui-tag:focus-visible{outline:2px solid ${tokens.accent};outline-offset:2px}
`

const styleId = 'fig-ui-kit-style'
/** Puts the shared stylesheet in the page once; returns its removal. */
export function installStyle(doc = document) {
  if (doc.getElementById(styleId)) return () => {}
  const style = doc.createElement('style')
  style.id = styleId
  style.textContent = css
  doc.head.append(style)
  return () => style.remove()
}

/** @param {typeof import('react')} react */
export function components(react) {
  const {createElement: h, useRef, useState} = react
  const join = (...names) => names.filter(Boolean).join(' ')

  /** A glyph from `icons` (or raw path data), stroked in `color`.
   * @param {{name?: string, path?: string, size?: number, color?: string, strokeWidth?: number, label?: string}} props */
  function Icon({name, path, size = 17, color = 'currentColor', strokeWidth = 1.3, label}) {
    return h('svg', {width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
      ...label ? {role: 'img', 'aria-label': label} : {'aria-hidden': true}}, h('path', {d: path ?? (name ? icons[name] : undefined) ?? ''}))
  }
  /** The bordered surface every Fig panel block sits on.
   * @param {{as?: string, className?: string, children?: any, [key: string]: any}} props */
  function Card({as = 'div', className, children, ...rest}) {
    return h(as, {...rest, className: join('fig-ui-card', className)}, children)
  }
  /** One figure: a label, a large number, a caption. */
  function Metric({label, value, caption, className, ...rest}) {
    return h(Card, {...rest, className: join('fig-ui-metric', className)},
      h('div', {className: 'fig-ui-label'}, label), h('div', {className: 'fig-ui-number'}, value), caption != null && h('div', {className: 'fig-ui-caption'}, caption))
  }
  /** A figure with a ring showing `value` of `total`. */
  function RingMetric({value, total, label, caption, color = tokens.accent, className, ...rest}) {
    return h(Card, {...rest, className: join('fig-ui-metric fig-ui-ring-metric', className)},
      h('div', {className: 'fig-ui-ring'},
        h('svg', {viewBox: '0 0 84 84', 'aria-hidden': true},
          h('circle', {cx: 42, cy: 42, r: 35, fill: 'none', stroke: tokens.border, strokeWidth: 6}),
          h('circle', {cx: 42, cy: 42, r: 35, fill: 'none', stroke: color, strokeWidth: 6, strokeDasharray: `${total ? Math.min(1, value / total) * 220 : 0} 220`})),
        h('strong', null, value)),
      h('div', null, h('div', {className: 'fig-ui-label'}, label), caption != null && h('div', {className: 'fig-ui-caption'}, caption)))
  }
  /** A titled list block: icon, title and count in the header; `empty` text when there are no children. */
  function GroupCard({icon, tone = 'neutral', title, count, empty, className, children, ...rest}) {
    const items = react.Children.toArray(children)
    return h(Card, {as: 'section', 'aria-label': typeof title === 'string' ? title : undefined, ...rest, className: join('fig-ui-group', className)},
      h('h3', null, icon && h(Icon, {name: icon, color: tones[tone] ?? tone}), title, count != null && h('span', {className: 'fig-ui-count'}, count)),
      !items.length && empty && h('p', {className: 'fig-ui-empty'}, empty), items)
  }
  /** A short status label; a button when `onClick` is given. */
  function StatusTag({tone = 'neutral', children, onClick, title, ...rest}) {
    return h(onClick ? 'button' : 'span', {...rest, ...onClick ? {type: 'button', onClick} : {}, title, className: join('fig-ui-tag', rest.className), style: {color: tones[tone] ?? tone, ...rest.style}}, children)
  }
  /**
   * A grid of `rows` × `columns` cells, each with a `level` (0…shades.length-1). `rowLabel(row)`, `columnLabel(column)`
   * (empty for no tick) and `cellLabel(row, column)` name them; `tooltip(row, column)` returns what the hover card shows.
   * `cellProps`/`tooltipProps` add attributes (for a caller's own tests or styles); `legend` follows the scale.
   */
  function Heatmap({cells, rowLabel, columnLabel, cellLabel, tooltip, cellProps, tooltipProps, legend, shades = heatShades, rowLabelWidth = 58, tooltipWidth = 240}) {
    const [hover, setHover] = useState(/** @type {{row: number, column: number, left: number, top: number} | null} */ (null))
    const frame = useRef(/** @type {HTMLDivElement | null} */ (null))
    const columns = cells[0]?.length ?? 0
    const enter = (row, column) => event => {
      const box = frame.current?.getBoundingClientRect(), cell = event.currentTarget.getBoundingClientRect()
      if (!box) return
      const left = Math.max(0, Math.min(box.width - tooltipWidth, cell.left - box.left + cell.width / 2 - tooltipWidth / 2))
      setHover({row, column, left, top: cell.bottom - box.top + 6})
    }
    const axis = {color: tokens.secondary, fontSize: 11, lineHeight: '16px', fontVariantNumeric: 'tabular-nums'}
    return h('div', null,
      h('div', {ref: frame, style: {position: 'relative'}, onMouseLeave: () => setHover(null)},
        h('div', {style: {display: 'grid', gridTemplateColumns: `${rowLabelWidth}px repeat(${columns}, minmax(0, 1fr))`, gap: 3, alignItems: 'center'}},
          cells.map((line, row) => [
            h('div', {key: 'label' + row, style: {...axis, fontSize: 12, whiteSpace: 'nowrap'}}, rowLabel(row)),
            line.map((cell, column) => h('div', {key: row + ':' + column, 'data-fig-heatmap-cell': row + ':' + column, 'data-level': cell.level,
              'aria-label': cellLabel?.(row, column), onMouseEnter: enter(row, column), ...cellProps?.(row, column),
              style: {height: 24, borderRadius: 5, background: shades[Math.max(0, Math.min(shades.length - 1, cell.level))],
                outline: hover?.row === row && hover?.column === column ? '1.5px solid ' + tokens.primary : 'none', outlineOffset: 1}}))
          ]),
          h('div', {key: 'axis-pad'}),
          Array.from({length: columns}, (_, column) => h('div', {key: 'axis' + column, style: axis}, columnLabel(column)))),
        hover && tooltip && h('div', {role: 'tooltip', ...tooltipProps, style: {
          position: 'absolute', left: hover.left, top: hover.top, width: tooltipWidth, boxSizing: 'border-box', zIndex: 2, pointerEvents: 'none',
          padding: '10px 12px', borderRadius: 10, fontSize: 13, lineHeight: '20px', color: tokens.primary,
          background: 'var(--dsw-alias-bg-layer-1, Canvas)', border: '.5px solid ' + tokens.border, boxShadow: '0 8px 24px rgba(0,0,0,.18)'}}, tooltip(hover.row, hover.column))),
      h('div', {style: {fontSize: 13, lineHeight: '20px', color: tokens.secondary, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 10}},
        t('components.less'), shades.map((shade, i) => h('span', {key: i, style: {width: 14, height: 14, borderRadius: 3, background: shade}})), t('components.more'), legend))
  }
  return {Icon, Card, Metric, RingMetric, GroupCard, StatusTag, Heatmap}
}

/** Project navigation's icons (name → path, viewBox 0 0 24 24, stroke 1.6) and colours (name → [light, dark]), read-only, from
 * the same table the sidebar uses, so a team project looks like a local one. */
export const projectIcons = Object.freeze({...projectIconTable})
export const projectColors = Object.freeze(Object.fromEntries(Object.entries(projectColorTable).map(([name, pair]) => [name, Object.freeze([...pair])])))

/** The `figUi` service value for one React instance. */
export function figUi(react) {
  return Object.freeze({version, tokens, icons, tones, heatShades, formatTokens, css, projectIcons, projectColors, ...components(react)})
}
