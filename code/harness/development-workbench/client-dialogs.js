import { t } from './client-locale.js'
import { alertText, colors, dialogButton, ellipsis, field, mono, muted, rowStyle, textInput } from './client-theme.js'
import { language, logError } from './client-store.js'

// The 研发工作台's confirmations: 提交… (pick files, then the Session's Agent commits them) and one dialog for every
// other action (push, pull request, fixes, merge, worktrees, auto-fix): what will happen, one confirmation, then one
// request to the Host, which checks again and sends the Agent one fixed instruction.

/** What the Agent is asked to fix, by kind. */
export const fixLabels = () => ({ ci: t('dialogs.fixCi'), conflict: t('dialogs.resolveConflict'), review: t('dialogs.addressReview') })
const methodLabels = () => ({ squash: t('dialogs.squashAndMerge'), merge: t('dialogs.createAMergeCommit'), rebase: t('dialogs.rebaseAndMerge') })
const cannotSend = () => t('dialogs.couldNotSendTryAgain')

/** What a refusal means, for the dialog. */
const refusals = () => ({
  running: t('dialogs.theSessionIsRunningTry'),
  changed: t('dialogs.theRepositoryOrPullRequest'),
  nothing: t('dialogs.nothingToPush'),
  base: t('dialogs.theBaseBranchIsNot'),
  detached: t('dialogs.notOnABranch'),
  'branch-name': t('dialogs.theBranchNameHasUnsupported'),
  'no-remote': t('dialogs.theRepositoryHasNoOrigin'),
  'not-repository': t('dialogs.thisFolderIsNotA'),
  'off-branch': t('dialogs.theSessionIsNotOn'),
  'unknown-pull': t('dialogs.thisPullRequestIsNot'),
  'not-ready': t('dialogs.thisPullRequestCannotBe'),
  'no-gh': t('dialogs.theGhCliWasNot'),
  exists: t('dialogs.thatBranchAlreadyExistsPick'),
  'path-exists': t('dialogs.theWorktreeFolderAlreadyExists'),
  pool: t('dialogs.agentsWorktreesIsNotA'),
  'on-branch': t('dialogs.theSessionIsAlreadyOn'),
  'other-repo': t('dialogs.thisPullRequestIsIn'),
  'checked-out': t('dialogs.thisBranchIsCheckedOut'),
  'not-fetched': t('dialogs.thisBranchIsNotOn'),
  'no-workspace': t('dialogs.theSessionsWorkspaceWasNot'),
  'worktree-dirty': t('dialogs.theWorktreeHasUncommittedChanges'),
  'worktree-open': t('dialogs.anOpenSessionUsesThis'),
  'worktree-current': t('dialogs.thisSessionWorksInIt'),
  'worktree-main': t('dialogs.theMainCheckoutCannotBe'),
  'worktree-foreign': t('dialogs.notCreatedByFigUse'),
  'worktree-locked': t('dialogs.theWorktreeIsLocked'),
  'signed-out': t('dialogs.ghIsNotSignedIn'),
  failed: t('dialogs.couldNotReadThePull')
})

/**
 * One action dialog's text and request: title, confirm label, the endpoint and payload it posts, the body and an extra
 * note. `data` is what the card passed when it opened the dialog; `fields` what the user set in it.
 * @param {string} kind @param {any} data
 * @param {{ base: string, draft: boolean, options?: { head: string, methods: string[] }, method: string, deleteBranch: boolean,
 *   branch: string, from: string, message: string, fix: boolean }} fields
 * @returns {{ title: string, confirm: string, endpoint: string, payload: Record<string, any>, body: string, extra?: string }}
 */
