import { t } from './client-locale.js'

/** Native QueueDock's public session/projection hooks; this explains cancel, without changing it. */
export function queueNotice(h) {
  return function QueueNotice({ useSession, useProjection }) {
    const running = useSession(state => state.running)
    const inbox = useProjection('inbox')
    if (!running || !(inbox?.['next-turn']?.length > 0)) return null
    return h('div', { 'data-fig-stop-queue-note': '', role: 'note', style: {
      color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px', padding: '2px 4px 6px'
    } }, t('queue.stopEndsThisTurnQueued'))
  }
}
