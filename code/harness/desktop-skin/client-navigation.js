import { t } from './client-locale.js'

// Use DSH's layout and workspace services, not browser history (DSH does not route sessions by URL).
export function installPageNavigation(ctx) {
  const nav = document.createElement('nav')
  nav.dataset.figPageNavigation = ''
  const buttons = [-1, 1].map(delta => {
    const button = document.createElement('button')
    button.type = 'button'
    button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${delta < 0 ? 'M15 6l-6 6 6 6M9 12h11' : 'M9 6l6 6-6 6M4 12h11'}"/></svg>`
    button.onclick = () => go(delta)
    nav.append(button)
    return button
  })
  const entries = []
  let index = -1, queued = false, disposed = false
  const snapshot = () => {
    const panel = ctx.layout.panelInfo.getSnapshot().activePanelId
    const session = Object.values(ctx.sessions.list.getSnapshot().byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id
    return panel ? { panel, session: undefined } : session ? { panel: null, session } : null
  }
  const same = (a, b) => a?.panel === b?.panel && a?.session === b?.session
  const render = () => { buttons[0].disabled = index <= 0; buttons[1].disabled = index >= entries.length - 1 }
  const record = () => {
    queued = false
    if (disposed) return
    const current = snapshot()
    if (current && !same(entries[index], current)) {
      entries.splice(index + 1); entries.push(current)
      if (entries.length > 100) entries.shift()
      index = entries.length - 1
    }
    render()
  }
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(record) } }
  function go(delta) {
    record()
    const targetIndex = index + delta, target = entries[targetIndex]
    if (!target) return
    const previous = index
    index = targetIndex
    const undo = () => { if (index === targetIndex) { index = previous; render() } }
    try {
      // openSession may settle later; a refusal then rolls back the same way as a synchronous one.
      Promise.resolve(target.panel ? ctx.layout.selectPanel(target.panel) : ctx.uiWorkspace.openSession(target.session)).catch(undo)
    } catch {
      undo()
    }
    render()
  }
  // Plain DOM outside DSH's slots: the labels are set again on a language switch.
  const label = () => {
    nav.setAttribute('aria-label', t('navigation.pageNavigation'))
    buttons[0].setAttribute('aria-label', t('navigation.back'))
    buttons[1].setAttribute('aria-label', t('navigation.forward'))
  }
  label()
  const offPanel = ctx.layout.panelInfo.subscribe(schedule)
  const offSession = ctx.sessions.list.subscribe(schedule)
  const offLocale = ctx.locale.subscribe(label)
  record(); document.body.append(nav)
  return () => { disposed = true; offPanel(); offSession(); offLocale(); nav.remove() }
}
