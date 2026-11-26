import { t } from './client-locale.js'
import { slotEntries } from '../shared/dsh-internals.js'
import { CARD_WIDTH, colors, divider, ellipsis, heading, mono, muted, rowStyle, section } from './client-theme.js'
import { logError } from './client-store.js'
import { elapsed, middle } from './client-ui.js'
import { SHOWN_ROWS } from './client-pulls.js'

// The 研发工作台 card: the repository (path, worktrees, remote, changes, sync and the actions they offer), pull requests,
// outputs, the Session's todo list and its background jobs.

const worktreeReasons = () => ({ main: t('card.mainCheckout'), foreign: t('card.notCreatedByFig'), current: t('card.thisSession'),
  open: t('card.anOpenSessionUsesIt'), locked: t('card.locked'), dirty: t('card.uncommittedChanges') })

/** @param {any} wb - the workbench's shared parts (client-workbench.js) */
export function card(wb) {
  const { h, Icon, call, store } = wb
  const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = wb.react
  const { lead, useDismiss, MenuList, useSessionRunning, Counts, chevron } = wb.ui
  const { Pulls } = wb.pulls

  /** The local path row's menu: Finder, GitHub, copy, DSH's terminal. */
  function PathRow({ sessionId, repository }) {
    const [open, setOpen] = useState(false)
    const holder = useRef(/** @type {HTMLElement | null} */ (null))
    useDismiss(open, () => setOpen(false), holder)
    const parent = repository.display.endsWith('/' + repository.name) ? repository.display.slice(0, -repository.name.length - 1) : repository.display
    const sidebar = wb.ctx()?.sidebarRight
    const terminal = () => {
      // As DSH's own terminal.new does: resolve this Session's sidebar target from its conversation body, open a terminal tab.
      const element = document.querySelector(`[data-conversation-session="${CSS.escape(sessionId)}"]`)
      try {
        const target = sidebar.commandTarget(element)
        if (target !== undefined) sidebar.openTabFromTarget('terminal', target)
      } catch (error) { logError(error) }
    }
    const item = (name, label, run, disabled = false) => ({ key: name, icon: name === 'github' ? 'open' : name, label, run, disabled, attributes: { 'data-fig-workbench-path-action': name } })
    return h('div', { ref: holder, style: { position: 'relative' } },
      h('button', { type: 'button', className: 'fig-wb-row', 'data-fig-workbench-path': '', 'aria-haspopup': 'menu', 'aria-expanded': open,
        title: repository.root, onClick: () => setOpen(!open) },
      lead('folder'),
      h('span', { style: { ...ellipsis, flex: 1 } }, repository.name, h('span', { style: { color: colors.secondary } }, ' · ' + middle(parent)))),
      open && h(MenuList, { attributes: { 'data-fig-workbench-path-menu': '' }, style: { left: 0, right: 0 }, close: () => setOpen(false), items: [
        item('finder', t('card.showInFinder'), () => { void call('reveal', { session: sessionId }).catch(logError) }),
        ...(repository.remote?.web ? [item('github', t('card.openRepositoryOnGithub'), () => window.open(repository.remote.web, '_blank', 'noopener'))] : []),
        { key: 'sep', separator: /** @type {const} */ (true) },
        item('copy', t('card.copyPath'), () => { navigator.clipboard?.writeText(repository.root).catch(() => {}) }),
        item('terminal', t('card.openInTerminal'), terminal,
          typeof sidebar?.commandTarget !== 'function' || typeof sidebar?.openTabFromTarget !== 'function')] }))
  }

  /** A row that opens the diff of one scope. */
  const changeRow = (sessionId, scope, children, title) => h('button', { type: 'button', className: 'fig-wb-row', title,
    'data-fig-workbench-open-diff': scope, onClick: () => store.openDiff(sessionId, scope) }, ...children,
  h(Icon, { name: 'chevron', size: 12, color: colors.secondary }))

  /** A card row that opens an action, disabled while the Session runs. */
  const actionRow = (key, icon, label, running, onClick, extra) => h('button', { key, type: 'button', className: 'fig-wb-row', [`data-fig-workbench-${key}`]: '',
    disabled: running, title: running ? t('card.theSessionIsRunningTry') : undefined,
    style: running ? { color: colors.secondary, cursor: 'default' } : undefined, onClick },
  lead(icon), h('span', { style: { flex: 1 } }, label), running ? h('span', { style: muted }, t('card.running')) : extra)

  function Repository({ sessionId, status, running }) {
    const pullEntry = useSyncExternalStore(store.subscribeData, () => store.pulls.get(sessionId))
    const repository = status?.value?.repository
    if (status?.error && !status.value) {
      return h('div', { style: section },
        h('div', { style: { ...rowStyle, color: colors.secondary } }, t('card.couldNotReadTheRepository')),
        h('div', { style: { ...muted, ...ellipsis }, title: status.error }, status.error))
    }
    if (!status?.value) return h('div', { style: section }, h('div', { style: muted }, t('card.reading')))
    if (!repository) {
      return h('div', { style: section }, h('div', { style: muted }, t('card.thisFolderIsNotA')))
    }
    const branch = repository.branch ?? t('card.detachedHead', { commit: repository.commit ?? '' })
    return [
      h('div', { key: 'repo', style: section, 'data-fig-workbench-repository': '' },
        h(PathRow, { sessionId, repository }),
        h(Worktrees, { sessionId, repository, branch, readAt: status.value.readAt }),
        ...repositoryRows(repository, pullEntry?.value)),
      h('div', { key: 'changes', style: section, 'data-fig-workbench-changes': '' },
        h('div', { style: heading }, t('card.codeChanges')),
        changeRow(sessionId, 'uncommitted', [lead('uncommitted'), h('span', { key: 'l', style: { flex: 1 } }, t('card.uncommitted')),
          h(Counts, { key: 'c', value: repository.uncommitted, atLeast: repository.untrackedTruncated })],
        repository.untrackedTruncated ? t('card.someLargeOrNumerousNew') : undefined),
        repository.branchCompare?.noCommits
          ? h('div', { style: { ...rowStyle, ...muted }, 'data-fig-workbench-branch-same': '',
            title: t('card.noCommitsBeyondEveryChange', { base: repository.branchCompare.base }) },
          lead('compare'), h('span', { style: { flex: 'none' } }, t('card.branch')),
          h('span', { style: { ...ellipsis, flex: 1, fontFamily: mono } }, repository.branchCompare.base),
          h('span', { style: { whiteSpace: 'nowrap' } }, t('card.noNewCommits')))
          : repository.branchCompare
            ? changeRow(sessionId, 'branch', [lead('compare'),
              h('span', { key: 'l', style: { flex: 'none' } }, t('card.branch')),
              h('span', { key: 'b', style: { ...muted, ...ellipsis, flex: 1, fontFamily: mono } }, repository.branchCompare.base),
              h(Counts, { key: 'c', value: repository.branchCompare })], t('card.comparedWithTheLocallyRecorded'))
            : h('div', { style: { ...rowStyle, ...muted } }, lead('compare'), t('card.branchNoRemoteBranchTo')),
        repository.uncommitted.files > 0 && h('button', { type: 'button', className: 'fig-wb-row', 'data-fig-workbench-commit': '', disabled: running,
          title: running ? t('card.theSessionIsRunningCommit') : undefined,
          style: running ? { color: colors.secondary, cursor: 'default' } : undefined, onClick: () => store.openCommit(sessionId) },
        lead('commit'), h('span', { style: { flex: 1 } }, t('card.commit')),
        running && h('span', { style: muted }, t('card.running'))),
        ...syncRows(sessionId, repository, running, pullEntry?.value, status?.value?.githubSource))
    ]
  }

  /**
   * 同步、推送、创建 PR…: the branch against its upstream as recorded locally, then the two actions when they apply.
   * @param {string} sessionId @param {any} repository @param {boolean} running @param {any} pullValue
   */
  function syncRows(sessionId, repository, running, pullValue, mode) {
    const sync = repository.sync
    if (!sync || !repository.remote) return []
    const base = repository.branchCompare?.base?.startsWith('origin/') ? repository.branchCompare.base.slice('origin/'.length) : null
    const branchPull = [...(pullValue?.session ?? []), ...(pullValue?.pulls ?? [])].find(pull => pull.current && pull.open !== false)
    /** @type {any[]} */
    const rows = [h('div', { key: 'sync', style: rowStyle, 'data-fig-workbench-sync': '', title: t('card.asRecordedLocallyNotFetched') },
      lead('sync'), h('span', { style: { flex: 'none' } }, t('card.sync')),
      h('span', { style: { ...muted, ...ellipsis, flex: 1, fontFamily: mono } }, sync.upstream ?? ''),
      h('span', { style: { ...muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, sync.upstream === null ? t('card.notPushed')
        : sync.ahead === 0 && sync.behind === 0 ? t('card.upToDate') : `↑${sync.ahead} ↓${sync.behind}`))]
    const local = !mode || mode === 'local' || pullValue?.sessionPolicy?.source === 'local'
    if ((sync.upstream === null || sync.ahead > 0) && (local || pullValue?.sessionPolicy?.allowPush)) {
      rows.push(actionRow('push', 'push', t('card.push'), running, () => store.openAction(sessionId, 'push',
        { head: repository.head, branch: repository.branch, upstream: sync.upstream, ahead: sync.ahead, behind: sync.behind })))
    }
    const deliver = pullValue?.sessionPolicy?.deliver
    if (deliver) rows.push(actionRow('deliver', 'pull', deliver.label, running, () => store.openAction(sessionId, 'extension', { action: deliver })))
    else if ((local || pullValue?.sessionPolicy?.allowCreatePull) && repository.remote.web && base && repository.branch !== base && !repository.branchCompare?.noCommits && !branchPull) {
      rows.push(actionRow('create-pull', 'pull', t('card.createPullRequest'), running, () => store.openAction(sessionId, 'pull',
        { head: repository.head, branch: repository.branch, base, pushed: Boolean(sync.upstream) && sync.ahead === 0 })))
    }
    return rows
  }

  /**
   * The repositories, as Claude lists them: this checkout's remote, then other GitHub repositories this Session's pull
   * requests are in (e.g. a sibling checkout it also pushed to). Each opens on GitHub.
   */
  function repositoryRows(repository, pullValue) {
    const own = repository.remote?.web ? repository.remote.path.toLowerCase() : ''
    const others = [...new Set((pullValue?.session ?? []).map(pull => pull.repo).filter(repo => repo && repo !== own))]
    const row = (key, path, web, title) => web
      ? h('a', { key, href: web, target: '_blank', rel: 'noreferrer', className: 'fig-wb-row', title, ...(key === 'remote' ? { 'data-fig-workbench-remote': '' } : { 'data-fig-workbench-session-repo': path }) },
        lead('repository'), h('span', { style: { ...ellipsis, flex: 1 } }, path))
      : h('div', { key, style: rowStyle, title, 'data-fig-workbench-remote': '' }, lead('repository'), h('span', { style: { ...ellipsis, flex: 1 } }, path))
    return [
      repository.remote && (repository.remote.web ? row('remote', repository.remote.path, repository.remote.web, repository.remote.web)
        : row('remote', repository.remote.host + '/' + repository.remote.path, null, repository.remote.host + ':' + repository.remote.path)),
      ...others.map(repo => row(repo, repo, 'https://github.com/' + repo, t('card.aRepositoryOfThisSessions')))
    ].filter(Boolean)
  }

  /**
   * 工作树: the branch row, which is also the worktree entry: the branch, "工作树" when the Session works in a linked
   * worktree, and the repository's worktree count; a click lists them (on demand), with 移除… for clean ones Fig
   * created and 在新工作树中开新会话… last.
   */
  function Worktrees({ sessionId, repository, branch, readAt }) {
    const [open, setOpen] = useState(false)
    const [list, setList] = useState(/** @type {any} */ (undefined))
    useEffect(() => {
      if (!open) return
      let live = true
      call('worktrees', { session: sessionId }).then(value => { if (live) setList(value) }, () => { if (live) setList({ failed: true }) })
      return () => { live = false }
    }, [open, sessionId, readAt])
    const count = repository.worktreeCount ?? 1
    const note = [repository.worktree && t('card.worktree'), count > 1 && t('card.worktrees', { count })].filter(Boolean).join(' · ')
    return h('div', { 'data-fig-workbench-worktrees': count, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      h('button', { type: 'button', className: 'fig-wb-row', 'aria-expanded': open, 'data-fig-workbench-worktrees-toggle': '', title: branch, onClick: () => setOpen(!open) },
        lead('branch'), h('span', { style: { ...ellipsis, flex: 1 } }, branch),
        note && h('span', { style: { ...muted, whiteSpace: 'nowrap' } }, note),
        chevron(open, colors.secondary)),
      open && (list?.failed ? h('div', { style: { ...muted, paddingLeft: 22 } }, t('card.couldNotReadWorktrees'))
        : !list ? h('div', { style: { ...muted, paddingLeft: 22 } }, t('card.reading'))
          : (list.worktrees ?? []).map(entry => h('div', { key: entry.path, 'data-fig-worktree': entry.path, title: entry.path, style: { ...rowStyle, paddingLeft: 22, alignItems: 'flex-start' } },
            h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
              h('span', { style: ellipsis }, entry.branch ?? t('card.detachedHeadLabel')),
              h('span', { style: { ...muted, ...ellipsis } }, [entry.main && t('card.main'), entry.current && t('card.thisSessionInline'), entry.dirty && t('card.changed'),
                entry.fig && t('card.byFig')].filter(Boolean).join(' · ') || entry.display)),
            entry.removable?.ok ? h('button', { type: 'button', className: 'fig-wb-link', 'data-fig-worktree-remove': entry.path, onClick: () => store.openAction(sessionId, 'remove-worktree', { entry }) },
              t('card.remove'))
              : entry.fig && !entry.main && h('span', { style: { ...muted, whiteSpace: 'nowrap' }, title: t('card.cannotBeRemovedNow') }, worktreeReasons()[entry.removable?.reason] ?? '')))),
      open && h('div', { style: { paddingLeft: 16 } }, actionRow('new-worktree', 'branch', t('card.newSessionInANew'), false,
        () => store.openAction(sessionId, 'worktree', { head: repository.commit, base: repository.branchCompare?.base ?? null }))))
  }

  function Outputs({ sessionId }) {
    const entry = useSyncExternalStore(store.subscribeData, () => store.outputs.get(sessionId))
    const [all, setAll] = useState(false)
    const [error, setError] = useState('')
    const files = entry?.value?.files ?? []
    const open = async file => {
      setError('')
      try {
        const address = 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + file.path.split('/').map(encodeURIComponent).join('/')
        await wb.ctx().sidebarRight.openResource(address)
        store.closePopover(sessionId)
      } catch { setError(t('card.couldNotOpenTheFile')) }
    }
    return h('div', { style: section, 'data-fig-workbench-outputs': '' },
      h('div', { style: heading }, h('span', null, t('card.outputs')), h('span', null, entry?.value ? String(files.length) : '')),
      entry?.error ? h('button', { type: 'button', className: 'fig-wb-link', onClick: () => store.outputs.load(sessionId) }, t('card.couldNotReadOutputsRetry'))
        : !entry?.value ? h('div', { style: muted }, t('card.reading'))
          : files.length === 0 ? h('div', { style: muted }, t('card.noOutputDocumentsInThis')) : null,
      (all ? files : files.slice(0, SHOWN_ROWS)).map(file => h('button', { key: file.path, type: 'button', className: 'fig-wb-row',
        'data-fig-workbench-output': file.path, title: file.path + (file.description ? '\n' + file.description : ''), onClick: () => open(file) },
      lead('uncommitted'), h('span', { style: { ...ellipsis, flex: 1 } }, file.name))),
      files.length > SHOWN_ROWS && h('button', { type: 'button', className: 'fig-wb-link', style: { alignSelf: 'flex-start', padding: '2px 0' },
        onClick: () => setAll(!all) }, all ? t('card.showFewer') : t('card.more', { count: files.length - SHOWN_ROWS })),
      entry?.value?.truncated && h('div', { style: muted }, t('card.outputsFromLoadedHistoryOnly')),
      error && h('div', { role: 'alert', style: muted }, error))
  }

  function Jobs({ sessionId }) {
    const jobs = wb.jobs()
    const rows = useSyncExternalStore(
      useCallback(listener => jobs ? jobs.state.subscribe(listener) : () => {}, [jobs]),
      () => jobs?.state.getSnapshot().rows[sessionId])
    useEffect(() => jobs?.watchRows(sessionId), [sessionId, jobs])
    const [now, setNow] = useState(Date.now())
    const live = (rows ?? []).filter(job => job.status === 'running' || job.status === 'stopping')
    const settled = (rows ?? []).length - live.length
    useEffect(() => {
      if (live.length === 0) return
      const timer = setInterval(() => setNow(Date.now()), 1000)
      return () => clearInterval(timer)
    }, [live.length])
    const [arming, setArming] = useState(/** @type {string | undefined} */ (undefined))
    useEffect(() => {
      if (!arming) return
      const timer = setTimeout(() => setArming(undefined), 3000)
      return () => clearTimeout(timer)
    }, [arming])
    // DSH stops the job; when it cannot, the card says so instead of leaving the row as if nothing was pressed.
    const [stopFailed, setStopFailed] = useState(false)
    const stop = job => {
      if (arming !== job.id) { setArming(job.id); return }
      setArming(undefined)
      setStopFailed(false)
      try { jobs?.kill(sessionId, job.id)?.catch?.(() => setStopFailed(true)) } catch { setStopFailed(true) }
    }
    // DSH's own job list in the Session header (dsh-client-ui-jobs) shows the output; its trigger exists while jobs do.
    // DSH has no public command to open it, so this finds the trigger by the job count it holds (local adaptation,
    // see the technical notes' ledger) and says so when it is missing instead of doing nothing.
    const [missing, setMissing] = useState(false)
    const showOutput = () => {
      const header = document.querySelector(`[data-conversation-session="${CSS.escape(sessionId)}"]`)?.parentElement
      // DSH 0.2.2-rc.3 marks the trigger's count (data-job-count); rc.1, the verified release Fig runs, has no marker,
      // so there the band's disclosure button is the trigger.
      const band = '[data-slot="conversation.session.header.actions"] button[aria-expanded]'
      const trigger = header?.querySelector(band + ':has([data-job-count])') ?? header?.querySelector(band)
      setMissing(!(trigger instanceof HTMLElement))
      if (trigger instanceof HTMLElement) trigger.click()
    }
    return h('div', { style: section, 'data-fig-workbench-jobs': '' },
      h('div', { style: heading }, h('span', null, t('card.backgroundTasks')), h('span', null, String(live.length))),
      !jobs ? h('div', { style: muted }, t('card.backgroundTasksAreUnavailable'))
        : live.length === 0 ? h('div', { style: muted }, t('card.nothingRunning'))
          : live.map(job => h('div', { key: job.id, style: rowStyle },
            lead('terminal'),
            h('span', { style: { ...ellipsis, flex: 1 }, title: job.label }, job.label),
            h('span', { style: { ...muted, fontVariantNumeric: 'tabular-nums' } }, elapsed(now - job.startedAt)),
            h('button', { type: 'button', className: 'fig-wb-link', disabled: job.status === 'stopping', onClick: () => stop(job),
              style: arming === job.id ? { color: colors.deleted } : undefined },
            job.status === 'stopping' ? t('card.stopping') : arming === job.id ? t('card.confirm') : t('card.stop')))),
      stopFailed && h('div', { role: 'status', style: muted, 'data-fig-workbench-stop-failed': '' }, t('card.couldNotStopTryAgain')),
      (rows ?? []).length > 0 && h('div', { style: rowStyle },
        h('button', { type: 'button', className: 'fig-wb-link', style: { padding: '2px 0', display: 'inline-flex', alignItems: 'center', gap: 6 }, onClick: showOutput },
          lead('output'), t('card.viewOutput'), h(Icon, { name: 'chevron', size: 12 })),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { ...muted, display: 'inline-flex', alignItems: 'center', gap: 4 } }, lead('finished'), t('card.finished', { settled }))),
      missing && h('div', { role: 'status', style: muted, 'data-fig-workbench-output-missing': '' },
        t('card.theJobListButtonIn')))
  }

  /** The card's ⋯ menu: what the card shows nowhere else to copy, and a new worktree. It closes like the row menus. */
  function Menu({ sessionId, status }) {
    const [open, setOpen] = useState(false)
    const holder = useRef(/** @type {HTMLElement | null} */ (null))
    useDismiss(open, () => setOpen(false), holder)
    const repository = status?.value?.repository
    const copy = value => { navigator.clipboard?.writeText(value).catch(() => {}); setOpen(false) }
    return h('span', { ref: holder, style: { position: 'relative' } },
      h('button', { type: 'button', className: 'fig-wb-link', 'aria-label': t('card.moreMenu'), 'aria-haspopup': 'menu', 'aria-expanded': open,
        onClick: () => setOpen(!open) }, '⋯'),
      open && h(MenuList, { style: { right: 0, zIndex: 2, minWidth: 140, borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,.14)', gap: 0 } },
        // 复制路径 lives in the path row's menu; this one keeps what the card shows nowhere else to copy.
        h('button', { key: 'branch', type: 'button', role: 'menuitem', className: 'fig-wb-link', disabled: !repository?.branch, style: { textAlign: 'left', fontSize: 13 },
          onClick: () => copy(repository.branch) }, t('card.copyBranchName')),
        repository && h('button', { key: 'worktree', type: 'button', role: 'menuitem', className: 'fig-wb-link', 'data-fig-menu-new-worktree': '', style: { textAlign: 'left', fontSize: 13 },
          onClick: () => { setOpen(false); store.openAction(sessionId, 'worktree', { head: repository.commit, base: repository.branchCompare?.base ?? null }) } },
        t('card.newSessionInANew'))))
  }

  // Reuse DSH's own todo dock: same projection, component, locale, markers and disclosure.
  // Only its composer-specific width constraint is overridden inside this narrow card.
  function Tasks(props) {
    const entry = slotEntries(wb.ctx(), 'conversation.input.dock').find(item => item.id === 'todo' || item.options?.id === 'todo')
    return h('div', { style: section, 'data-fig-workbench-tasks': '' },
      entry?.component ? h(entry.component, { ...props, t: wb.ctx().locale.bind(entry.locale ?? 'conversation') })
        : h('div', { style: muted }, t('card.theTaskListIsUnavailable')))
  }

  function Card({ sessionId, mode, style, useProjection }) {
    const status = useSyncExternalStore(store.subscribeData, () => store.statuses.get(sessionId))
    // Repository and outputs refresh on open/turn/focus; Pulls owns visible-only CI polling.
    const running = useSessionRunning(sessionId)
    useEffect(() => { store.refreshAll(sessionId, true) }, [sessionId])
    const wasRunning = useRef(running)
    useEffect(() => {
      if (wasRunning.current && !running) store.refreshAll(sessionId)
      wasRunning.current = running
    }, [running, sessionId])
    useEffect(() => {
      const focus = () => store.refreshAll(sessionId)
      window.addEventListener('focus', focus)
      return () => window.removeEventListener('focus', focus)
    }, [sessionId])
    const readAt = status?.value?.readAt ? new Date(status.value.readAt).toLocaleTimeString() : ''
    return h('div', { 'data-fig-workbench': mode, role: 'region', 'aria-label': t('card.developmentWorkbench'),
      style: { width: CARD_WIDTH, boxSizing: 'border-box', borderRadius: 12, background: colors.card, color: colors.primary,
        border: '.5px solid ' + colors.border, overflowY: 'auto', fontSize: 13, ...style } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '10px 10px 4px 14px' } },
      h('span', { style: { fontWeight: 600, flex: 1 } }, t('card.developmentWorkbench')),
      h('button', { type: 'button', className: 'fig-wb-link', disabled: status?.loading, onClick: () => store.refreshAll(sessionId, true),
        'aria-label': t('card.refresh') + (readAt ? t('card.lastRead', { readAt }) : '') },
      status?.loading ? t('card.readingShort') : t('card.refresh')),
      h(Menu, { sessionId, status })),
    h(Repository, { sessionId, status, running }),
    status?.value?.repository && h('div', { style: divider }),
    status?.value?.repository && h(Pulls, { sessionId, repository: status.value.repository, running }),
    h('div', { style: divider }),
    h(Outputs, { sessionId }),
    h('div', { style: divider }),
    h(Tasks, { useProjection }),
    h('div', { style: divider }),
    h(Jobs, { sessionId }))
  }

  return { Card, Tasks }
}
