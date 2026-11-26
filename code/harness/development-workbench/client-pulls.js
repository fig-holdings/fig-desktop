import { t } from './client-locale.js'
import { AUTOFIX_LIMIT, fixKinds, mergeReady } from './actions.js'
import { activeCheck, ciSummary, failedCheck, pollDelay } from './ci.js'
import { fixLabels } from './client-dialogs.js'
import { colors, ellipsis, heading, mono, muted, section } from './client-theme.js'
import { elapsed } from './client-ui.js'

// 合并请求 on the card, and the parts PR 详情 shares: compact rows with their ⋯ menu, CI checks, review state and
// threads, the actions the Agent can be asked, and polling while something shows them.

/** Rows a list shows before 显示更多. */
export const SHOWN_ROWS = 5

/**
 * The short phrase a compact pull request row shows after "repo #n": what needs handling, else checks running, draft,
 * merged or closed; nothing when all is well.
 * @param {any} pull
 */
export function pullHint(pull) {
  if (pull.closed === 'merged') return t('pulls.hint.merged')
  if (pull.closed === 'closed') return t('pulls.hint.closed')
  const kinds = fixKinds(pull)
  if (kinds.length) return kinds.map(kind => t(`pulls.hint.${kind}`)).join(t('shared.listSeparator'))
  if ((pull.checks ?? []).some(activeCheck)) return t('pulls.hint.checksRunning')
  if (pull.draft) return t('pulls.hint.draft')
  return ''
}

/** A pull request's icon color: merged purple, closed or draft grey, open green. @param {any} pull */
export const pullTone = pull => pull.closed === 'merged' ? colors.merged : pull.closed || pull.draft ? colors.secondary : colors.added

/** Whether an element is really on screen: laid out with a size, and not hidden by display or visibility. @param {HTMLElement} element */
const shown = element => {
  const box = element.getBoundingClientRect()
  if (!element.isConnected || box.width === 0 || box.height === 0) return false
  return element.checkVisibility ? element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : element.offsetParent !== null
}

const pullLabels = {
  attention: () => t('pulls.needsAttention'), pending: () => t('pulls.checksRunning'),
  passed: () => t('pulls.checksPassed'), none: () => t('pulls.noChecks'), draft: () => t('pulls.draft'),
  merged: () => t('pulls.merged'), closed: () => t('pulls.closed')
}
const problems = {
  'signed-out': () => t('pulls.ghIsNotSignedIn'),
  'not-github': () => t('pulls.thisRepositoryHasNoGithub'),
  'no-gh': () => t('pulls.installAndSignInTo'),
  'not-repository': () => t('pulls.thisFolderIsNotA'),
  failed: () => t('pulls.couldNotReadPullRequests')
}
const ciLabels = () => ({ running: t('pulls.running'), queued: t('pulls.queued'), passed: t('pulls.passed'), failed: t('pulls.failed'),
  'timed-out': t('pulls.timedOut'), cancelled: t('pulls.cancelled'), skipped: t('pulls.skipped'), neutral: t('pulls.neutral'),
  'action-required': t('pulls.actionRequired'), stale: t('pulls.stale'), unknown: t('pulls.unknown') })
const autofixLabels = () => ({
  watching: t('pulls.autoFixOn'), sent: t('pulls.autoFixOn'),
  waiting: t('pulls.autoFixWaitingForThe'),
  'off-branch': t('pulls.autoFixTheSessionIs'),
  limit: t('pulls.autoFixStoppedAfter', { AUTOFIX_LIMIT }),
  error: t('pulls.autoFixCouldNotRead'), ended: t('pulls.autoFixEnded')
})

