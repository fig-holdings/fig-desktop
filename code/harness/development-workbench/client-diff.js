import { isZh } from '../shared/page-locale.js'
import { t } from './client-locale.js'
import { parsePullUrl } from './actions.js'
import { colors, mono } from './client-theme.js'
import { parseResourceAddress, registerResourceTab, resourcePrefix } from './client-resource-tab.js'

// 代码变更: a right-sidebar tab with the changed files of one Session, uncommitted or against the branch's base, as a
// unified diff. The 研发工作台 card opens it; the tab switches scope and refreshes itself. Read-only.

export const diffProtocol = 'figdevdiff'
export const diffTypeId = 'fig-development-diff'
const diffPrefix = resourcePrefix(diffProtocol)
/** Files with more drawn lines than this start folded. */
const FOLD_FROM = 400

/** @param {string} session @param {'uncommitted' | 'branch' | 'pull' | 'compare'} scope @param {string} [value] - PR address or comparison handle */
export const diffAddress = (session, scope, value) => `${diffPrefix}session/${encodeURIComponent(session)}?scope=${scope}` +
  (scope === 'pull' && value ? '&url=' + encodeURIComponent(value) : scope === 'compare' && value ? '&handle=' + encodeURIComponent(value) : '')

/** {session, scope} for a 代码变更 address, else undefined. @param {string} address */
export function parseDiffAddress(address) {
  const parsed = parseResourceAddress(address, diffProtocol)
  const scope = parsed?.params.get('scope')
  if (!parsed || (scope !== 'uncommitted' && scope !== 'branch' && scope !== 'pull' && scope !== 'compare')) return undefined
  const pull = parsed.params.get('url')
  if (scope === 'pull' && !parsePullUrl(pull)) return undefined
  const handle = parsed.params.get('handle')
  if (scope === 'compare' && (!handle || !/^[a-f0-9-]{36}$/.test(handle))) return undefined
  return { session: parsed.session, scope, ...(scope === 'pull' ? { url: pull ?? undefined } : {}), ...(scope === 'compare' ? { handle: handle ?? undefined } : {}) }
}

/** Totals of a diff reply. @param {{ files?: { added: number, deleted: number }[] } | undefined} value */
export const diffTotals = value => (value?.files ?? []).reduce((/** @type {{ files: number, added: number, deleted: number }} */ sum, file) => ({ files: sum.files + 1, added: sum.added + file.added, deleted: sum.deleted + file.deleted }), { files: 0, added: 0, deleted: 0 })

/** Lines one comment may quote. */
const MAX_QUOTED_LINES = 200

/**
 * The quote a line comment puts in the Session's input: file, side and lines, the comparison, the selected diff lines
 * in a fence longer than any backtick run inside, and the comment. Nothing is sent; the user sends the draft.
 * @param {{ path: string, scope: 'uncommitted' | 'branch', base?: string | null, lines: { kind: string, text: string, old?: number, new?: number }[],
 *   comment: string, chinese: boolean }} input
 */
export function formatLineComment({ path, scope, base, lines, comment, chinese }) {
  const span = /** @param {number[]} numbers */ numbers => {
    const low = Math.min(...numbers), high = Math.max(...numbers)
    return low === high ? String(low) : `${low}-${high}`
  }
  const news = lines.flatMap(line => line.new === undefined ? [] : [line.new])
  const olds = lines.flatMap(line => line.old === undefined ? [] : [line.old])
  const where = news.length ? (chinese ? `新版第 ${span(news)} 行` : `new lines ${span(news)}`) : (chinese ? `旧版第 ${span(olds)} 行` : `old lines ${span(olds)}`)
  const compared = scope === 'branch' ? (chinese ? `分支对比，基线 ${base ?? ''}` : `branch, vs ${base ?? ''}`) : (chinese ? '未提交改动' : 'uncommitted changes')
  const body = lines.map(line => (line.kind === ' ' ? ' ' : line.kind) + line.text).join('\n')
  const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), match => match[0].length + 1)))
  const note = comment.trim()
  return [chinese ? `代码评论：${path}，${where}（${compared}）` : `Code comment: ${path}, ${where} (${compared})`, fence + 'diff', body, fence,
    ...(note ? [(chinese ? '评论：' : 'Comment: ') + note] : [])].join('\n')
}

