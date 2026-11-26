import { openConversation } from '../shared/page-client.js'
import { attentionContextGlobal, attentionNavigateGlobal } from '../shared/page-contract.ts'

// Fig's main process asks the page whether the open conversation is visible (to hold back a notification) and
// opens the session a clicked notification names, through these two page globals.
/** DSH 0.2.2-rc.1 local visibility adapter. DOM is used only to withhold suppression, never approve/read. */
export function installAttentionHooks(ctx) {
  let latest
  const navigate = async target => {
    if (typeof target?.sessionId !== 'string' || target.sessionId.length > 512 || typeof target.navigationId !== 'string' || typeof target.eventIdentity !== 'string') return {accepted: false}
    latest = target.navigationId
    ctx.uiWorkspace.openSession(target.sessionId)
    await new Promise(resolve => requestAnimationFrame(resolve))
    return {navigationId: target.navigationId, accepted: latest === target.navigationId}
  }
  const context = () => {
    if (document.visibilityState !== 'visible' || ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return {visible: false}
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
    if ([...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-shortcut-modal]')].some(visible)) return {visible: false}
    const conversation = openConversation()
    if (!conversation || !visible(conversation)) return {visible: false}
    const rect = conversation.getBoundingClientRect()
    const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, rect.x + rect.width / 2)), Math.min(innerHeight - 1, Math.max(0, rect.y + rect.height / 2)))
    if (!top || !conversation.contains(top)) return {visible: false}
    return {visible: true, sessionId: conversation.getAttribute('data-conversation-session')}
  }
  window[attentionNavigateGlobal] = navigate
  window[attentionContextGlobal] = context
  return () => { delete window[attentionNavigateGlobal]; delete window[attentionContextGlobal] }
}
