import { useStore } from '../shared/page-client.js'
import { pageAttributes } from '../shared/page-contract.ts'
import { t } from './client-locale.js'
import { languageIcon } from './account-language-icons.js'
import { figLocales } from './client-languages.js'

const { coworkTrigger } = pageAttributes

// The upstream AccountMenu is bound to DeepSeek, and is disabled in team Profiles.
// Use its settings.launcher slot and the same native Menu, including native nested navigation.
export function installEdition(ctx, react, primitives, profile, openSettings) {
  const { createElement: h, useEffect, useRef, useState } = react
  const { Menu, IconUserOutlineMedium, IconEllipsisOutlineMedium, IconSettingsOutlineMedium,
    IconLightOutlineMedium, IconDarkOutlineMedium, IconFollowsystemOutlineMedium, IconGlobeOutlineMedium,
    IconLayersOutlineMedium, IconPaperPlaneOutlineMedium, IconShieldOutlineMedium, IconUsersOutlineMedium } = primitives
  const bridge = globalThis.__FIG_EDITION__
  if (!bridge) return () => {}
  ctx.provide('figTeamAccount', Object.freeze({ version: 1,
    removeDevice: () => bridge.action('removeDevice')
  }))
  const icon = component => h(component, { size: 16, 'aria-hidden': true })
  const themeIcons = { light: IconLightOutlineMedium, dark: IconDarkOutlineMedium, system: IconFollowsystemOutlineMedium }
  function Launcher({ wide, team, settingsShortcut }) {
    const [state, setState] = useState(/** @type {import('../../app/shared/protocol').EditionState | undefined} */ (undefined))
    const [open, setOpen] = useState(false)
    const [status, setStatus] = useState(/** @type {'edition.unavailable' | 'edition.failed' | undefined} */ (undefined))
    const trigger = useRef(/** @type {HTMLButtonElement | null} */ (null))
    const locale = useStore(react, ctx.locale, ctx.locale.getSnapshot())
    useEffect(() => {
      let active = true
      const update = next => { if (active) setState(next) }
      const unsubscribe = bridge.subscribe(update)
      void bridge.read().then(update).catch(() => {})
      return () => { active = false; unsubscribe() }
    }, [])
    if (!team && !state?.available) return null
    const name = state?.name?.trim()
    const teamLabel = state?.organization ? t('edition.team') + ' · ' + state.organization : t('edition.team')
    const label = team ? name || t('edition.login') : t('edition.switchEdition')
    const chinese = locale.locales.find(item => item.id === figLocales[0])?.id
    const versionItems = [
      { id: 'personal', label: t('edition.personal'), icon: icon(IconUserOutlineMedium), disabled: !team || !state?.available },
      { id: 'team', label: teamLabel, icon: icon(IconUsersOutlineMedium), disabled: team && Boolean(name) }
    ]
    const items = team ? [
      { id: 'settings', label: t('edition.settings'), icon: icon(IconSettingsOutlineMedium), shortcut: settingsShortcut },
      { id: 'appearance', label: t('more-menu.appearance'), icon: icon(IconLightOutlineMedium), submenu: [
        { id: 'light', label: t('more-menu.light'), icon: icon(themeIcons.light) },
        { id: 'dark', label: t('more-menu.dark'), icon: icon(themeIcons.dark) },
        { id: 'system', label: t('more-menu.system'), icon: icon(themeIcons.system) }
      ] },
      { id: 'language', label: t('more-menu.language'), icon: icon(IconGlobeOutlineMedium), submenu: [
        { id: 'zh', label: t('more-menu.chinese'), icon: languageIcon(h, 'zh'), disabled: !chinese },
        { id: 'en', label: t('more-menu.english'), icon: languageIcon(h, 'en'), disabled: !locale.locales.some(item => item.id === 'en') }
      ] },
      { id: 'version', label: t('edition.version'), icon: icon(IconLayersOutlineMedium), submenu: versionItems },
      { type: 'separator', id: 'account-divider' },
      ...name && state?.adminConsoleUrl ? [{ id: 'admin', label: t('edition.admin'), icon: icon(IconShieldOutlineMedium) }] : [],
      { id: 'feedback', label: t('edition.feedback'), icon: icon(IconPaperPlaneOutlineMedium) },
      name ? { id: 'signOut', label: t('edition.signOut'), icon: h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M7 2H3v12h4m2-9 3 3-3 3M6 8h6', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' })) }
        : { id: 'login', label: t('edition.login'), icon: icon(IconUserOutlineMedium) }
    ] : versionItems
    return h('div', { 'data-fig-edition': team ? 'team' : 'personal', title: team && state?.organization ? `${label} · ${state.organization}` : undefined },
      h(Menu, {
        open, side: 'top', portal: true, autoFocus: true, items, anchorRef: trigger,
        className: team ? 'fig-cowork-anchor' : undefined,
        listClassName: team ? 'fig-cowork-menu' : undefined,
        submenuBackLabel: t('edition.back'), onClose: () => setOpen(false),
        selectedIds: team ? [ctx.theme.getTheme().preference, locale.active === chinese ? 'zh' : locale.active, 'team'] : undefined,
        anchor: h('button', { type: 'button', ref: trigger, title: team ? undefined : label,
          [coworkTrigger]: team ? (name ? 'signed-in' : 'signed-out') : undefined,
          'data-collapsed': !wide, 'aria-label': team && name ? t('edition.account') : label,
          'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => { setStatus(undefined); setOpen(value => !value) } },
        team ? (name ? h('span', { className: 'fig-cowork-avatar', 'aria-hidden': true }, Array.from(name)[0]?.toUpperCase()) : icon(IconUserOutlineMedium))
          : icon(IconEllipsisOutlineMedium),
        team && wide && h('span', { className: 'fig-cowork-name' }, h('span', null, label), state?.organization && h('small', null, state.organization))),
        onSelect(id) {
          setOpen(false)
          if (id === 'settings') { trigger.current?.focus(); openSettings(ctx); return }
          if (id === 'light' || id === 'dark' || id === 'system') { ctx.theme.setTheme(id); return }
          if (id === 'zh' || id === 'en') { if (id === 'en' || chinese) ctx.locale.setLocale(id === 'en' ? id : chinese); return }
          if (id === 'feedback') {
            // Use the native feedback form without sending Cowork identity or device data.
            const url = /** @type {{ contactFormUrl?: string } | undefined} */ (globalThis.__DSH_CONTACT_CONFIG__)?.contactFormUrl
              || 'https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'
            window.open(url, '_blank', 'noopener,noreferrer')
            return
          }
          if (id === 'admin') {
            if (state?.adminConsoleUrl) window.open(state.adminConsoleUrl, '_blank', 'noopener,noreferrer')
            return
          }
          if (id !== 'personal' && id !== 'team' && id !== 'login' && id !== 'signOut') return
          if (!state?.available) { setStatus('edition.unavailable'); return }
          void bridge.action(id === 'login' ? 'team' : id).catch(() => setStatus('edition.failed'))
        }
      }),
      status && h('span', { role: 'status', className: 'fig-cowork-status' }, t(status)))
  }
  const disposeFooter = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'fig-edition-switch', order: 80
  }, () => useStore(react, profile, undefined)?.edition === 'personal' ? h(Launcher, { team: false, wide: false }) : null))
  let active = true
  let disposeTeam
  void profile.ready.then(value => {
    if (!active || value?.edition !== 'team') return
    disposeTeam = ctx.slots.inject('settings.launcher', () => ctx.slots.register({
      name: 'settings.launcher', id: 'fig-cowork-account'
    }, ({ wide, settingsShortcut }) => h(Launcher, { wide, team: true, settingsShortcut })))
  })
  const style = document.createElement('style')
  style.textContent = `
    [data-fig-edition]{min-width:0;color:var(--dsw-alias-label-primary)}
    [data-fig-edition="team"] .fig-cowork-anchor{display:block;width:100%;min-width:0}
    [data-fig-edition] button[aria-haspopup="menu"]{max-width:100%;display:flex;align-items:center;gap:8px;border:0;background:transparent;color:inherit;font:inherit;border-radius:var(--dsw-radius-md);padding:4px 7px;min-height:32px;cursor:pointer}
    [data-fig-edition="personal"] button[aria-haspopup="menu"]:hover{background:var(--dsw-alias-interactive-bg-hover)}
    [data-fig-edition] button[${coworkTrigger}]{width:100%;height:44px;padding:6px 8px;font-size:14px;text-align:start}
    [data-fig-edition] button[${coworkTrigger}="signed-out"]{height:32px}
    [data-fig-edition] button[${coworkTrigger}][data-collapsed="true"]{width:36px;height:36px;padding:0;justify-content:center}
    [data-fig-edition] button[${coworkTrigger}] > svg{flex:none}
    .fig-cowork-avatar{width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--dsw-alias-bg-skeleton);flex:none}
    .fig-cowork-name{display:grid;min-width:0;line-height:18px}
    .fig-cowork-name > *{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fig-cowork-name small,.fig-cowork-status{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:14px}
    .fig-cowork-status{display:block;overflow-wrap:anywhere;padding-inline:8px}
  `
  document.head.append(style)
  return () => { active = false; disposeFooter?.(); disposeTeam?.(); style.remove() }
}
