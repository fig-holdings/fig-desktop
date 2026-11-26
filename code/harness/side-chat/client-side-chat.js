import { isZh } from '../shared/page-locale.js'
import { openSessionId, postPageJson } from '../shared/page-client.js'
import { t } from './client-locale.js'
import { pageRpc } from '../shared/page-rpc.js'
const call = pageRpc('/fig-side-chat')
const sendFailure = code => {
  switch (code) {
    case 'MAIN_RUNNING': return t('side-chat.theMainSessionIsRunning')
    case 'MAIN_QUEUE_NOT_EMPTY': return t('side-chat.theMainSessionHasQueued')
    case 'MAIN_PENDING_INPUT': return t('side-chat.theMainSessionIsWaiting')
    case 'MAIN_STATE_UNAVAILABLE': return t('side-chat.couldNotConfirmTheMain')
    case 'SIDECHAT_SENDING': return t('side-chat.aMessageIsAlreadyBeing')
    case 'TOO_LONG': return t('side-chat.shortenTheTextBeforeSending')
    default: return t('side-chat.sendingFailedYourDraftIs')
  }
}

// A separate side chat shown in a right-sidebar tab, so the user can ask about the main Session without
// interrupting it. A resource retains the side chat's Session reference, and the body renders DSH's shared
// `sidebar.chat.conversation` Conversation inside that Session.

const protocol = 'figsidechat'
const typeId = 'fig-side-chat'
const prefix = `dsh-resource://${protocol}/`
const conversationSlot = 'fig.sidechat.conversation'
const shortcutId = 'fig.sideChat.new'

/** The tab address for a side chat linked to its main Session. */
export const sideChatAddress = (main, child) => `${prefix}session/${encodeURIComponent(child)}?main=${encodeURIComponent(main)}`

/** The side chat's {main, child}, or undefined for any other address. */
export function parseSideChatAddress(address) {
  let url
  try { url = new URL(address) } catch { return undefined }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== protocol) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  const main = url.searchParams.get('main')
  if (parts.length !== 2 || parts[0] !== 'session' || !main) return undefined
  try { return { main, child: decodeURIComponent(parts[1]) } } catch { return undefined }
}

