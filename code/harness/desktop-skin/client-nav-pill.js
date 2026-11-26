import { watchPage } from '../shared/page-observer.js'

// Team Profiles only: the sidebar's current item
// is drawn by one pill that slides from the old item to the new one, like Cowork's admin and ops consoles. DSH 0.2.2-rc.5
// paints the current entry itself (`._panelEntryActive`); with the pill shown that fill is cleared, so only the pill
// moves. 240ms, cubic-bezier(.22, 1, .36, 1), transform only (the size is set at once). Hidden while no entry is current
// (new or opened conversation); appearing from hidden, a resize or reduced motion place it without playing. Workspace
// session rows only change colour (navPillCss). Local adaptation on DSH's sidebar classes; remove once DSH slides itself.
export const navPillCss = `
:root[data-fig-team] [data-slot="sidebar"] :is(nav[class*="_panelList"],[role="tree"]){--dsw-alias-interactive-bg-hover:light-dark(#2631480f,#303035)}
[data-fig-nav-pill-host]{position:relative}
[data-fig-nav-pill]{position:absolute;top:0;left:0;z-index:0;pointer-events:none;box-sizing:border-box;border-inline:var(--dsh-sidebar-paint-inset, 0px) solid transparent;background-clip:padding-box;border-radius:var(--dsw-radius-md, 8px);background-color:var(--dsw-alias-interactive-bg-hover)}
[data-fig-nav-pill-host]:has(>[data-fig-nav-pill]:not([hidden]))>[class*="_panelEntryActive"]{background-color:transparent}
`

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export function installNavPill() {
  const pill = document.createElement('span')
  pill.dataset.figNavPill = ''
  pill.setAttribute('aria-hidden', 'true')
  pill.hidden = true
  let host = /** @type {HTMLElement | null} */ (null)
  const resize = new ResizeObserver(() => place(false))

  function place(animate) {
    const nav = document.querySelector('[data-slot="sidebar"] nav[class*="_panelList"]')
    if (nav !== host) {
      host?.removeAttribute('data-fig-nav-pill-host')
      resize.disconnect()
      host = /** @type {HTMLElement | null} */ (nav)
      if (!host) { pill.remove(); return }
      host.setAttribute('data-fig-nav-pill-host', '')
      host.prepend(pill); pill.hidden = true
      resize.observe(host)
      animate = false
    } else if (host && pill.parentElement !== host) { host.prepend(pill); pill.hidden = true; animate = false }
    if (!host) return
    const active = host.querySelector(':scope > [class*="_panelEntryActive"]')
    if (!(active instanceof HTMLElement) || !active.getClientRects().length) { pill.hidden = true; return }
    const old = pill.getBoundingClientRect(), shown = !pill.hidden && old.width > 0
    const box = host.getBoundingClientRect(), target = active.getBoundingClientRect()
    const x = target.left - box.left - host.clientLeft, y = target.top - box.top - host.clientTop
    const from = `translate(${x + old.left - target.left}px, ${y + old.top - target.top}px)`, to = `translate(${x}px, ${y}px)`
    const moved = shown && (Math.abs(old.left - target.left) > .5 || Math.abs(old.top - target.top) > .5)
    pill.hidden = false
    pill.style.width = `${target.width}px`; pill.style.height = `${target.height}px`; pill.style.transform = to
    if (!animate || !moved) return
    pill.getAnimations().forEach(animation => animation.cancel())
    if (!reduced()) pill.animate([{ transform: from }, { transform: to }], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' })
  }

  // 'sync': read the pill's old place and set the new one before the browser paints DSH's class change.
  const stop = watchPage({ name: 'team nav pill', timing: 'sync', childList: true, attributes: ['class', 'aria-current'],
    within: '[data-slot="sidebar"]', run: () => place(true) })
  place(false)
  return () => {
    stop(); resize.disconnect(); pill.remove()
    host?.removeAttribute('data-fig-nav-pill-host')
  }
}