export function actionSpec(kind, data, { base, draft, options, method, deleteBranch, branch, from, message, fix }) {
  const pull = data.pull
  return {
    extension: { title: data.action?.label, confirm: t('dialogs.confirmExtension'), endpoint: 'run-action', payload: { token: data.action?.token }, body: '' },
    push: { title: t('dialogs.pushBranch'), confirm: t('dialogs.askTheAgentToPush'), endpoint: 'push', payload: { head: data.head },
      body: data.upstream ? t(data.ahead === 1 ? 'dialogs.push.body.one' : 'dialogs.push.body.other', { branch: data.branch, ahead: data.ahead, upstream: data.upstream })
        : t('dialogs.hasNoUpstreamYetRuns', { branch: data.branch }),
      extra: data.behind > 0 ? t(data.behind === 1 ? 'dialogs.push.behind.one' : 'dialogs.push.behind.other', { behind: data.behind }) : '' },
    pull: { title: t('dialogs.createPullRequest'), confirm: t('dialogs.askTheAgentToCreate'), endpoint: 'create-pull', payload: { head: data.head, base, draft },
      body: t('dialogs.pull.body', { branch: data.branch, pushFirst: data.pushed ? '' : t('dialogs.pull.pushFirst') }) },
    fix: { title: fixLabels()[data.kind], confirm: t('dialogs.askTheAgent'), endpoint: 'fix', payload: { url: pull?.url, kind: data.kind, head: pull?.head },
      body: t('dialogs.fix.body', { number: pull?.number, title: pull?.title, branch: pull?.branch, action: t(`dialogs.fix.action.${/** @type {'ci' | 'conflict' | 'review'} */ (data.kind)}`) }) },
    merge: { title: t('dialogs.mergePullRequest'), confirm: t('dialogs.askTheAgentToMerge'), endpoint: 'merge', payload: { url: pull?.url, head: options?.head, method, deleteBranch },
      body: options ? t('dialogs.prMergingOnlyTheCurrent', { number: pull?.number, title: pull?.title, slice: options.head.slice(0, 7) }) : '' },
    threads: { title: t('dialogs.askTheAgentToAddress'), confirm: t('dialogs.askTheAgent'), endpoint: 'fix',
      payload: { url: pull?.url, kind: 'review', head: pull?.head, threads: data.threads === 'all' ? 'all' : data.threads?.map(thread => thread.id) },
      body: data.threads === 'all'
        ? t('dialogs.threads.bodyAll', { number: pull?.number, count: pull?.review?.threads.length ?? '', branch: pull?.branch })
        : t('dialogs.threads.bodyOne', { number: pull?.number, branch: pull?.branch }) },
    worktree: { title: t('dialogs.newSessionInANew'), confirm: t('dialogs.createAndOpen'), endpoint: 'create-worktree',
      payload: { branch, from, message }, body: t('dialogs.createsABranchAndWorktree') },
    'pull-worktree': { title: t('dialogs.handleThePullRequestIn'), confirm: t('dialogs.createAndOpen'), endpoint: 'pull-worktree',
      payload: { url: pull?.url, fix }, body: t('dialogs.createsAWorktreeOnFor', { number: pull?.number, branch: pull?.branch }) },
    'remove-worktree': { title: t('dialogs.removeWorktree'), confirm: t('dialogs.remove'), endpoint: 'remove-worktree',
      payload: { path: data.entry?.path, deleteBranch }, body: t('dialogs.removesGitWorktreeRemoveNo', { display: data.entry?.display, branch: data.entry?.branch ?? '' }) },
    autofix: { title: data.on ? t('dialogs.turnOnAutoFix') : t('dialogs.turnOffAutoFix'), endpoint: 'autofix', payload: { url: pull?.url, on: data.on },
      confirm: data.on ? t('dialogs.turnOn') : t('dialogs.turnOff'),
      body: data.on ? t('dialogs.figWatchesPrInThe', { number: pull?.number })
        : t('dialogs.noMoreFixInstructionsAre') }
  }[kind]
}

/** @param {any} entry - a changed file from the Host */
const badge = entry => entry.untracked ? t('dialogs.new') : entry.deleted ? t('dialogs.deleted')
  : entry.renamed ? t('dialogs.renamed') : entry.partial ? t('dialogs.partlyStaged') : entry.staged ? t('dialogs.staged') : ''

