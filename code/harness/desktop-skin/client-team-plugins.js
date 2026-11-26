import { useStore } from '../shared/page-client.js'
import { t } from './client-locale.js'
import { isZh } from '../shared/page-locale.js'

// 插件页「协作版插件」页签 (team Profiles only). The organization's plugin group in two
// parts: 协作版基础能力 (the base layer, one card, always on) and 业务插件 (one card per business plugin, on as the
// organization set it). Members switch nothing here: each switch shows the state and says why it cannot be changed. A
// card opens its detail: the packages it contains, each with version, signature and status. Rows and detail follow the
// look of DSH's bundle list and detail, drawn here because DSH 0.2.2-rc.5 does not export those components.

/** One unit's packages → its state: on, the organization has not enabled it, or off with the first reason. */
export function unitState(packages) {
  if (packages.length && packages.every(item => item.status === 'ready')) return { on: true }
  const disabled = packages.find(item => item.status === 'disabled')
  if (disabled) return { on: false, disabled: true, off: disabled.unavailable?.off ?? 'tenant', reason: disabled.reason }
  const off = packages.find(item => item.status !== 'ready')
  return { on: false, reason: off?.reason }
}

/** The team group's base layer and business plugins, from the Profile's plugin states. */
export function teamUnits(plugins = []) {
  const members = plugins.filter(item => item.group)
  const base = members.filter(item => !item.plugin)
  const business = new Map()
  for (const item of members) if (item.plugin) {
    const unit = business.get(item.plugin) ?? { id: item.plugin, title: item.pluginTitle ?? item.plugin, packages: [] }
    if (item.pluginTitle) unit.title = item.pluginTitle
    unit.packages.push(item)
    business.set(item.plugin, unit)
  }
  return { group: members[0]?.group, base, business: [...business.values()] }
}

