import { t } from './client-locale.js'
import { languageIconMarkup } from './account-language-icons.js'
import { figLocales } from './client-languages.js'
import { watchPage } from '../shared/page-observer.js'

// 主题外观 and 界面语言 in the sidebar's account menu, as in Codex. DSH's account plugin builds that
// menu from a fixed item list with no extension slot, and the shared Menu component cannot be
// wrapped (its module is frozen), so this is a local DOM adaptation of DSH 0.2.2: when the
// menu opens (recognised by 设置 with its ⌥⌘, shortcut as the first item), two rows styled with the menu's
// own classes go in after 设置, each with a flyout of choices. Choices call DSH's theme and locale
// services, the same calls as 通用设置. The flyout acts on pointerdown, since DSH closes the menu on
// any pointerdown outside it. Covered by tests/more-menu-smoke.mjs.
const accountTrigger = '[data-slot="sidebar"] [data-slot="settings.launcher"] button[data-signed-out]'
const moreIcon = '#dsw-icon-ellipsis-outline-medium'
const signInIcon = '#dsw-icon-user-outline-medium'

/** The signed-out account trigger reads 登录 with a person icon; `restore` puts DSH's own label back. */
function signInTrigger(ctx) {
  const accountText = ctx.locale.bind('settings.account')
  // Keep DSH's button and menu handlers. Only change the signed-out trigger's presentation.
  function labelAccountTrigger() {
    const trigger = document.querySelector(accountTrigger)
    if (!trigger) return
    if (trigger.getAttribute('data-signed-out') === 'true') {
      const label = accountText('signIn')
      if (trigger.getAttribute('data-fig-sign-in') !== label) trigger.setAttribute('data-fig-sign-in', label)
      if (trigger.getAttribute('aria-label') !== label) trigger.setAttribute('aria-label', label)
      const icon = trigger.querySelector(':scope > svg > use')
      if (icon?.getAttribute('href') === moreIcon) icon.setAttribute('href', signInIcon)
    } else {
      restoreAccountLabel(trigger)
    }
  }

  function restoreAccountLabel(trigger = document.querySelector(accountTrigger)) {
    if (!trigger?.hasAttribute('data-fig-sign-in')) return
    trigger.removeAttribute('data-fig-sign-in')
    trigger.setAttribute('aria-label', accountText('menu'))
    const icon = trigger.querySelector(':scope > svg > use')
    if (icon?.getAttribute('href') === signInIcon) icon.setAttribute('href', moreIcon)
  }

  return { labelAccountTrigger, restoreAccountLabel }
}