/** @param {any} wb - the workbench's shared parts (client-workbench.js) */
export function pullsKit(wb) {
  const { h, Icon, store } = wb
  const { useEffect, useRef, useState, useSyncExternalStore } = wb.react
  const { useDismiss, MenuList, chevron, Fold } = wb.ui

  function CheckIcon({ check }) {
    const active = check.state === 'running'
    return h('span', { 'aria-hidden': true, className: active ? 'fig-ci-spinning' : undefined,
      style: { display: 'inline-flex', flex: 'none', width: 14, height: 14, alignItems: 'center', justifyContent: 'center',
        color: failedCheck(check) ? colors.deleted : check.state === 'passed' ? colors.added : colors.secondary } },
    active ? '◌' : ({ passed: '✓', failed: '×', 'timed-out': '×', cancelled: '⊘', skipped: '−', neutral: '−', queued: '○' })[check.state] ?? '?')
  }
  function PullChecks({ pull, initiallyOpen = false }) {
    const [expanded, setExpanded] = useState(initiallyOpen)
    const [now, setNow] = useState(Date.now())
    const checks = pull.checks ?? []
    useEffect(() => {
      if (!expanded || !checks.some(c => c.state === 'running')) return
      const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
      return () => clearInterval(timer)
    }, [expanded, checks])
    if (!checks.length) return h('div', { style: { ...muted, paddingLeft: 22 } }, t('pulls.noChecksReturnedYet'))
    const ci = ciSummary(checks)
    return h('div', { 'data-fig-ci': '', style: { paddingLeft: 22 } },
      h('button', { className: 'fig-wb-row', type: 'button', 'aria-expanded': expanded, 'data-fig-ci-toggle': pull.number,
        onClick: () => setExpanded(!expanded), style: { fontSize: 12, color: colors.secondary, flexWrap: 'wrap' } },
      h(CheckIcon, { check: checks.find(c => failedCheck(c)) ?? checks.find(c => c.state === 'running') ?? checks[0] }),
      t('pulls.ciLoadedChecksDone', { completed: ci.completed, total: ci.total }),
      ci.running > 0 && t('pulls.runningCount', { running: ci.running }), ci.queued > 0 && t('pulls.queuedCount', { queued: ci.queued })),
      expanded && h('div', { 'data-fig-ci-details': '', style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' } },
        ...checks.map((check, i) => {
          const start = Date.parse(check.startedAt), end = Date.parse(check.completedAt)
          const duration = Number.isFinite(start) && (Number.isFinite(end) || check.state === 'running') ? elapsed(Math.max(0, (Number.isFinite(end) ? end : now) - start)) : ''
          return h(check.url ? 'a' : 'div', { key: i, href: check.url, target: check.url ? '_blank' : undefined, rel: check.url ? 'noreferrer' : undefined,
            className: 'fig-wb-row', style: { fontSize: 12 }, title: check.name, 'data-fig-ci-state': check.state },
          h(CheckIcon, { check }), h('span', { style: { ...ellipsis, flex: 1 } }, check.name),
          h('span', { style: { ...muted, whiteSpace: 'nowrap' } }, ciLabels()[check.state], duration ? ' · ' + duration : ''))
        }), h('div', { style: muted }, t('pulls.checksReturnedByThePlatform'))))
  }

  /**
   * What can be done with one pull request, for its ⋯ menu and the PR 详情 tab alike: the Agent's fixes, merge,
   * auto-fix and a worktree for this Session's open ones; review in Fig for a review request.
   * @param {string} sessionId @param {any} pull @param {{ own?: boolean, running?: boolean, sameRepo?: boolean, request?: boolean }} options
   * @returns {{ key: string, icon: string, label: string, disabled?: string, run: () => void }[]}
   */
  function pullItems(sessionId, pull, { own, running, sameRepo, request }) {
    if (request) return [{ key: 'review-in-fig', icon: 'compare', label: t('pulls.reviewInFig'), run: () => store.openDiff(sessionId, 'pull', pull.url) }]
    if (!own || pull.open === false) return []
    const external = pull.source === 'extension'
    const policy = pull.policy
    const allowed = kind => !external || policy?.allowed?.includes(kind)
    const kinds = allowed('fix') ? fixKinds(pull) : []
    const auto = pull.autofix
    const busy = running ? t('pulls.theSessionIsRunning') : ''
    const offBranch = !pull.current
    return [
      ...kinds.map(kind => ({ key: 'fix-' + kind, icon: 'agent', label: fixLabels()[kind], run: () => store.openAction(sessionId, 'fix', { pull, kind }),
        disabled: busy || (offBranch ? t('pulls.theSessionIsNotOn', { branch: pull.branch }) : '') })),
      ...(allowed('merge') && mergeReady(pull).ok ? [{ key: 'merge', icon: 'merge', label: t('pulls.merge'), run: () => store.openAction(sessionId, 'merge', { pull }), disabled: busy }] : []),
      ...(offBranch && sameRepo && allowed('pull-worktree') ? [{ key: 'worktree', icon: 'branch', label: t('pulls.handleInAWorktree'), run: () => store.openAction(sessionId, 'pull-worktree', { pull, kinds }) }] : []),
      ...(policy?.actions ?? []).map(action => ({ key: `extension-${action.id}`, icon: 'pull', label: action.label, run: () => store.openAction(sessionId, 'extension', { action }) })),
      ...(allowed('autofix') && (kinds.length > 0 || auto || pull.checks?.some(activeCheck)) ? [{ key: 'autofix', icon: 'auto', label: auto ? t('pulls.turnOffAutoFix') : t('pulls.autoFix'),
        run: () => store.openAction(sessionId, 'autofix', { pull, on: !auto }) }] : [])
    ]
  }

  /**
   * One pull request in two lines, as Claude lists changes: title; "repo #n" with a short phrase only when it matters.
   * The icon's color is its state, a red dot marks one that needs handling. A click opens PR 详情 (a review request
   * opens its diff for review); actions sit in ⋯.
   * @param {{ sessionId: string, pull: any, own?: boolean, repo?: string, running?: boolean, request?: boolean }} props
   */
  function CompactPull({ sessionId, pull, own, repo, running, request }) {
    const [menu, setMenu] = useState(false)
    const holder = useRef(/** @type {HTMLElement | null} */ (null))
    useDismiss(menu, () => setMenu(false), holder)
    const repoName = String(request ? pull.repo : pull.repo || repo || '').split('/').pop()
    const attention = !request && pull.open !== false && fixKinds(pull).length > 0
    const hint = request ? '@' + pull.author + (pull.draft ? t('pulls.draftSuffix') : '') : pullHint(pull)
    /** @type {{ key: string, icon: string, label: string, disabled?: string, run: () => void }[]} */
    const items = [...pullItems(sessionId, pull, { own, running, sameRepo: !repo || pull.repo === repo.toLowerCase(), request }),
      ...(request ? [] : [{ key: 'detail', icon: 'output', label: t('pulls.details'), run: () => store.openPullDetail(sessionId, pull.url) }]),
      { key: 'github', icon: 'open', label: t('pulls.openOnGithub'), run: () => window.open(pull.url, '_blank', 'noopener') }]
    return h('div', { ref: holder, 'data-fig-workbench-pull-row': pull.url, ...(request ? { 'data-fig-review-request': pull.url } : {}), style: { position: 'relative', display: 'flex', alignItems: 'flex-start' } },
      h('button', { type: 'button', className: 'fig-wb-row', 'data-fig-workbench-pull': pull.number, title: pull.title, style: { alignItems: 'flex-start', flex: 1, minWidth: 0, width: 'auto', marginRight: 0 },
        onClick: () => request ? store.openDiff(sessionId, 'pull', pull.url) : store.openPullDetail(sessionId, pull.url) },
      h('span', { style: { position: 'relative', paddingTop: 3, flex: 'none' } }, h(Icon, { name: pull.closed === 'merged' ? 'merge' : 'pull', color: request ? colors.secondary : pullTone(pull) }),
        attention && h('span', { 'data-fig-pull-attention': '', 'aria-label': t('pulls.needsAttention'), style: { position: 'absolute', top: 1, right: -3, width: 7, height: 7, borderRadius: 4,
          background: colors.deleted, boxShadow: '0 0 0 1.5px ' + colors.card } })),
      h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
        h('span', { style: ellipsis }, pull.title),
        h('span', { style: { ...muted, ...ellipsis } }, `${repoName} #${pull.number}` + (hint ? ' · ' + hint : '') + (pull.policy?.merge?.label ? ' · ' + pull.policy.merge.label : '') + (pull.autofix ? t('pulls.autoFixSuffix') : '')))),
      h('button', { type: 'button', className: 'fig-wb-link', 'aria-label': t('pulls.more'), 'aria-haspopup': 'menu', 'aria-expanded': menu, 'data-fig-pull-menu': pull.number,
        style: { flex: 'none', marginTop: 2 }, onClick: () => setMenu(!menu) }, '⋯'),
      menu && h(MenuList, { attributes: { 'data-fig-pull-menu-list': pull.number }, style: { right: 0, minWidth: 180 }, close: () => setMenu(false),
        items: items.map(item => ({ ...item, title: item.disabled || undefined,
          attributes: { [item.key === 'review-in-fig' ? 'data-fig-review-in-fig' : `data-fig-pull-${item.key}`]: item.key === 'review-in-fig' ? pull.url : pull.number } })) }))
  }

  /**
   * 评审: who approved, asked for changes or is asked, and the unresolved threads, each of which (or all) can go to
   * the Agent. Threads open only for the Session on the pull request's branch, like 处理评审意见.
   */
  function ReviewSummary({ sessionId, pull, running, initiallyOpen = false }) {
    const [open, setOpen] = useState(initiallyOpen)
    const review = pull.review
    const parts = [review.approved.length > 0 && t('pulls.approvedBy', { names: review.approved.join(t('shared.listSeparator')) }),
      review.changes.length > 0 && t('pulls.changesRequestedBy', { names: review.changes.join(t('shared.listSeparator')) }),
      review.pending.length > 0 && t('pulls.waitingFor', { names: review.pending.join(t('shared.listSeparator')) })].filter(Boolean)
    const count = review.threads.length
    if (!parts.length && !count) return null
    const blocked = running ? t('pulls.theSessionIsRunning')
      : !pull.current ? t('pulls.theSessionIsNotOnHint', { branch: pull.branch }) : ''
    const agent = (key, label, threads) => h('button', { key, type: 'button', className: 'fig-wb-link', disabled: Boolean(blocked), title: blocked || undefined,
      'data-fig-thread-agent': key, style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px' },
      onClick: () => store.openAction(sessionId, 'threads', { pull, threads }) }, h(Icon, { name: 'agent', size: 12 }), label)
    return h('div', { 'data-fig-pull-review': pull.number, style: { paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 2 } },
      parts.length > 0 && h('div', { style: { ...muted, overflowWrap: 'anywhere' } }, parts.join(' · ')),
      count > 0 && h('button', { type: 'button', className: 'fig-wb-row', 'aria-expanded': open, 'data-fig-review-threads': count, onClick: () => setOpen(!open),
        style: { fontSize: 12, color: colors.secondary } },
      chevron(open),
      t(count === 1 ? 'pulls.unresolvedThreads.one' : 'pulls.unresolvedThreads.other', { count }) + (review.resolved ? t('pulls.resolved', { resolved: review.resolved }) : '')),
      open && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 0 4px' } },
        ...review.threads.map(thread => h('div', { key: thread.id, 'data-fig-review-thread': thread.id, style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 } },
            h('a', { href: thread.url, target: '_blank', rel: 'noreferrer', title: thread.path, style: { ...ellipsis, flex: 1, color: colors.primary,
              fontFamily: mono, textDecoration: 'none' } }, thread.path + (thread.line ? ':' + thread.line : '')),
            thread.outdated && h('span', { style: muted }, t('pulls.outdated')),
            h('span', { style: { ...muted, flex: 'none' } }, '@' + thread.author)),
          h('div', { style: { color: colors.secondary, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, thread.body),
          h('div', null, agent(thread.id, t('pulls.askTheAgent'), [thread])))),
        count > 1 && h('div', null, agent('all', t('pulls.addressAll', { count }), 'all')),
        review.more && h('div', { style: muted }, t('pulls.onlyTheFirst100Threads'))))
  }

  /** 交给 Agent (修复 CI／解决冲突／处理评审意见), 合并…, 自动修复 for one of this Session's open pull requests. */
  function PullActions({ sessionId, pull, running, sameRepo }) {
    const items = pullItems(sessionId, pull, { own: true, running, sameRepo })
    const auto = pull.autofix
    if (!items.length && !auto && !pull.policy?.merge?.label) return null
    return h('div', { 'data-fig-pull-actions': pull.number, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 } },
      ...items.map(item => h('button', { key: item.key, type: 'button', className: 'fig-wb-link', [`data-fig-pull-${item.key}`]: pull.number,
        disabled: Boolean(item.disabled), title: item.disabled || undefined, onClick: item.run,
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px' } }, h(Icon, { name: item.icon, size: 12 }), item.label)),
      pull.policy?.merge?.label && h('span', { role: 'status', style: { ...muted, flexBasis: '100%' } }, pull.policy.merge.label),
      auto && h('span', { 'data-fig-pull-autofix-status': auto.status, style: { ...muted, flexBasis: '100%', paddingLeft: 6 } },
        (autofixLabels()[auto.status] ?? autofixLabels().watching) + (auto.attempts ? t('pulls.sent', { attempts: auto.attempts }) : '')))
  }

  /**
   * Keeps one Session's pull requests fresh while something shows them (the card's list or PR 详情): only the pull
   * requests whose checks run every 15 s, else the lists every 120 s; none while the page is hidden, or while `view`
   * (PR 详情, which a collapsed right sidebar keeps mounted) is not shown. With both views open, a poll right after
   * another is skipped.
   * @param {string} sessionId @param {any} entry @param {{ current: HTMLElement | null }} [view]
   */
  function usePullPolling(sessionId, entry, view) {
    const value = entry?.value
    useEffect(() => {
      if (!sessionId || entry?.loading) return
      let timer
      const delay = pollDelay(value, entry?.error)
      const poll = () => {
        const element = view?.current
        if (element && !shown(element)) { timer = setTimeout(poll, delay); return }
        if (Date.now() - (store.pullsAskedAt.get(sessionId) ?? 0) < delay - 2000) return
        // Checks running: poll only those pull requests; otherwise re-read the lists.
        const active = [...(value?.session ?? []), ...(value?.pulls ?? [])].filter(pull => pull.open !== false && pull.checks?.some(activeCheck)).map(pull => pull.url)
        if (active.length) store.pulls.load(sessionId, false, [...new Set(active)]); else store.pulls.load(sessionId, true)
      }
      const visible = () => { clearTimeout(timer); if (!document.hidden) store.pulls.load(sessionId, true) }
      document.addEventListener('visibilitychange', visible)
      if (!document.hidden) timer = setTimeout(poll, delay)
      return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
    }, [sessionId, entry])
  }

  /** 合并请求: this Session's pull requests, the user's other ones and review requests (both folded), polled while shown. */
  function Pulls({ sessionId, repository, running }) {
    const entry = useSyncExternalStore(store.subscribeData, () => store.pulls.get(sessionId))
    const [all, setAll] = useState(false)
    const [others, setOthers] = useState(false)
    const [reviewing, setReviewing] = useState(false)
    const value = entry?.value
    usePullPolling(sessionId, entry)
    const own = value?.session ?? []
    const list = value?.pulls ?? []
    const requests = value?.requests ?? []
    const repo = repository?.remote?.web ? repository.remote.path : undefined
    let body
    if (!value) body = h('div', { style: muted }, entry?.error ? t('pulls.couldNotReadPullRequestsShort') : t('pulls.reading'))
    else if (value.problem) body = h('div', { style: muted, title: value.message }, (problems[value.problem] ?? problems.failed)())
    else body = [
      own.length === 0 ? h('div', { key: 'none', style: muted }, t('pulls.noPullRequestsInThis'))
        : (all ? own : own.slice(0, SHOWN_ROWS)).map(pull => h(CompactPull, { key: pull.url, sessionId, pull, own: true, repo, running })),
      own.length > SHOWN_ROWS && h('button', { key: 'more', type: 'button', className: 'fig-wb-link', style: { alignSelf: 'flex-start', padding: '2px 0' }, onClick: () => setAll(!all) },
        all ? t('pulls.showFewer') : t('pulls.showMore', { count: own.length - SHOWN_ROWS })),
      list.length > 0 && h(Fold, { key: 'other-pulls', name: 'other-pulls', open: others, onToggle: () => setOthers(!others), label: t('pulls.myOtherPullRequests'), count: list.length }),
      ...(others ? list.map(pull => h(CompactPull, { key: pull.url, sessionId, pull, own: false, repo, running })) : []),
      requests.length > 0 && h(Fold, { key: 'requests-toggle', name: 'requests-toggle', open: reviewing, onToggle: () => setReviewing(!reviewing), label: t('pulls.waitingForMyReviewHere'), count: requests.length }),
      ...(reviewing ? requests.map(pull => h(CompactPull, { key: pull.url, sessionId, pull, request: true, repo, running })) : [])
    ]
    return h('div', { style: section, 'data-fig-workbench-pulls': '' },
      h('div', { style: heading, title: value?.readAt ? t('pulls.updated') + new Date(value.readAt).toLocaleTimeString() : undefined },
        h('span', null, t('pulls.pullRequests')), h('span', null, value?.session ? String(own.length) : '')),
      entry?.error && h('div', { role: 'status', style: muted }, value ? t('pulls.updateFailedShowingPreviousResults') : (problems[entry.error] ?? problems.failed)()),
      value?.extensionUnavailable && h('div', { role: 'status', style: muted }, t('pulls.extensionUnavailable')),
      body)
  }

  return { Pulls, PullChecks, PullActions, ReviewSummary, usePullPolling, pullLabels, pullTone }
}