const shortName = name => name?.replace(/^@[^/]+\//, '') ?? ''
/** Fig's reasons are 「中文 / English」 (app/main/external-plugins.ts reason()): the page shows its language's half. */
export const localReason = (text, zh = isZh()) => {
  const at = text?.indexOf(' / ') ?? -1
  return at < 0 ? text : zh ? text.slice(0, at) : text.slice(at + 3)
}

export const teamPluginsCss = `
[data-fig-team-plugins] h2{margin:24px 0 4px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary)}
[data-fig-team-plugins] h2:first-child{margin-top:0}
[data-fig-team-bundle]{display:flex;align-items:center;gap:16px;padding:18px 0;min-width:0}
[data-fig-team-bundle]+[data-fig-team-bundle]{border-top:.5px solid var(--dsw-alias-border-l2)}
[data-fig-team-bundle]>button{flex:1;min-width:0;border:0;background:transparent;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer}
[data-fig-team-bundle]>button:focus-visible,[data-fig-team-detail] button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:4px}
.fig-team-icon{width:48px;height:48px;flex:none;display:grid;place-items:center;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;color:var(--dsw-alias-label-secondary)}
.fig-team-icon.is-small{width:32px;height:32px;border-radius:10px}
.fig-team-name{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-weight:500;font-size:16px}
.fig-team-tag{font-size:11px;font-weight:400;line-height:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary)}
.fig-team-line{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fig-team-reason{margin:6px 0 0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-danger,#d33);overflow-wrap:anywhere}
.fig-team-lock{display:inline-flex}
[data-fig-team-detail] .fig-team-back{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;padding:0;margin-bottom:16px;cursor:pointer}
[data-fig-team-detail] header{display:flex;align-items:center;justify-content:space-between;gap:16px}
[data-fig-team-detail] code,[data-fig-team-component] code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
[data-fig-team-detail] hr{border:0;border-top:.5px solid var(--dsw-alias-border-l2);margin:20px 0 12px}
[data-fig-team-component]{display:flex;align-items:center;gap:12px;padding:12px 0;min-width:0}
[data-fig-team-component]>div{flex:1;min-width:0}
[data-fig-team-component] strong{font-weight:500}
[data-fig-team-component] p{margin:2px 0;font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fig-team-dot{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary)}
.fig-team-dot::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}
.fig-team-dot[data-status="ready"]{color:#1f9d55}
.fig-team-dot[data-status="failed"],.fig-team-dot[data-status="suspended"]{color:var(--dsw-alias-label-danger,#d33)}
`

const bundleGlyph = 'M9 3H4v6h2a3 3 0 0 1 0 6H4v5h5v-2a3 3 0 0 1 6 0v2h5v-5h-2a3 3 0 0 1 0-6h2V3h-5v2a3 3 0 0 1-6 0Z'

/** @param {typeof import('react')} react */
export function teamPluginsTab(react, { Switch }, profile) {
  const { createElement: h, useState } = react
  const icon = small => h('span', { className: 'fig-team-icon' + (small ? ' is-small' : ''), 'aria-hidden': true },
    h('svg', { width: small ? 16 : 24, height: small ? 16 : 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }, h('path', { d: bundleGlyph })))
  // Highest priority first: 平台已暂停 > 未订阅 > 组织未启用.
  const offTag = /** @type {const} */ ({ platform: 'team-plugins.platformPaused', unsubscribed: 'team-plugins.unsubscribed', tenant: 'team-plugins.notEnabled' })
  const statusKey = /** @type {const} */ ({ ready: 'team-plugins.status.ready', failed: 'team-plugins.status.failed', suspended: 'team-plugins.status.failed',
    off: 'team-plugins.status.off', disabled: 'team-plugins.status.disabled' })
  const statusText = item => t(statusKey[item.status] ?? statusKey.failed)

  function Lock({ label, state, why }) {
    // The switch is the organization's: it shows the state and is never operable here.
    return h('span', { className: 'fig-team-lock', title: why },
      h(Switch, { label, checked: state.on, disabled: true, onChange: () => {} }))
  }

  function units(state) {
    const { base, business } = teamUnits(state?.plugins)
    const baseUnit = { id: 'base', title: t('team-plugins.base'), packages: base, base: true }
    return { baseUnit, business }
  }

  function tags(unit, state) {
    return [unit.base ? t('team-plugins.required') : t('team-plugins.business'), t('team-plugins.fromOrganization'),
      ...state.disabled ? [t(offTag[state.off] ?? offTag.tenant)] : []]
  }

  function Bundle({ unit, onOpen }) {
    const state = unitState(unit.packages)
    const why = unit.base ? t('team-plugins.baseLocked') : t('team-plugins.businessLocked')
    return h('div', { 'data-fig-team-bundle': unit.id, 'data-fig-team-bundle-on': String(state.on) },
      icon(false),
      h('button', { type: 'button', onClick: () => onOpen(unit.id) },
        h('span', { className: 'fig-team-name' }, unit.title, tags(unit, state).map(tag => h('span', { key: tag, className: 'fig-team-tag' }, tag))),
        h('p', { className: 'fig-team-line' }, unit.base ? t('team-plugins.baseLine') : t('team-plugins.businessLine', { count: unit.packages.length })),
        !state.on && state.reason && h('p', { className: 'fig-team-reason', role: 'alert' }, localReason(state.reason))),
      h(Lock, { label: unit.title, state, why }))
  }

  function Detail({ unit, onBack }) {
    const state = unitState(unit.packages)
    const ready = unit.packages.filter(item => item.status === 'ready').length
    return h('div', { 'data-fig-team-detail': unit.id },
      h('button', { type: 'button', className: 'fig-team-back', onClick: onBack }, '‹ ' + t('team-plugins.back')),
      h('header', null, icon(false), h(Lock, { label: unit.title, state, why: unit.base ? t('team-plugins.baseLocked') : t('team-plugins.businessLocked') })),
      h('div', { className: 'fig-team-name', style: { marginTop: 12 } }, unit.title, tags(unit, state).map(tag => h('span', { key: tag, className: 'fig-team-tag' }, tag))),
      h('code', null, `${unit.packages[0]?.group ?? ''} · ${unit.base ? 'base' : unit.id}`),
      h('p', { className: 'fig-team-line', style: { whiteSpace: 'normal' } }, unit.base ? t('team-plugins.baseLine') : t('team-plugins.businessLine', { count: unit.packages.length })),
      !state.on && state.reason && h('p', { className: 'fig-team-reason', role: 'alert' }, localReason(state.reason)),
      h('hr'),
      h('h2', null, t('team-plugins.components', { count: unit.packages.length, ready })),
      unit.packages.map(item => h('div', { key: item.name ?? item.origin, 'data-fig-team-component': item.name ?? item.origin },
        icon(true),
        h('div', null,
          h('strong', { style: { display: 'block' } }, shortName(item.name) || item.origin),
          item.description && h('p', null, item.description),
          h('code', { style: { display: 'block' } }, [item.name ?? item.origin, item.version, item.source === 'directory' ? t('team-plugins.unsigned') : item.version ? t('team-plugins.signed') : t('team-plugins.notVerified')].filter(Boolean).join(' · ')),
          item.status !== 'ready' && item.reason && item.reason !== state.reason && h('p', { className: 'fig-team-reason' }, localReason(item.reason))),
        h('span', { className: 'fig-team-dot', 'data-status': item.status }, statusText(item)))))
  }

  return function TeamPlugins() {
    const state = useStore(react, profile, undefined)
    const [open, setOpen] = useState(/** @type {string | null} */ (null))
    if (!state) return h('p', { role: 'status' }, t('team-plugins.loading'))
    const { baseUnit, business } = units(state)
    if (!baseUnit.packages.length && !business.length) return h('p', null, t('team-plugins.none'))
    const shown = open === 'base' ? baseUnit : business.find(unit => unit.id === open)
    return h('div', { 'data-fig-team-plugins': '' },
      shown ? h(Detail, { unit: shown, onBack: () => setOpen(null) }) : h(react.Fragment, null,
        h('p', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 14, margin: '0 0 12px' } }, t('team-plugins.intro')),
        baseUnit.packages.length > 0 && h('h2', null, t('team-plugins.base')),
        baseUnit.packages.length > 0 && h(Bundle, { unit: baseUnit, onOpen: setOpen }),
        business.length > 0 && h('h2', null, t('team-plugins.businessHeading')),
        business.map(unit => h(Bundle, { key: unit.id, unit, onOpen: setOpen }))))
  }
}
