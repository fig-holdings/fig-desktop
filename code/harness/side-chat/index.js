import { join } from 'node:path'
import { dshHome, fromDsh, textBlock } from '../shared/dsh-plugin.js'
import { pageRoute, registerPageRoute, RouteError } from '../shared/http.js'
import { sideChatConstraint, sideChatId, sideChatService } from './side-chat.js'

// Side chat's Host half: the side chats this DSH home knows, the main session's live status for the
// `main_session_status` tool, and drafting and sending a message to an idle main Session.

export const name = 'fig-side-chat'
export const inject = ['tools']
const prefix = '/fig-side-chat'

export async function apply(ctx) {
  const sideChat = sideChatService(join(dshHome(), 'fig', 'side-chats.json'), () => ctx.get('sessionController'), () => ctx.get('workspaceChanges'))
  const { createUserMessage } = await fromDsh('@deepseek-ai/dsh-llm')
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || !decision.messages.some(message => message.source?.kind === 'user')) return decision
    await sideChat.loaded
    const main = sideChat.mainOf(agent.session.id)
    if (!main) return decision
    // Only main-session messages newer than the previous reference: the earlier ones are already in this history.
    const history = agent.session.deriveMessages()
    const additions = []
    if (!history.some(message => message.source?.kind === 'fig-side-chat-policy')) {
      additions.push(createUserMessage({
        source: { kind: 'fig-side-chat-policy', form: 'recall' },
        content: [{ type: 'text', text: sideChatConstraint }]
      }))
    }
    const previous = history.findLast(message => message.source?.kind === 'fig-side-chat-context')
    const after = Number.isSafeInteger(previous?.source?.through) ? previous.source.through : undefined
    let context
    try {
      context = await sideChat.context(main, after, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
    } catch {
      signal.throwIfAborted()
      // Keep the side chat usable if the main session cannot currently be read.
    }
    if (context?.text && previous?.content[0]?.text !== context.text) {
      additions.push(createUserMessage({
        source: { kind: 'fig-side-chat-context', form: 'recall', ...(context.through !== undefined ? { through: context.through } : {}) },
        content: [{ type: 'text', text: context.text }]
      }))
    }
    return additions.length ? { ...decision, messages: [...additions, ...decision.messages] } : decision
  })
  void registerSideChatTool(ctx, sideChat)
  registerPageRoute(ctx, prefix, 'fig-side-chat: route', (connection, req, res) => route(connection, req, res, { sideChat, ctx }))
}

/** Create an ordinary, empty DSH session with the main session's configuration. */
async function createSideChat(ctx, sideChat, payload) {
  const main = sideChatId(payload?.main)
  if (!main) throw new RouteError(400, 'BAD_SESSION')
  await sideChat.loaded
  if (sideChat.mainOf(main)) throw new RouteError(400, 'BAD_SESSION')
  const sessions = ctx.get('sessionController')
  const workspaces = ctx.get('workspaceRegistry')
  const permissions = ctx.get('permissionPresets')
  const directories = ctx.get('workingDirectory')
  const titles = ctx.get('sessionTitle')
  const presets = ctx.get('agentPresets')
  if (!sessions || !workspaces || !permissions || !directories || !titles) throw new RouteError(503, 'SIDECHAT_UNAVAILABLE')

  const { agent: parent, error: parentError } = await sessions.resolveAgent(main)
  if (!parent) throw parentError ?? new RouteError(404, 'UNKNOWN_SESSION')
  const workspace = workspaces.list().find(item => item.sessionIds.includes(main))
  const cwd = directories.get(parent.session)
  const model = parent.model.current()
  const agentPreset = presets?.composedPreset(parent.ctx)
  const title = titles.get(parent.session)?.title
  const chinese = payload?.language === 'zh'
  const { sessionId: child } = await sessions.create({
    ...(workspace ? { workspaceId: workspace.id } : { cwd }),
    ...(agentPreset ? { agentPreset } : {})
  })
  try {
    const { agent, error: childError } = await sessions.resolveAgent(child)
    if (!agent) throw childError ?? new RouteError(503, 'SIDECHAT_UNAVAILABLE')
    permissions.set(agent.session, 'read-only')
    if (model) agent.model.select(model)
    titles.rename(agent.session, chinese ? '侧边聊天：' + (title || '未命名会话') : 'Side chat: ' + (title || 'Untitled'))
    if (workspace && cwd !== workspace.path) await directories.set(agent, cwd, AbortSignal.timeout(5000))
    return await sideChat.register({ child, main })
  } catch (error) {
    await workspaces.archiveSession(child, { stopActivity: true })
    throw error
  }
}

/** POST /fig-side-chat/<endpoint> for the page plugin. */
export const route = pageRoute({
  prefix,
  bodyLimit: 64 * 1024,
  endpoints: {
    'list': (_payload, { sideChat }) => sideChat.list(),
    'create': (payload, { sideChat, ctx }) => createSideChat(ctx, sideChat, payload),
    'draft': (payload, { sideChat }) => sideChat.draft(payload, AbortSignal.timeout(20_000)),
    'send': (payload, { sideChat }) => sideChat.send(payload, AbortSignal.timeout(20_000))
  },
  failure: () => ({ code: 'SIDECHAT' })
})

/** `main_session_status`, offered only inside a side chat: the main Session's live state, plan and recent activity. */
async function registerSideChatTool(ctx, sideChat) {
  await sideChat.loaded
  const { defineTool } = await fromDsh('@deepseek-ai/dsh-tools')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'main_session_status',
    description: 'You are in a side chat next to the main session the user is working in. You are read-only. Read the main '
      + 'session\'s live progress: whether it runs or waits for the user, its goal, plan and todo list (with how many are done), the '
      + 'files its latest turns changed, the latest user message, its latest reply in full and earlier replies, and recent tool '
      + 'calls. Recent main-session text arrives separately as reference context with your user requests. Call this tool '
      + 'for current progress or when you need more detail. Read changed files yourself to judge the work. Raise `messages` to look further back and set '
      + '`tool_results` to see tool output. You cannot send to the main session. When the user wants the main session to do '
      + 'something, end your reply with a blank line, then a line starting 给主会话： (or To main session: in English), followed only by '
      + 'the instruction for it; the user reviews it and sends it with the button under your reply.',
    parameters: {
      messages: { type: 'integer', description: 'How many recent messages of the main session to read, 10 to 200 (default 40).' },
      tool_results: { type: 'boolean', description: 'Also include the output of the latest tool calls (default false).' }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [textBlock(value)] },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const main = sideChat.mainOf(exec.agent.session.id)
      if (!main) throw new Error('This is not a side chat.')
      return sideChat.status(main, exec.signal, { messages: args?.messages, toolResults: args?.tool_results === true })
    },
    presentCall: () => ({ card: 'generic', title: 'Main session status', kind: 'read' })
  }), { when: ({ agent }) => Boolean(sideChat.mainOf(agent?.session?.id)) }))
}
