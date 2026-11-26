import { t } from './client-locale.js'
import { parsePullUrl } from './actions.js'
import { parseResourceAddress, registerResourceTab, resourcePrefix } from './client-resource-tab.js'
import { colors, heading, mono, muted } from './client-theme.js'

// PR 详情: one pull request in a right-sidebar tab: title, repository and branches, CI checks, review state and
// threads, what the Agent can be asked, auto-fix. It reads the card's pull request lists (refreshing them when empty).

/** The right-sidebar tab with one pull request's details (CI, review, actions). */
export const pullDetailProtocol = 'figdevpull'
export const pullDetailTypeId = 'fig-development-pull'
/** @param {string} session @param {string} url */
export const pullDetailAddress = (session, url) => `${resourcePrefix(pullDetailProtocol)}session/${encodeURIComponent(session)}?url=${encodeURIComponent(url)}`
/** {session, url} for a PR 详情 address, else undefined. @param {string} address */
export function parsePullDetailAddress(address) {
  const parsed = parseResourceAddress(address, pullDetailProtocol)
  const pull = parsed?.params.get('url')
  if (!parsed || !parsePullUrl(pull)) return undefined
  return { session: parsed.session, url: /** @type {string} */ (pull) }
}

/** @param {any} wb - the workbench's shared parts (client-workbench.js) */
export function pullDetail(wb) {
  const { h, Icon, store } = wb
  const { useEffect, useRef, useSyncExternalStore } = wb.react
  const { useSessionRunning } = wb.ui
  const { PullActions, PullChecks, ReviewSummary, usePullPolling, pullLabels, pullTone } = wb.pulls

  function PullDetail({ useTabInfo }) {
    const { tab: info } = useTabInfo()
    const parsed = parsePullDetailAddress(info.contentId ?? info.address ?? '')
    const sessionId = parsed?.session ?? ''
    const entry = useSyncExternalStore(store.subscribeData, () => store.pulls.get(sessionId))
    const running = useSessionRunning(sessionId)
    useEffect(() => { if (sessionId && !store.pulls.get(sessionId)?.value) store.pulls.load(sessionId, true) }, [sessionId])
    const view = useRef(/** @type {HTMLElement | null} */ (null))
    usePullPolling(sessionId, entry, view)
    if (!parsed) return null
    const value = entry?.value
    const own = (value?.session ?? []).find(pull => pull.url === parsed.url)
    const pull = own ?? (value?.pulls ?? []).find(each => each.url === parsed.url)
    const repo = parsePullUrl(parsed.url)
    const box = { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px', height: '100%', boxSizing: 'border-box', overflowY: 'auto', color: colors.primary, fontSize: 13 }
    const block = (key, title, ...children) => h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8, borderTop: '.5px solid ' + colors.border } },
      h('div', { style: heading }, title), ...children)
    if (!pull) return h('div', { ref: view, 'data-fig-pull-detail': 'missing', style: box }, h('div', { style: muted },
      entry?.loading || !value ? t('pull-detail.reading') : t('pull-detail.thisPullRequestIsNot')))
    return h('div', { ref: view, 'data-fig-pull-detail': pull.url, style: box },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
        h('span', { style: { paddingTop: 2 } }, h(Icon, { name: pull.closed === 'merged' ? 'merge' : 'pull', size: 16, color: pullTone(pull) })),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
          h('div', { style: { fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' } }, pull.title),
          h('div', { style: muted }, `${repo?.owner}/${repo?.repo} #${pull.number} · ` + pullLabels[pull.state]() + (pull.current ? t('pull-detail.currentBranch') : '')),
          h('div', { style: { ...muted, fontFamily: mono, overflowWrap: 'anywhere' } }, `${pull.branch} → ${pull.base}`)),
        h('a', { href: pull.url, target: '_blank', rel: 'noreferrer', className: 'fig-wb-link', 'data-fig-pull-detail-github': '', style: { textDecoration: 'none', flex: 'none', color: colors.secondary } },
          t('pull-detail.github'))),
      pull.open !== false && own && block('actions', t('pull-detail.actions'), h(PullActions, { sessionId, pull, running, sameRepo: true })
        ?? h('div', { style: muted }, t('pull-detail.nothingToDoRightNow'))),
      pull.open !== false && block('checks', t('pull-detail.checks'), h(PullChecks, { pull, initiallyOpen: true })),
      own && pull.open !== false && pull.review && block('review', t('pull-detail.review'), h(ReviewSummary, { sessionId, pull, running, initiallyOpen: true })),
      entry?.error && h('div', { role: 'status', style: muted }, t('pull-detail.updateFailedShowingPreviousResults')),
      h('div', { style: { ...muted, display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto' } },
        value?.readAt && h('span', null, t('pull-detail.updated') + new Date(value.readAt).toLocaleTimeString()),
        h('button', { type: 'button', className: 'fig-wb-link', disabled: entry?.loading, onClick: () => store.pulls.load(sessionId, true) }, t('pull-detail.refresh'))))
  }

  /** Registers the PR 详情 tab type and its resource, as the 代码变更 tab does. @param {any} ctx */
  const register = ctx => registerResourceTab(ctx, { protocol: pullDetailProtocol, typeId: pullDetailTypeId, parse: parsePullDetailAddress,
    title: () => t('pull-detail.pullRequest'), component: PullDetail })

  return { register }
}