/** A set of side chat ids that components can subscribe to. */
export function knownChats() {
  const ids = new Set()
  const listeners = new Set()
  const changed = () => { for (const listener of listeners) listener() }
  return {
    has: id => ids.has(id),
    /** @param {...string} added */
    add(...added) {
      const before = ids.size
      for (const id of added) ids.add(id)
      if (ids.size !== before) changed()
    },
    delete(id) { if (ids.delete(id)) changed() },
    /** @param {() => void} listener */
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}

/** @param {AbortSignal} signal */
const settled = signal => signal.aborted ? Promise.resolve() : new Promise(/** @param {(value?: unknown) => void} resolve */ resolve => signal.addEventListener('abort', () => resolve(), { once: true }))

/**
 * @param {typeof import('react')} react
 * @param {((node: any, container: Element) => any) | undefined} portal - react-dom createPortal
 */
export function sideChat(react, portal) {
  const { createElement: h, useRef, useState, useSyncExternalStore } = react
  // Side chat Sessions known to this page: registered here, or listed by the Host after a reload. A small store, so
  // the send buttons already rendered appear once the Host's list arrives.
  const known = knownChats()
  /** main Session -> its side chat whose tab is open */
  const openByMain = new Map()
  // main Session → the side chat being prepared for it
  const opening = new Map()
  /** The side chat plugin's page context, for components rendered by DSH's slots. */
  let pageCtx
  const small = { border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,.3))', background: 'transparent',
    color: 'inherit', fontSize: 12, cursor: 'pointer', padding: '3px 10px', borderRadius: 6, whiteSpace: 'nowrap' }
  const remember = () => call('list', {}).then(value => known.add(...(value?.chats ?? [])), () => {})

  // Under each finished reply in a side chat. The user opens a box holding the reply's part for the main Session (the
  // lines after 给主会话：, or the whole reply), may edit it, and sends it (Host: /fig-side-chat/draft and /send).
  function SendToMain({ messageId, sideChatSession }) {
    const [state, setState] = useState(/** @type {'idle' | 'loading' | 'editing' | 'sending' | 'sent' | 'failed'} */ ('idle'))
    const [draft, setDraft] = useState('')
    const [sendError, setSendError] = useState('')
    const sending = useRef(false)
    // One id per opened send box: a retry after a lost response is recognized as the same message.
    const requestId = useRef('')
    const isKnown = useSyncExternalStore(known.subscribe, () => Boolean(sideChatSession) && known.has(sideChatSession))
    if (!sideChatSession || !isKnown || !messageId) return null
    const payload = { child: sideChatSession, messageId }
    const openBox = () => {
      requestId.current = crypto.randomUUID()
      setSendError('')
      setState('loading')
      call('draft', payload).then(value => { setDraft(value?.text ?? ''); setState('editing') }, () => setState('failed'))
    }
    const send = async () => {
      if (sending.current || !draft.trim()) return
      sending.current = true
      setSendError('')
      setState('sending')
      try {
        const { result } = await postPageJson('/fig-side-chat', 'send', { ...payload, text: draft, requestId: requestId.current })
        if (result?.ok) { setState('sent'); return }
        setSendError(sendFailure(result?.error?.code))
      } catch {
        setSendError(sendFailure())
      } finally {
        sending.current = false
        setState(value => value === 'sent' ? value : 'editing')
      }
    }
    const editing = state === 'editing' || state === 'sending'
    const close = () => setState('idle')
    const dialog = editing && h('div', { 'data-fig-send-box': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('side-chat.sendToMainSession'),
      onMouseDown: event => { if (event.target === event.currentTarget && state !== 'sending') close() },
      onKeyDown: event => { if (event.key === 'Escape' && state !== 'sending') { event.stopPropagation(); close() } },
      style: { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.28)' } },
      h('div', { style: { width: 'min(560px, calc(100vw - 48px))', display: 'flex', flexDirection: 'column', gap: 10, padding: 18, borderRadius: 14,
        background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary)', boxShadow: '0 12px 40px rgba(0,0,0,.25)' } },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('side-chat.sendToMainSession')),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('side-chat.youCanEditTheText')),
        h('textarea', { value: draft, autoFocus: true, rows: Math.min(14, Math.max(4, draft.split('\n').length + 1)), disabled: state === 'sending', 'aria-label': t('side-chat.textForTheMainSession'),
          onChange: event => setDraft(/** @type {HTMLTextAreaElement} */ (event.target).value),
          onKeyDown: event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && draft.trim()) { event.preventDefault(); send() } },
          style: { width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: 13, lineHeight: 1.5, padding: 10, borderRadius: 8, resize: 'vertical',
            border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,.3))', background: 'transparent', color: 'inherit' } }),
        sendError && h('div', { role: 'alert', style: { fontSize: 13 } }, sendError),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: small, disabled: state === 'sending', onClick: close }, t('side-chat.cancel')),
          h('button', { type: 'button', 'data-fig-send-confirm': '', style: { ...small, fontWeight: 600 }, disabled: state === 'sending' || !draft.trim(), onClick: send },
            state === 'sending' ? t('side-chat.sending') : t('side-chat.send')))))
    const label = state === 'sent' ? t('side-chat.sentToMainSession') : state === 'failed' ? t('side-chat.couldNotLoadRetry')
      : state === 'loading' ? t('side-chat.loading') : t('side-chat.sendToMainSession')
    const button = h('button', {
      key: 'button', type: 'button', 'data-fig-send-main': '', disabled: state === 'loading' || state === 'sent' || editing, title: label, 'aria-label': label,
      style: { ...small, border: 'none', color: 'var(--dsw-alias-label-secondary)', padding: '2px 6px' },
      onClick: openBox
    }, label)
    return dialog && portal ? [button, portal(h('div', { key: 'dialog' }, dialog), document.body)] : button
  }

  // A line above the side chat: which Session it watches and whether that Session is running.
  function MainStatus({ ctx, main }) {
    const summary = useSyncExternalStore(listener => ctx.sessions.list.subscribe(listener), () => ctx.sessions.list.getSnapshot().byId[main])
    const state = summary?.running ? t('side-chat.running') : t('side-chat.idle')
    return h('div', { 'data-fig-side-chat-status': '', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
      borderBottom: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,.2))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
      h('span', { 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 3, flex: 'none', background: summary?.running ? '#2ea043' : 'var(--dsw-alias-label-secondary)' } }),
      t('side-chat.mainSession') + (summary?.title || t('side-chat.untitled')) + ' · ' + state)
  }
  // DSH's subagent chat declares `sidebar.chat.conversation` and a slot is declared once, so the side chat has its
  // own child slot rendering the same shared Conversation the same way (dsh-client-ui-subagent ConversationSlotPanel).
  const ChatOnly = props => props.renderSlot('conversation.session', { view: 'chat' })
  function SideChatConversation({ renderFactorySlot }) {
    return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false },
      { slots: { views: ChatOnly } })
  }
  // The 开始 card's glyph: a speech bubble with a plus, as Codex draws its side chat; DSH ships no chat artwork.
  const SideChatArtwork = ({ size = 24 }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M12 3.5c4.7 0 8.5 3.4 8.5 7.6s-3.8 7.6-8.5 7.6c-1 0-2-.15-2.9-.45L5 19.8l1.2-3.4C4.6 15 3.5 13.1 3.5 11.1 3.5 6.9 7.3 3.5 12 3.5Z',
      stroke: '#8b6cf6', strokeWidth: 1.8, strokeLinejoin: 'round' }),
    h('path', { d: 'M12 8v6.2M8.9 11.1h6.2', stroke: '#8b6cf6', strokeWidth: 1.8, strokeLinecap: 'round' }))

  // The 开始 page's 侧边聊天 card opens this type as a page (DSH's default card: openTab(kind, {replaceTab})). The page
  // opens a side chat for the current Session and replaces itself with that tab.
  function SideChatLauncher({ tabId }) {
    const [failure, setFailure] = useState(/** @type {'no-session' | 'open-failed' | undefined} */ (undefined))
    react.useEffect(() => {
      const main = openSessionId()
      if (!main || !pageCtx) { setFailure('no-session'); return }
      open(pageCtx, main, { replaceTab: tabId }).catch(error => { console.error('[fig-side-chat]', error); setFailure('open-failed') })
    }, [])
    return h('div', { style: { padding: 24, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
      failure === 'no-session' ? t('side-chat.openASessionFirstThen')
        : failure ? t('side-chat.couldNotOpenTheSide')
          : t('side-chat.openingTheSideChat'))
  }
  function SideChatTab(props) {
    const { tab } = props.useTabInfo()
    return parseSideChatAddress(tab.contentId ?? tab.address ?? '') ? h(SideChatSession, props) : h(SideChatLauncher, { tabId: tab.id })
  }
  function SideChatSession({ useResource, useTabInfo, SessionProvider, renderSlot }) {
    const { tab } = useTabInfo()
    const resource = useResource(tab.contentId)
    return h('div', { 'data-fig-side-chat': '', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
      resource.value === undefined ? null : [
        pageCtx && h(MainStatus, { key: 'status', ctx: pageCtx, main: resource.value.main }),
        h('div', { key: 'chat', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          h(SessionProvider, { session: resource.value.reference }, renderSlot(conversationSlot, {})))])
  }

  /** Opens the side chat for the current main Session. */
  /** @param {any} ctx @param {string} main @param {{replaceTab?: string} | undefined} [options] */
  async function open(ctx, main, options) {
    const existing = openByMain.get(main)
    if (existing) { await ctx.sidebarRight.openResource(sideChatAddress(main, existing), options); return existing }
    // Reuse the creation already in progress on repeated opens.
    const pending = opening.get(main)
    if (pending) return pending
    const started = createSideChat(ctx, main, options).finally(() => opening.delete(main))
    opening.set(main, started)
    return started
  }

  /** @param {any} ctx @param {string} main @param {{replaceTab?: string} | undefined} options */
  async function createSideChat(ctx, main, options) {
    const { child } = await call('create', { main, language: isZh() ? 'zh' : 'en' })
    try {
      known.add(child)
      await ctx.sidebarRight.openResource(sideChatAddress(main, child), options)
    } catch (error) {
      known.delete(child)
      await ctx.uiWorkspace?.archiveSession(child, { stopActivity: true }).catch(() => {})
      throw error
    }
    openByMain.set(main, child)
    return child
  }

  /** Registers the tab type once DSH's resources and tab registry are up, as dsh-client-ui-subagent does. */
  function register(ctx) {
    if (typeof ctx.inject !== 'function') return
    pageCtx = ctx
    // ⌥⌘S, as in Codex: a DSH shortcut command, so it shows on the 开始 card and can be rebound in 编辑快捷键.
    ctx.inject(['shortcuts'], scope => {
      const keys = { code: 'KeyS', modifiers: ['primary', 'alt'] }
      scope.effect(() => scope.shortcuts.register({
        id: shortcutId, label: () => t('side-chat.sideChat'), aliases: ['side chat', 'btw'],
        defaults: { 'desktop:macos': keys, 'desktop:windows': keys, 'desktop:linux': keys, 'web:macos': keys, 'web:windows': keys },
        regions: ['page', 'editable', 'terminal'], modals: [],
        resolve: () => {
          const main = openSessionId()
          if (!main) return { status: 'blocked', reason: t('side-chat.openASessionFirst') }
          return { status: 'handled', run: () => { void open(ctx, main).catch(error => console.error('[fig-side-chat]', error)) } }
        }
      }))
    })
    ctx.inject(['resources', 'sidebarRightTabs'], scope => { scope.effect(() => registerTab(scope, ctx)) })
  }
  /** `ctx` holds the tab services; `root` the plugin's own context (sidebarRight, uiWorkspace). */
  function registerTab(ctx, root) {
    const disposers = [
      ctx.resources.register({
        protocol,
        async *open(address, { signal }) {
          const parsed = parseSideChatAddress(address)
          if (!parsed) throw new Error('fig-side-chat: invalid address')
          if (signal.aborted) return
          const reference = ctx.sessions.retain(parsed.child, { source: 'sidebarChat', signal })
          try {
            yield { ok: true, value: { ...parsed, reference } }
            await settled(signal)
          } finally { reference.release() }
        }
      }),
      ctx.sidebarRightTabs.register({
        id: typeId, kind: 'fig-side-chat', patterns: [`${prefix}**`], priority: 'extension',
        canOpen: address => parseSideChatAddress(address) !== undefined,
        title: () => t('side-chat.sideChat'),
        guide: [{ id: 'new', commandId: shortcutId, order: 25, title: () => t('side-chat.sideChat'),
          description: () => t('side-chat.askWithoutInterruptingTheMain'), icon: SideChatArtwork }]
      })
    ]
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: typeId,
      children: { [conversationSlot]: { kind: 'single', scope: 'session' } }
    }, SideChatTab)))
    ctx.effect(() => ctx.slots.inject(conversationSlot, () => ctx.slots.register({ name: conversationSlot }, SideChatConversation)))
    ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
      name: 'conversation.chat.assistant-actions', id: 'fig-send-to-main', order: 20,
      inject: sessionId => ({ sideChatSession: sessionId })
    }, SendToMain)))
    // Closing the tab archives the side chat (restorable from 已归档); the tab content id is its address.
    ctx.effect(() => root.sidebarRight.registerCloseHandler('fig-side-chat', (_sessionId, tab) => {
      const parsed = parseSideChatAddress(tab?.address ?? tab?.contentId ?? '')
      if (parsed && openByMain.get(parsed.main) === parsed.child) openByMain.delete(parsed.main)
      if (parsed) void root.uiWorkspace?.archiveSession(parsed.child, { stopActivity: true }).catch(error => console.error('[fig-side-chat] archive', error))
    }))
    void remember()
    return () => { for (const dispose of disposers.reverse()) dispose?.() }
  }

  return { open, register }
}