/**
 * Where a review comment on the selected lines anchors on GitHub: the new side when any selected line has a new number
 * (the last as `line`, the first as `startLine` for a range), else the old side.
 * @param {{ old?: number, new?: number }[]} lines
 * @returns {{ line: number, side: 'LEFT' | 'RIGHT', startLine?: number } | undefined}
 */
export function commentAnchor(lines) {
  const news = lines.flatMap(line => line.new === undefined ? [] : [line.new])
  const numbers = news.length ? news : lines.flatMap(line => line.old === undefined ? [] : [line.old])
  if (!numbers.length) return undefined
  const line = Math.max(...numbers), start = Math.min(...numbers)
  return { line, side: news.length ? 'RIGHT' : 'LEFT', ...(start < line ? { startLine: start } : {}) }
}

/** A pull request's review draft: comments written against `head`, kept in this viewer's browser until submitted. */
const draftKey = url => 'fig.developmentWorkbench.review:' + url
/** @param {string} url @returns {{ head: string, comments: any[] }} */
export function readDraft(url) {
  try { const value = JSON.parse(localStorage.getItem(draftKey(url)) ?? 'null'); return value && Array.isArray(value.comments) ? value : { head: '', comments: [] } } catch { return { head: '', comments: [] } }
}
/** @param {string} url @param {{ head: string, comments: any[] }} draft */
function writeDraft(url, draft) {
  try { if (draft.comments.length) localStorage.setItem(draftKey(url), JSON.stringify(draft)); else localStorage.removeItem(draftKey(url)) } catch { /* a draft is a convenience */ }
}

/**
 * @param {typeof import('react')} react
 * @param {(endpoint: string, payload: any) => Promise<any>} call
 * @param {(session: string, text: string) => boolean} [quote] - puts a quote in the Session's input; false when it cannot
 */
