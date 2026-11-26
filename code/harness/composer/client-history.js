import { pageRpc } from '../shared/page-rpc.js'

const call = pageRpc('/fig-composer')

/** @param {typeof import('react')} react */
export function inputHistory({ createElement, useEffect, useRef }) {
  // Input history: an empty composer recalls earlier sent text of the same workspace with ↑/↓.
  // Adapted from @michengai/dsh-codex-ui (Apache-2.0) composer/input-history.
  function historyCache() {
    const scopes = new Map()
    return {
      entries(scope) {
        if (!scopes.has(scope)) {
          const entries = []
          scopes.set(scope, entries)
          call('history/list', { scope }).then(
            list => { entries.unshift(...list.filter(text => !entries.includes(text))) },
            () => { console.warn('[fig-composer] input history unavailable, this window keeps its own') }
          )
        }
        return scopes.get(scope)
      },
      add(scope, text) {
        if (!text.trim()) return
        const entries = this.entries(scope)
        if (entries.at(-1) === text) return
        entries.push(text)
        if (entries.length > 200) entries.shift()
        call('history/add', { scope, text }).catch(() => {})
      }
    }
  }

  // Recall starts only from an empty draft; any edit of a recalled text leaves history.
  function historyCursor() {
    let index, original = '', displayed = '', list = []
    const reset = () => { index = undefined; list = [] }
    return {
      reset,
      move(direction, draft, entries) {
        if (index !== undefined && draft !== displayed) reset()
        if (index === undefined) {
          if (direction !== -1 || draft !== '' || entries.length === 0) return undefined
          original = draft
          list = [...entries]
          index = list.length
        }
        index = Math.max(0, Math.min(list.length, index + direction))
        if (index === list.length) { reset(); return original }
        displayed = list[index]
        return displayed
      }
    }
  }

  // A caret in the middle of recalled text, or a selection, keeps the editor's own line movement.
  function atBoundary(editor) {
    const selection = editor.ownerDocument.getSelection()
    if (!selection?.isCollapsed || !selection.rangeCount || !editor.contains(selection.anchorNode)) return false
    const caret = selection.getRangeAt(0)
    const before = editor.ownerDocument.createRange()
    before.selectNodeContents(editor)
    before.setEnd(caret.startContainer, caret.startOffset)
    const after = editor.ownerDocument.createRange()
    after.selectNodeContents(editor)
    after.setStart(caret.endContainer, caret.endOffset)
    return before.toString() === '' || after.toString() === ''
  }

  function bindKeys(editor, adapter) {
    const cursor = historyCursor()
    let composing = false, writing = false
    const begin = () => { composing = true }
    const end = () => { composing = false }
    const changed = () => { if (!writing) cursor.reset() }
    const keydown = event => {
      if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || adapter.blocked()) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const draft = adapter.draft()
      if (draft !== '' && !atBoundary(editor)) return
      const next = cursor.move(event.key === 'ArrowUp' ? -1 : 1, draft, adapter.entries())
      if (next === undefined) return
      event.preventDefault()
      event.stopImmediatePropagation()
      writing = true
      try { adapter.setDraft(next) } finally { writing = false }
    }
    editor.addEventListener('compositionstart', begin)
    editor.addEventListener('compositionend', end)
    editor.addEventListener('input', changed)
    editor.addEventListener('keydown', keydown, true)
    return () => {
      editor.removeEventListener('compositionstart', begin)
      editor.removeEventListener('compositionend', end)
      editor.removeEventListener('input', changed)
      editor.removeEventListener('keydown', keydown, true)
    }
  }

  // Tab in an empty composer takes the greyed next-step hint (next-step.js on the Host).
  function bindTab(editor, adapter) {
    const keydown = event => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || adapter.blocked()) return
      const text = adapter.hint()
      if (!text || adapter.draft() !== '') return
      event.preventDefault()
      event.stopImmediatePropagation()
      adapter.accept(text)
    }
    editor.addEventListener('keydown', keydown, true)
    return () => editor.removeEventListener('keydown', keydown, true)
  }

  // DSH has no key hook for the composer; the dock slot sits beside the editor,
  // so walk up from it to the one Lexical editor of this composer.
  function findEditor(anchor) {
    for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const editors = parent.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]')
      if (editors.length === 1) return editors[0]
      if (editors.length > 1) return undefined
    }
    return undefined
  }

  const hasAttachments = state => (state.attachmentIds?.length ?? 0) > 0

  function HistoryDock({ ctx, sessionId, history, seen }) {
    const anchor = useRef(/** @type {HTMLSpanElement | null} */ (null))
    useEffect(() => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return
      const scope = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd ?? sessionId
      const input = ctx.conversation.input.for(binding.ctx)
      const menu = ctx.inputTriggers.sessionOf(binding.ctx).menu
      history.entries(scope)
      // Declared before any subscription, since a store may call back on subscribe and paint() reads them.
      let editor, hint, asked = false, painted
      let offKeys = () => {}

      // Every send, whether it starts a turn, queues or steers, first appears in the Session's
      // pendingSubmissions echo. Echoes present at mount are already recorded.
      if (!seen.has(binding)) seen.set(binding, new Set(binding.session.getSnapshot().pendingSubmissions?.map(item => item.requestId)))
      const recorded = seen.get(binding)
      const offSession = binding.session.subscribe(() => {
        for (const item of binding.session.getSnapshot().pendingSubmissions ?? []) {
          if (recorded.has(item.requestId)) continue
          recorded.add(item.requestId)
          if (typeof item.text === 'string') history.add(scope, item.text)
        }
      })
      // Commands leave no user message; take the draft once DSH accepted and cleared it.
      let previous = input.state.getSnapshot()
      const offInput = input.state.subscribe(() => {
        const next = input.state.getSnapshot()
        if (previous.phase === 'submitting' && next.phase === 'plain' && next.draft === ''
          && !hasAttachments(previous) && previous.occurrences.length === 0) history.add(scope, previous.draft)
        previous = next
        paint()
      })

      // Next-step hint: asked for once each time the Session stops running, and shown in place of
      // the composer placeholder (hintStyle below) while the draft is empty.
      const running = () => ctx.sessions.list.getSnapshot().byId[sessionId]?.running === true
      let disposed = false
      function paint() {
        const placeholder = editor?.parentElement?.querySelector('[data-composer-placeholder]') ?? undefined
        if (painted && painted !== placeholder) painted.removeAttribute('data-fig-next-step')
        painted = placeholder
        if (hint && input.state.getSnapshot().draft === '') placeholder?.setAttribute('data-fig-next-step', hint)
        else placeholder?.removeAttribute('data-fig-next-step')
      }
      const refresh = () => {
        if (running()) { hint = undefined; asked = false; paint(); return }
        if (asked) return
        asked = true
        call('next-step/get', { sessionId }).then(value => {
          if (disposed || !asked || running()) return
          hint = value?.text || undefined
          paint()
        }, () => {})
      }
      const offList = ctx.sessions.list.subscribe(refresh)

      const blocked = () => {
        const state = input.state.getSnapshot()
        return state.phase === 'adjudicating' || state.phase === 'submitting'
          || hasAttachments(state) || state.occurrences.length > 0 || menu.getSnapshot().open
      }
      const connect = () => {
        const next = anchor.current ? findEditor(anchor.current) : undefined
        if (next === editor) return paint()
        offKeys()
        offKeys = () => {}
        editor = next
        paint()
        if (editor === undefined) return
        const draft = () => input.state.getSnapshot().draft
        const accept = text => { hint = undefined; input.setDraft(text); paint() }
        const offHistory = bindKeys(editor, { draft, blocked, entries: () => history.entries(scope), setDraft: text => input.setDraft(text) })
        const offTab = bindTab(editor, { draft, blocked, hint: () => hint, accept })
        offKeys = () => { offHistory(); offTab() }
      }
      connect()
      refresh()
      const observer = new MutationObserver(connect)
      const parent = anchor.current?.parentElement?.parentElement
      if (parent) observer.observe(parent, { childList: true, subtree: true })
      return () => { disposed = true; observer.disconnect(); offKeys(); offInput(); offSession(); offList(); hint = undefined; paint() }
    }, [ctx, sessionId, history, seen])
    return createElement('span', { ref: anchor, hidden: true, 'data-fig-input-history': '' })
  }

  return { historyCache, HistoryDock }
}

/*
 * Next-step hint. HistoryDock puts the suggested reply in data-fig-next-step on the composer placeholder
 * ([data-composer-placeholder], absolutely placed over the empty editor); it replaces the placeholder text, and
 * DSH still hides the placeholder once the draft has text. tests/next-step-smoke.mjs covers it.
 */
const hintStyle = `[data-composer-placeholder][data-fig-next-step] { color: transparent; }
[data-composer-placeholder][data-fig-next-step]::before {
  content: attr(data-fig-next-step);
  position: absolute; inset: 0;
  color: var(--dsw-alias-label-caption);
  white-space: pre; overflow: hidden; text-overflow: ellipsis;
}`

/** Puts the next-step hint style in the page; returns its removal, for the plugin's dispose. */
export function installHintStyle(doc = document) {
  const style = doc.createElement('style')
  style.id = 'fig-composer-style'
  style.textContent = hintStyle
  doc.head.append(style)
  return () => style.remove()
}