/** @param {any} wb - the workbench's shared parts (client-workbench.js) */
export function dialogs(wb) {
  const { h, call, store } = wb
  const { useEffect, useState } = wb.react
  const { DialogShell } = wb.ui

  /**
   * Posts one dialog's request, the dialog showing 发送中… meanwhile. Resolves to `{ value }`, or undefined when the call
   * failed (the dialog then says so and can be sent again).
   * @param {string} endpoint @param {Record<string, any>} payload @param {(phase: string) => void} setPhase @param {(notice: string) => void} setNotice
   */
  const sendAction = (endpoint, payload, setPhase, setNotice) => {
    setPhase('sending'); setNotice('')
    return call(endpoint, { language: language(), ...payload }).then(value => ({ value }), () => { setPhase('ready'); setNotice(cannotSend()); return undefined })
  }
  /** Cancel and the confirm button. */
  const footer = (phase, close, confirm) => h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
    h('button', { type: 'button', style: dialogButton, disabled: phase === 'sending', onClick: close }, t('dialogs.cancel')), confirm)

  /** 提交: pick files, then the Session's Agent commits them with a message it drafts (reviewed in its approval). */
  function CommitDialog({ sessionId }) {
    const [list, setList] = useState(/** @type {any} */ (undefined))
    const [picked, setPicked] = useState(/** @type {Set<string>} */ (new Set()))
    const [phase, setPhase] = useState(/** @type {string} */ ('loading'))
    const [notice, setNotice] = useState('')
    const close = () => store.setState({ ...store.state, commitFor: undefined })
    /** Tracked changes start picked, new files do not; a re-read keeps the user's picks that still exist. */
    const take = (value, keep) => {
      setList(value)
      const paths = new Set(value.files.map(entry => entry.path))
      setPicked(new Set(keep ? [...keep].filter(path => paths.has(path)) : value.files.filter(entry => !entry.untracked).map(entry => entry.path)))
      setPhase('ready')
    }
    useEffect(() => {
      call('commit-files', { session: sessionId }).then(value => take(value), () => setPhase('failed'))
    }, [sessionId])
    const send = async () => {
      const reply = await sendAction('commit', { session: sessionId, files: [...picked], token: list.token }, setPhase, setNotice)
      if (!reply) return
      const value = reply.value
      if (value?.sent) { close(); setTimeout(() => store.statuses.load(sessionId), 300); return }
      if (value?.refused === 'changed') { take(value, picked); setNotice(t('dialogs.filesChangedSinceYouOpened')); return }
      setPhase('ready')
      setNotice(value?.refused === 'running' ? t('dialogs.theSessionIsRunningCommit') : cannotSend())
    }
    const toggle = path => { const next = new Set(picked); if (next.has(path)) next.delete(path); else next.add(path); setPicked(next) }
    const files = list?.files ?? []
    const all = files.length > 0 && files.every(entry => picked.has(entry.path))
    const partial = files.filter(entry => entry.partial && picked.has(entry.path)).length
    return h(DialogShell, { attributes: { 'data-fig-commit-dialog': '' }, title: t('dialogs.commitChanges'), width: 560, maxHeight: 'calc(100vh - 64px)', busy: phase === 'sending', close },
      list?.branch && h('div', { style: muted }, t('dialogs.branch') + list.branch),
      phase === 'loading' ? h('div', { style: muted }, t('dialogs.readingChanges'))
        : phase === 'failed' ? h('div', { style: muted }, t('dialogs.couldNotReadTheChanges'))
          : files.length === 0 ? h('div', { style: muted }, t('dialogs.nothingToCommit'))
            : [
              h('label', { key: 'all', style: { ...rowStyle, gap: 8, borderBottom: '.5px solid ' + colors.border, paddingBottom: 6 } },
                h('input', { type: 'checkbox', checked: all, onChange: () => setPicked(all ? new Set() : new Set(files.map(entry => entry.path))) }),
                h('span', { style: { flex: 1 } }, t('dialogs.allFiles', { filesCount: files.length })),
                h('span', { style: muted }, t('dialogs.picked', { size: picked.size }))),
              h('div', { key: 'files', style: { overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                files.map(entry => h('label', { key: entry.path, 'data-fig-commit-file': entry.path, title: entry.from ? `${entry.from} → ${entry.path}` : entry.path,
                  style: { ...rowStyle, gap: 8, cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: picked.has(entry.path), onChange: () => toggle(entry.path) }),
                h('span', { style: { ...ellipsis, flex: 1, fontFamily: mono, fontSize: 12.5 } }, entry.path),
                badge(entry) && h('span', { style: muted }, badge(entry)))))
            ],
      h('div', { style: { ...muted, lineHeight: '18px' } }, t('dialogs.theSessionsAgentReadsThe')),
      partial > 0 && h('div', { 'data-fig-commit-partial': partial, style: { fontSize: 12.5, lineHeight: '18px', color: colors.deleted } }, t(partial === 1 ? 'dialogs.commit.partial.one' : 'dialogs.commit.partial.other', { partial })),
      notice && h('div', { role: 'alert', style: alertText }, notice),
      footer(phase, close, h('button', { type: 'button', 'data-fig-commit-send': '', style: { ...dialogButton, fontWeight: 600 }, disabled: phase !== 'ready' || picked.size === 0, onClick: send },
        phase === 'sending' ? t('dialogs.sending') : t('dialogs.askTheAgentToCommit', { size: picked.size }))))
  }

  /** The inputs one kind of action takes: base and draft, merge method, new branch, first message, branch deletion. */
  function ActionFields({ kind, data, fields, set, phase, fetchable, fetchBranch }) {
    const { base, draft, options, method, deleteBranch, branch, from, message, fix } = fields
    const value = event => /** @type {HTMLInputElement} */ (event.target).value
    return [
      kind === 'pull' && h('label', { key: 'base', style: field }, h('span', { style: { flex: 'none' } }, t('dialogs.base')),
        h('input', { 'data-fig-action-base': '', value: base, onChange: event => set({ base: value(event).trim() }), style: textInput })),
      kind === 'pull' && h('label', { key: 'draft', style: field }, h('input', { type: 'checkbox', 'data-fig-action-draft': '', checked: draft, onChange: () => set({ draft: !draft }) }), t('dialogs.createAsDraft')),
      kind === 'merge' && options && h('div', { key: 'merge', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        ...options.methods.map(id => h('label', { key: id, style: field }, h('input', { type: 'radio', name: 'fig-merge-method', 'data-fig-action-method': id, checked: method === id, onChange: () => set({ method: id }) }), methodLabels()[id] ?? id)),
        data.pull?.source !== 'extension' && h('label', { style: field }, h('input', { type: 'checkbox', 'data-fig-action-delete': '', checked: deleteBranch, onChange: () => set({ deleteBranch: !deleteBranch }) }),
          t('dialogs.deleteTheRemoteBranchAfter', { branch: data.pull.branch }))),
      ...(kind === 'worktree' ? [
        h('label', { key: 'b', style: field }, h('span', { style: { flex: 'none' } }, t('dialogs.newBranch')),
          h('input', { 'data-fig-action-branch': '', value: branch, onChange: event => set({ branch: value(event).trim() }), style: textInput })),
        h('label', { key: 'h', style: field }, h('input', { type: 'radio', name: 'fig-worktree-from', 'data-fig-action-from': 'head', checked: from === 'head', onChange: () => set({ from: 'head' }) }),
          t('dialogs.fromTheCurrentCommit', { commit: data.head ?? '' })),
        data.base && h('label', { key: 'f', style: field }, h('input', { type: 'radio', name: 'fig-worktree-from', 'data-fig-action-from': 'base', checked: from === 'base', onChange: () => set({ from: 'base' }) }),
          t('dialogs.fromTheBaseAsRecorded', { base: data.base })),
        h('textarea', { key: 'm', 'data-fig-action-message': '', rows: 3, value: message, placeholder: t('dialogs.firstMessageForTheNew'),
          onChange: event => set({ message: value(event) }),
          style: { font: 'inherit', fontSize: 13, padding: 6, borderRadius: 6, border: '.5px solid ' + colors.border, background: 'transparent', color: colors.primary, resize: 'vertical' } })] : []),
      kind === 'pull-worktree' && data.kinds?.length > 0 && h('label', { key: 'fix', style: field }, h('input', { type: 'checkbox', 'data-fig-action-fix': '', checked: fix, onChange: () => set({ fix: !fix }) }),
        t('dialogs.firstMessage', { message: fixLabels()[data.kinds[0]] })),
      kind === 'pull-worktree' && fetchable && h('button', { key: 'fetch', type: 'button', 'data-fig-action-fetch': '', style: { ...dialogButton, alignSelf: 'flex-start' }, disabled: phase === 'sending', onClick: fetchBranch },
        t('dialogs.askThisSessionToFetch')),
      kind === 'remove-worktree' && data.entry?.merged && h('label', { key: 'delete', style: field }, h('input', { type: 'checkbox', 'data-fig-action-delete': '', checked: deleteBranch, onChange: () => set({ deleteBranch: !deleteBranch }) }),
        t('dialogs.alsoDeleteTheMergedLocal', { branch: data.entry.branch }))
    ]
  }

  /** Push, pull request, fix, merge and auto-fix: what the Agent will be asked, one confirmation, then one instruction. */
  function ActionDialog({ action }) {
    const { sessionId, kind, data } = action
    const [phase, setPhase] = useState(kind === 'merge' ? 'loading' : 'ready')
    const [notice, setNotice] = useState('')
    const [fields, setFields] = useState(() => ({ base: data.base ?? '', draft: false, options: /** @type {any} */ (undefined), method: '', deleteBranch: false,
      branch: kind === 'worktree' ? data.branchFor ?? 'fig/' + Math.random().toString(16).slice(2, 8) : '', from: 'head', message: '', fix: Boolean(data.kinds?.length) }))
    const set = patch => setFields(current => ({ ...current, ...patch }))
    const [fetchable, setFetchable] = useState(false)
    const close = () => store.setState({ ...store.state, action: undefined })
    useEffect(() => {
      if (kind !== 'merge') return
      // The dialog may close before the options arrive; a late reply then changes nothing.
      let live = true
      call('merge-options', { session: sessionId, url: data.pull.url }).then(value => {
        if (!live) return
        if (value?.refused || value?.problem) { setNotice(refusals()[value.refused ?? value.problem] ?? refusals().failed); setPhase('failed'); return }
        set({ options: value, method: value.methods.includes('squash') ? 'squash' : value.methods[0] ?? '' }); setPhase('ready')
      }, () => { if (live) { setNotice(refusals().failed); setPhase('failed') } })
      return () => { live = false }
    }, [])
    const spec = actionSpec(kind, data, fields)
    const send = async () => {
      const reply = await sendAction(spec.endpoint, { session: sessionId, ...spec.payload }, setPhase, setNotice)
      if (!reply) return
      const value = reply.value
      if (value?.sent || value?.autofix || value?.removed || value?.sessionId || value?.completed) {
        close(); setTimeout(() => store.refreshAll(sessionId, true), 300)
        if (value.sessionId) { try { wb.workspace()?.openSession?.(value.sessionId) } catch (error) { logError(error) } }
        return
      }
      if (value?.refused === 'not-fetched') setFetchable(true)
      setPhase('ready'); setNotice((refusals()[value?.refused ?? value?.problem] ?? t('dialogs.couldNotFinishTryAgain')) + (value?.path ? ' ' + value.path : ''))
    }
    const fetchBranch = async () => {
      const reply = await sendAction('fetch-branch', { session: sessionId, url: data.pull.url }, setPhase, setNotice)
      if (!reply) return
      if (reply.value?.sent) { close(); return }
      setPhase('ready'); setNotice(refusals()[reply.value?.refused ?? reply.value?.problem] ?? cannotSend())
    }
    const { base, method, branch } = fields
    return h(DialogShell, { attributes: { 'data-fig-action-dialog': kind }, title: spec.title, width: 500, busy: phase === 'sending', close },
      phase === 'loading' ? h('div', { style: muted }, t('dialogs.reading')) : spec.body && h('div', { style: { fontSize: 13, lineHeight: '19px' } }, spec.body),
      spec.extra && h('div', { style: { ...muted, lineHeight: '18px' } }, spec.extra),
      h(ActionFields, { kind, data, fields, set, phase, fetchable, fetchBranch }),
      !['autofix', 'worktree', 'remove-worktree', 'pull-worktree', 'extension'].includes(kind) && h('div', { style: { ...muted, lineHeight: '18px' } }, t('dialogs.theCommandsAppearInThe')),
      notice && h('div', { role: 'alert', style: alertText }, notice),
      footer(phase, close, h('button', { type: 'button', 'data-fig-action-send': '', style: { ...dialogButton, fontWeight: 600 },
        disabled: phase !== 'ready' || (kind === 'pull' && !base) || (kind === 'merge' && !method) || (kind === 'worktree' && !branch), onClick: send },
      phase === 'sending' ? t('dialogs.sending') : spec.confirm)))
  }

  return { CommitDialog, ActionDialog }
}