export function diffTab(react, call, quote = () => false, subscribe = (_listener = () => {}) => () => {}, getEpoch = () => 0) {
  const { createElement: h, useEffect, useState, useSyncExternalStore } = react
  const numberCell = { padding: '0 6px', color: colors.secondary, textAlign: 'right', userSelect: 'none', minWidth: 32, cursor: 'pointer' }

  /** The comment box under a selection. */
  function CommentBox({ count, onAdd, onCancel, review }) {
    const [value, setValue] = useState('')
    const button = { border: '.5px solid ' + colors.border, background: 'transparent', color: colors.primary, font: 'inherit', fontSize: 12, padding: '3px 10px', borderRadius: 6, cursor: 'pointer' }
    return h('div', { 'data-fig-diff-comment': '', style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px', fontFamily: 'inherit', whiteSpace: 'normal' } },
      h('textarea', { 'data-fig-diff-comment-text': '', autoFocus: true, rows: 3, value, placeholder: t(count === 1 ? 'diff.commentLines.one' : 'diff.commentLines.other', { count }),
        onChange: event => setValue(/** @type {HTMLTextAreaElement} */ (event.target).value),
        onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onAdd(value) },
        style: { font: 'inherit', fontSize: 12.5, padding: 6, borderRadius: 6, border: '.5px solid ' + colors.border, background: 'transparent', color: colors.primary, resize: 'vertical' } }),
      h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
        h('button', { type: 'button', style: button, onClick: onCancel }, t('diff.cancel')),
        h('button', { type: 'button', 'data-fig-diff-comment-add': '', disabled: review && !value.trim(), style: { ...button, fontWeight: 600 }, onClick: () => onAdd(value) },
          review ? t('diff.addToReview') : t('diff.addToInput'))))
  }
  const tab = { border: 0, borderRadius: 6, padding: '3px 10px', font: 'inherit', fontSize: 12, cursor: 'pointer' }

  /** `selection`: { path, hunk, from, to } (rows within one hunk); `select(path, hunk, row, extend)`; `comment(text)`. */
  function FileDiff({ file, selection, select, comment, clear, review }) {
    const lines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    const [open, setOpen] = useState(lines <= FOLD_FROM)
    const badge = file.binary ? t('diff.binary') : file.untracked ? t('diff.newUntracked')
      : file.status === 'added' ? t('diff.new') : file.status === 'deleted' ? t('diff.deleted')
        : file.status === 'renamed' ? t('diff.renamed') : ''
    const name = file.path.split('/').pop()
    const folder = file.path.slice(0, file.path.length - name.length)
    return h('section', { 'data-fig-diff-file': file.path, style: { borderBottom: '.5px solid ' + colors.border } },
      h('button', { type: 'button', 'aria-expanded': open, onClick: () => setOpen(!open), title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
        style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', border: 0, background: colors.layer,
          color: colors.primary, font: 'inherit', fontSize: 12.5, cursor: 'pointer', textAlign: 'left', position: 'sticky', top: 0, zIndex: 1 } },
      h('span', { 'aria-hidden': 'true', style: { color: colors.secondary, width: 10 } }, open ? '▾' : '▸'),
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' } },
        h('bdi', null, h('span', { style: { fontWeight: 600 } }, name), h('span', { style: { color: colors.secondary, marginLeft: 6, fontSize: 11.5 } }, folder))),
      badge && h('span', { style: { color: colors.secondary, fontSize: 11, whiteSpace: 'nowrap' } }, badge),
      h('span', { style: { color: colors.added, fontSize: 11.5, fontVariantNumeric: 'tabular-nums' } }, '+' + file.added),
      h('span', { style: { color: colors.deleted, fontSize: 11.5, fontVariantNumeric: 'tabular-nums' } }, '−' + file.deleted)),
    open && (file.binary || file.omitted
      ? h('div', { style: { padding: '10px 14px', fontSize: 12, color: colors.secondary } },
        file.binary ? t('diff.binaryFileNotShown') : t('diff.tooLargeToShow'))
      : h('div', { style: { overflowX: 'auto' } },
        h('table', { style: { borderCollapse: 'collapse', fontFamily: mono, fontSize: 12, lineHeight: '18px', minWidth: '100%' } },
          h('tbody', null, file.hunks.flatMap((hunk, index) => [
            h('tr', { key: 'h' + index }, h('td', { colSpan: 3, style: { padding: '2px 12px', color: colors.secondary, whiteSpace: 'pre', fontSize: 11.5 } }, hunk.header)),
            ...hunk.lines.flatMap((line, row) => {
              const mine = selection && selection.path === file.path && selection.hunk === index
              const low = mine ? Math.min(selection.from, selection.to) : -1, high = mine ? Math.max(selection.from, selection.to) : -1
              const picked = row >= low && row <= high
              const pick = event => select(file.path, index, row, event.shiftKey)
              const title = t('diff.clickALineNumberTo')
              const tr = h('tr', { key: index + ':' + row, 'data-fig-diff-line': `${index}:${row}`, 'data-selected': picked ? '' : undefined,
                style: { background: picked ? colors.selected : line.kind === '+' ? colors.addedBg : line.kind === '-' ? colors.deletedBg : undefined,
                  boxShadow: picked ? `inset 2px 0 0 ${colors.accent}` : undefined } },
              h('td', { style: numberCell, title, onClick: pick, 'data-fig-diff-number': 'old' }, line.old ?? ''),
              h('td', { style: numberCell, title, onClick: pick, 'data-fig-diff-number': 'new' }, line.new ?? ''),
              h('td', { style: { padding: '0 12px 0 4px', whiteSpace: 'pre', color: colors.primary, width: '100%' } }, (line.kind === ' ' ? ' ' : line.kind) + ' ' + line.text))
              if (!picked || row !== high) return [tr]
              return [tr, h('tr', { key: index + ':' + row + ':comment' }, h('td', { colSpan: 3, style: { background: colors.layer } },
                h(CommentBox, { key: `${low}-${high}`, count: high - low + 1, onAdd: comment, onCancel: clear, review })))]
            })
          ]))),
        file.truncated > 0 && h('div', { style: { padding: '6px 14px', fontSize: 12, color: colors.secondary } },
          t('diff.moreLinesNotShown', { truncated: file.truncated })))))
  }

  const verdicts = () => [['COMMENT', t('diff.comment')], ['APPROVE', t('diff.approve')], ['REQUEST_CHANGES', t('diff.requestChanges')]]

  /** 评审草稿: the comments so far, a summary and a verdict; 提交评审 asks once more, then posts exactly this. */
  function ReviewPanel({ session, url, value, draft, setDraft }) {
    const [body, setBody] = useState('')
    const [event, setEvent] = useState('COMMENT')
    const [phase, setPhase] = useState('editing')
    const [notice, setNotice] = useState('')
    const stale = draft.comments.length > 0 && draft.head !== value.head
    const empty = event !== 'APPROVE' && !body.trim() && !draft.comments.length
    const button = { border: '.5px solid ' + colors.border, background: 'transparent', color: colors.primary, font: 'inherit', fontSize: 12, padding: '4px 12px', borderRadius: 6, cursor: 'pointer' }
    const submit = () => {
      setPhase('sending'); setNotice('')
      call('submit-review', { session, url, head: value.head, event, body,
        comments: draft.comments.map(({ path, line, side, startLine, body: note }) => ({ path, line, side, ...(startLine ? { startLine } : {}), body: note })) }).then(reply => {
        if (reply?.submitted) { setDraft({ head: value.head, comments: [] }); setBody(''); setPhase('done'); setNotice(reply.url || ''); return }
        setPhase('editing')
        setNotice(reply?.refused === 'changed' ? t('diff.thePullRequestMovedOr')
          : (reply?.message ? t('diff.githubRefused') + reply.message : t('diff.couldNotSubmitTryAgain')))
      }, () => { setPhase('editing'); setNotice(t('diff.couldNotSubmitTryAgain')) })
    }
    return h('div', { 'data-fig-review-panel': '', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderBottom: '.5px solid ' + colors.border, fontSize: 12.5 } },
      draft.comments.length === 0 ? h('div', { style: { color: colors.secondary } }, t('diff.clickLineNumbersToSelect'))
        : draft.comments.map(item => h('div', { key: item.id, 'data-fig-review-comment': item.id, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
          h('span', { style: { fontFamily: mono, fontSize: 11.5, color: colors.secondary, flex: 'none' } }, `${item.path}:${item.startLine ? item.startLine + '-' : ''}${item.line}${item.side === 'LEFT' ? t('diff.old') : ''}`),
          h('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, item.body),
          h('button', { type: 'button', 'aria-label': t('diff.remove'), style: { ...button, padding: '0 6px' }, disabled: phase === 'sending',
            onClick: () => setDraft({ ...draft, comments: draft.comments.filter(each => each.id !== item.id) }) }, '×'))),
      stale && h('div', { role: 'alert', style: { color: colors.deleted } }, t('diff.theDraftWasWrittenAgainst')),
      h('textarea', { 'data-fig-review-body': '', rows: 3, value: body, placeholder: t('diff.summaryOptional'), onChange: e => setBody(/** @type {HTMLTextAreaElement} */ (e.target).value),
        style: { font: 'inherit', fontSize: 12.5, padding: 6, borderRadius: 6, border: '.5px solid ' + colors.border, background: 'transparent', color: colors.primary, resize: 'vertical' } }),
      h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, ...verdicts().map(([id, label]) => h('label', { key: id, style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
        h('input', { type: 'radio', name: 'fig-review-event-' + url, 'data-fig-review-event': id, checked: event === id, onChange: () => setEvent(id) }), label))),
      notice && h('div', { role: phase === 'done' ? 'status' : 'alert', 'data-fig-review-notice': phase, style: { color: phase === 'done' ? colors.added : colors.deleted, overflowWrap: 'anywhere' } },
        phase === 'done' ? t('diff.reviewSubmitted') + notice : notice),
      h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' } },
        draft.comments.length > 0 && h('button', { type: 'button', style: button, disabled: phase === 'sending', onClick: () => setDraft({ head: value.head, comments: [] }) }, t('diff.clearDraft')),
        phase === 'confirm' ? [
          h('span', { key: 'q', style: { color: colors.secondary } }, t(draft.comments.length === 1 ? 'diff.postReview.one' : 'diff.postReview.other', { verdict: verdicts().find(each => each[0] === event)?.[1] ?? '', count: draft.comments.length })),
          h('button', { key: 'n', type: 'button', style: button, onClick: () => setPhase('editing') }, t('diff.back')),
          h('button', { key: 'y', type: 'button', 'data-fig-review-confirm': '', style: { ...button, fontWeight: 600 }, disabled: stale || empty || !value.open, onClick: submit }, t('diff.submit'))]
          : h('button', { type: 'button', 'data-fig-review-submit': '', style: { ...button, fontWeight: 600 }, disabled: phase === 'sending' || stale || empty || !value.open,
            onClick: () => setPhase('confirm') }, phase === 'sending' ? t('diff.submitting') : t('diff.submitReview'))))
  }

  /**
   * The diff of one scope (or pull request), read again on `reload`. A reply for another scope is not shown.
   * @param {string} session @param {'uncommitted' | 'branch' | 'pull' | 'compare'} scope @param {string | undefined} url @param {string | undefined} handle
   */
  function useDiffData(session, scope, url, handle) {
    const epoch = useSyncExternalStore(subscribe, getEpoch)
    const [state, setState] = useState(/** @type {{ value?: any, error?: string, loading: boolean, epoch?: number }} */ ({ loading: true }))
    const [nonce, setNonce] = useState(0)
    useEffect(() => {
      let live = true
      setState(previous => ({ ...previous, loading: true }))
      ;(scope === 'pull' ? call('pull-diff', { session, url }) : scope === 'compare' ? call('comparison', { session, handle }) : call('diff', { session, scope }))
        .then(value => { if (live) setState({ value, loading: false, epoch }) }, error => { if (live) setState({ error: String(error?.message ?? error), loading: false, epoch }) })
      return () => { live = false }
    }, [session, scope, url, handle, epoch, nonce])
    const value = ((scope === 'pull' || scope === 'compare') && state.epoch === epoch) || state.value?.scope === scope ? state.value : undefined
    return { state, value, nonce, epoch, reload: () => setNonce(nonce + 1) }
  }

  /** A pull request's review draft, kept in this viewer's browser as it changes. @param {string | undefined} url */
  function useReviewDraft(url) {
    const [draft, setDraftState] = useState(() => url ? readDraft(url) : { head: '', comments: [] })
    /** @param {{ head: string, comments: any[] }} next */
    const setDraft = next => { setDraftState(next); if (url) writeDraft(url, next) }
    return /** @type {const} */ ([draft, setDraft])
  }

  /** The tab's header: scope switch or pull request title, review draft and Agent review, totals, notices, 刷新. */
  function DiffToolbar({ session, url, scope, setScope, value, loading, reload, draft, panel, setPanel, quoted }) {
    const [asked, setAsked] = useState('')
    const totals = diffTotals(value)
    const scopeButton = (id, label) => h('button', { type: 'button', 'aria-pressed': scope === id, onClick: () => setScope(id),
      style: { ...tab, background: scope === id ? colors.hover : 'transparent', color: scope === id ? colors.primary : colors.secondary, fontWeight: scope === id ? 600 : 400 } }, label)
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '.5px solid ' + colors.border, flexWrap: 'wrap' } },
      (scope === 'branch' || scope === 'uncommitted') && scopeButton('uncommitted', t('diff.uncommitted')),
      (scope === 'branch' || scope === 'uncommitted') && scopeButton('branch', t('diff.branch')),
      h('span', { style: { flex: 1, minWidth: 8, fontSize: 12, color: scope === 'pull' ? colors.primary : colors.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: url },
        scope === 'pull' ? (value?.title ? `#${value.number ?? ''} ${value.title}` + (value.author ? ' · @' + value.author : '') : t('diff.reviewPullRequest'))
          : scope === 'compare' ? t('diff.roundComparison') : value?.base && scope === 'branch' ? t('diff.vs', { base: value.base }) : ''),
      scope === 'pull' && value?.head && value.allowReview !== false && h('button', { type: 'button', 'data-fig-review-draft-toggle': draft.comments.length, 'aria-expanded': panel, onClick: () => setPanel(!panel),
        style: { ...tab, background: panel ? colors.hover : 'transparent', color: colors.primary } }, t('diff.reviewDraft', { count: draft.comments.length })),
      scope === 'pull' && value?.head && value.allowAgentReview !== false && h('button', { type: 'button', 'data-fig-review-agent': '', disabled: asked === 'sending',
        title: t('diff.theAgentReportsInThe'),
        onClick: () => { setAsked('sending'); call('agent-review', { session, url, language: isZh() ? 'zh' : 'en' }).then(reply => setAsked(reply?.sent ? 'sent' : reply?.refused === 'running' ? 'running' : 'failed'), () => setAsked('failed')) },
        style: { ...tab, background: 'transparent', color: colors.secondary } }, t('diff.askTheAgentToReview')),
      asked && asked !== 'sending' && h('span', { role: 'status', 'data-fig-review-agent-status': asked, style: { fontSize: 12, color: asked === 'sent' ? colors.added : colors.deleted } },
        asked === 'sent' ? t('diff.sentSeeTheConversation') : asked === 'running' ? t('diff.theSessionIsRunning') : t('diff.couldNotSend')),
      value && value.files?.length > 0 && h('span', { style: { fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } },
        h('span', { style: { color: colors.secondary } }, t(totals.files === 1 ? 'diff.files.one' : 'diff.files.other', { files: totals.files })),
        h('span', { style: { color: colors.added } }, '+' + totals.added), ' ', h('span', { style: { color: colors.deleted } }, '−' + totals.deleted)),
      quoted && h('span', { role: 'status', 'data-fig-diff-quoted': quoted, style: { fontSize: 12, whiteSpace: 'nowrap', color: quoted === 'failed' || quoted === 'stale' ? colors.deleted : colors.added } },
        quoted === 'ok' ? t('diff.addedToTheInput') : quoted === 'draft' ? t('diff.addedToTheReviewDraft') : quoted === 'stale' ? t('diff.theDraftIsFromAn') : t('diff.couldNotAddToThe')),
      h('button', { type: 'button', disabled: loading, onClick: reload,
        style: { ...tab, background: 'transparent', color: colors.secondary } }, loading ? t('diff.reading') : t('diff.refresh')))
  }

  function DiffBody({ session, initialScope, url, handle }) {
    const [scope, setScope] = useState(initialScope)
    const [draft, setDraft] = useReviewDraft(url)
    const [panel, setPanel] = useState(false)
    const { state, value, nonce, epoch, reload } = useDiffData(session, scope, url, handle)
    const [selection, setSelection] = useState(/** @type {{ path: string, hunk: number, from: number, to: number } | undefined} */ (undefined))
    const [quoted, setQuoted] = useState('')
    useEffect(() => { setSelection(undefined); setPanel(false) }, [scope, epoch])
    useEffect(() => { setSelection(undefined) }, [nonce])
    const notice = message => h('div', { style: { padding: 16, fontSize: 13, color: colors.secondary } }, message)
    let content
    if (state.error && !value) content = notice(t('diff.couldNotReadChanges') + state.error)
    else if (!value) content = notice(t('diff.readingLong'))
    else if (scope === 'pull' && (value.refused || value.problem)) content = notice(t('diff.couldNotReadThePull'))
    else if (scope === 'compare' && (value.problem || value.refused)) content = notice(t('diff.comparisonUnavailable'))
    else if (scope !== 'pull' && scope !== 'compare' && !value.repository) content = notice(t('diff.thisFolderIsNotA'))
    else if (value.noBase) content = notice(t('diff.noRemoteBranchToCompare'))
    else if (value.tooLarge) content = notice(t('diff.tooManyChangesToShow'))
    else if (value.files.length === 0) content = notice(t('diff.noChanges'))
    else {
      const select = (path, hunk, row, extend) => {
        setQuoted('')
        setSelection(current => extend && current && current.path === path && current.hunk === hunk
          ? { ...current, to: Math.max(current.from - MAX_QUOTED_LINES + 1, Math.min(current.from + MAX_QUOTED_LINES - 1, row)) } : { path, hunk, from: row, to: row })
      }
      const comment = async note => {
        if (!selection) return
        const file = value.files.find(each => each.path === selection.path)
        const lines = file?.hunks[selection.hunk]?.lines.slice(Math.min(selection.from, selection.to), Math.max(selection.from, selection.to) + 1) ?? []
        if (scope === 'pull') {
          if (value.allowReview === false) return
          // A review comment: anchored on GitHub's side and lines, kept in the draft for this head.
          const anchor = commentAnchor(lines)
          if (!anchor || !note.trim()) return
          // A draft written against an older head is never dropped silently: the user rewrites or clears it first.
          if (draft.comments.length > 0 && draft.head !== value.head) { setPanel(true); setQuoted('stale'); return }
          setDraft({ head: value.head, comments: [...draft.comments, { id: Math.random().toString(36).slice(2), path: selection.path, ...anchor, body: note.trim() }] })
          setSelection(undefined); setPanel(true); setQuoted('draft')
          return
        }
        if (scope === 'compare') {
          const current = await call('comparison', { session, handle }).catch(() => undefined)
          if (getEpoch() !== epoch || !current || current.problem || current.head !== value.head || current.base !== value.base) { reload(); return }
        }
        const ok = lines.length > 0 && quote(session, formatLineComment({ path: selection.path, scope: scope === 'compare' ? 'branch' : scope, base: value.base, lines, comment: note, chinese: isZh() }))
        setQuoted(ok ? 'ok' : 'failed')
        if (ok) setSelection(undefined)
      }
      content = value.files.map(file => h(FileDiff, { key: file.path, file, selection, select, comment, clear: () => setSelection(undefined), review: scope === 'pull' }))
    }
    return h('div', { 'data-fig-development-diff': scope, style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: colors.primary } },
      h(DiffToolbar, { session, url, scope, setScope, value, loading: state.loading, reload, draft, panel, setPanel, quoted }),
      scope === 'pull' && panel && value?.head && value.allowReview !== false && h(ReviewPanel, { session, url, value, draft, setDraft }),
      h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } }, content))
  }

  function DiffTab({ useTabInfo }) {
    const { tab: info } = useTabInfo()
    const parsed = parseDiffAddress(info.contentId ?? info.address ?? '')
    if (!parsed) return null
    return h(DiffBody, { key: parsed.session + ':' + parsed.scope + ':' + (parsed.url ?? parsed.handle ?? ''), session: parsed.session, initialScope: parsed.scope, url: parsed.url, handle: parsed.handle })
  }

  /** Registers the tab type and its resource. @param {any} ctx */
  const registerDiff = ctx => registerResourceTab(ctx, { protocol: diffProtocol, typeId: diffTypeId, parse: parseDiffAddress,
    title: () => t('diff.codeChanges'), component: DiffTab })

  return { registerDiff }
}