/** The 主题外观 and 界面语言 rows with their flyouts, added once to each account menu `extend` is given. */
function preferenceRows(ctx) {
  // Icons come from DSH's sprite.
  const svg = name => document.getElementById('dsw-icon-' + name)
    ? `<svg width="16" height="16" aria-hidden="true"><use href="#dsw-icon-${name}"></use></svg>`
    : ''
  const groups = () => [
    { id: 'theme', label: t('more-menu.appearance'), icon: 'light-outline-medium', current: ctx.theme.getTheme().preference,
      choose: id => ctx.theme.setTheme(id),
      choices: [['light', t('more-menu.light'), 'light-outline-medium'], ['dark', t('more-menu.dark'), 'dark-outline-medium'],
        ['system', t('more-menu.system'), 'followsystem-outline-medium']] },
    { id: 'locale', label: t('more-menu.language'), icon: 'globe-outline-medium', current: ctx.locale.getSnapshot().active,
      choose: id => ctx.locale.setLocale(id), choices: figLocales.filter(id => ctx.locale.getSnapshot().locales.some(item => item.id === id))
         .map(id => [id, t(id === 'zh' ? 'more-menu.chinese' : 'more-menu.english')]) }
  ]
  let flyout
  const closeFlyout = () => { flyout?.remove(); flyout = undefined }

  function row(template, group, menu) {
    const wrap = template.parentElement.cloneNode(false)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = template.className
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-haspopup', 'menu')
    button.dataset.figMore = group.id
    const [iconClass, labelClass] = [...template.children].map(child => child.className)
    button.innerHTML = `<span aria-hidden="true" class="${iconClass}">${svg(group.icon)}</span><span class="${labelClass}"></span>`
      + `<span aria-hidden="true" style="margin-left:auto;display:flex">${svg('chevron-right-outline-medium')}</span>`
    button.children[1].textContent = group.label
    const open = () => openFlyout(button, group, menu, iconClass, labelClass)
    button.addEventListener('mouseenter', open)
    button.addEventListener('focus', open)
    button.addEventListener('click', open)
    wrap.append(button)
    return wrap
  }

  function openFlyout(anchor, group, menu, iconClass, labelClass) {
    if (flyout?.dataset.figMore === group.id) return
    closeFlyout()
    flyout = menu.cloneNode(false)
    flyout.removeAttribute('style')
    flyout.dataset.figMore = group.id
    const material = menu.firstElementChild?.cloneNode(false)
    const list = menu.querySelector('[role="presentation"]')?.cloneNode(false) ?? document.createElement('div')
    if (material) flyout.append(material)
    flyout.append(list)
    for (const [id, label, icon] of group.choices) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = anchor.className
      button.setAttribute('role', 'menuitemradio')
      button.setAttribute('aria-checked', String(id === group.current))
      const glyph = group.id === 'locale' ? languageIconMarkup(id) : icon ? svg(icon) : ''
      button.innerHTML = (glyph ? `<span aria-hidden="true" class="${iconClass}">${glyph}</span>` : '') + `<span class="${labelClass}"></span>`
        + `<span aria-hidden="true" style="margin-left:auto;display:flex;padding-left:16px;color:var(--dsw-alias-state-business-primary);visibility:${id === group.current ? 'visible' : 'hidden'}">${svg('check-outline-medium')}</span>`
      button.children[glyph ? 1 : 0].textContent = label
      button.addEventListener('pointerdown', event => { event.preventDefault(); group.choose(id); closeFlyout() })
      button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); group.choose(id); closeFlyout() } })
      const wrap = anchor.parentElement.cloneNode(false)
      wrap.append(button)
      list.append(wrap)
    }
    const menuBox = menu.getBoundingClientRect()
    const rowBox = anchor.getBoundingClientRect()
    Object.assign(flyout.style, { position: 'fixed', left: menuBox.right + 6 + 'px', top: '0px', zIndex: 2147483000, minWidth: '180px', maxHeight: innerHeight - 16 + 'px' })
    document.body.append(flyout)
    // Level with the row, kept inside the window.
    flyout.style.top = Math.max(8, Math.min(rowBox.top - 6, innerHeight - 8 - flyout.offsetHeight)) + 'px'
  }

  function extend(menu) {
    if (menu.dataset.figMore !== undefined) return
    const settings = menu.querySelector('button[role="menuitem"][aria-keyshortcuts$="Meta+,"]')
    if (!settings || settings.parentElement?.parentElement?.firstElementChild !== settings.parentElement) return
    menu.dataset.figMore = ''
    const separator = document.createElement('div')
    separator.setAttribute('role', 'separator')
    separator.style.cssText = 'height:.5px;margin:4px 10px;background:var(--dsw-alias-border-l3)'
    settings.parentElement.after(...groups().map(group => row(settings, group, menu)), separator)
    // Other rows close the flyout, as a submenu would.
    for (const other of menu.querySelectorAll('button[role="menuitem"]:not([data-fig-more])')) other.addEventListener('mouseenter', closeFlyout)
  }

  return { extend, closeFlyout, hasFlyout: () => flyout !== undefined }
}

export function extendMoreMenu(ctx) {
  if (!ctx.theme || !ctx.locale) return () => {}
  const { labelAccountTrigger, restoreAccountLabel } = signInTrigger(ctx)
  const { extend, closeFlyout, hasFlyout } = preferenceRows(ctx)
  // Both before paint: the trigger never shows DSH's own look, and rows go in as the menu opens or closes with it.
  const stopTrigger = watchPage({ name: 'account trigger', timing: 'sync', childList: true, attributes: ['data-signed-out', 'aria-label'],
    within: '[data-slot="sidebar"]', run: labelAccountTrigger })
  const stopMenus = watchPage({ name: 'account menu rows', timing: 'sync', childList: true, within: '[role="menu"]', ignore: null, run: () => {
    for (const menu of document.querySelectorAll('[role="menu"][data-menu-material]:not([data-fig-more], .fig-cowork-menu)')) extend(menu)
    if (hasFlyout() && !document.querySelector('[role="menu"][data-fig-more=""]')) closeFlyout()
  } })
  const unsubscribe = ctx.locale.subscribe(labelAccountTrigger)
  labelAccountTrigger()
  return () => { stopTrigger(); stopMenus(); unsubscribe(); restoreAccountLabel(); closeFlyout() }
}
