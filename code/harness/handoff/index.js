import { realpath } from 'node:fs/promises'
import { fromDsh, textBlock } from '../shared/dsh-plugin.js'
import { containingWorkspace } from '../shared/workspaces.ts'

// A `handoff_session` tool for every DSH session and model: start ANOTHER DSH session from a handoff
// summary and let it run on its own. DSH owns session creation on the host/web side and exposes no
// model-facing tool to open a sibling session and start it, so Fig adds one. It uses Web's official
// Session Controller for an ordinary, managed sibling (live sidebar, cancellation, resume), returns
// immediately and starts it with only the supplied prompt plus the applicable workspace instructions,
// never the caller's conversation. A host without the Session Controller (headless) cannot hand off.

export const name = 'fig-session'
export const inject = ['tools', 'workingDirectory']

const toolName = 'handoff_session'

/**
 * The handed-off session runs with the caller's permission preset and model, never more. The preset is applied
 * to the sibling natively and approvals go through DSH's normal approval UI.
 */
export function parentSettings(ctx, agent) {
  const preset = agent ? ctx.get('permissionPresets')?.current(agent.session) : undefined
  // `custom` has no name the sibling could select. The sibling lives in the same host, so a live Auto selection
  // is applied to it natively.
  if (!preset || preset === 'custom') {
    throw new Error('Choose Read only, Workspace write or Full access as the permission mode before handing off.')
  }
  const route = agent.model?.current() ?? agent.options
  const model = typeof route?.provider === 'string' && typeof route?.model === 'string'
    ? { provider: route.provider, model: route.model, ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}) }
    : undefined
  return { preset, model }
}

/**
 * The Workspace the sibling belongs to: the caller's own, else the registered Workspace that contains the
 * working directory (a subagent caller is not a Workspace member), else a new one at the directory.
 */
async function siblingWorkspace(registry, parent, directory) {
  const workspaces = registry.list()
  const own = workspaces.find(workspace => workspace.sessionIds.includes(parent.session.id))
  if (own) return own
  return containingWorkspace(workspaces, directory) ?? await registry.create(directory)
}

/**
 * Web owns ordinary sibling sessions: native lifecycle, live sidebar, cancellation and resume. The sibling is
 * a normal session of the caller's Workspace that starts in the caller's directory with the caller's model,
 * agent preset and permission preset. Approvals keep the native policy of that preset: the Workspace
 * sidebar marks a background session that waits for approval, so nothing is forced to `never`.
 */
export async function managedHandoff(ctx, parent, { prompt, title }, cwd, settings, signal, createMessage = undefined) {
  signal?.throwIfAborted()
  const text = String(prompt ?? '').trim()
  if (!text) throw new Error('Give the handoff prompt for the new session.')
  const directory = await realpath(cwd)
  const workspace = await siblingWorkspace(ctx.get('workspaceRegistry'), parent, directory)
  const agentPreset = ctx.get('agentPresets')?.composedPreset(parent.ctx)
  signal?.throwIfAborted()
  const { sessionId } = await ctx.get('sessionController').create({ workspaceId: workspace.id, ...(agentPreset ? { agentPreset } : {}) })
  try {
    const child = ctx.get('agents').get(sessionId)
    if (!child) throw new Error('The new session could not be resolved.')
    if (settings.model) child.model.select(settings.model)
    ctx.get('permissionPresets').set(child.session, settings.preset)
    if (directory !== workspace.path) await ctx.get('workingDirectory').set(child, directory, signal)
    if (title?.trim()) ctx.get('sessionTitle').rename(child.session, title)
    const createUserMessage = createMessage ?? (await fromDsh('@deepseek-ai/dsh-llm')).createUserMessage
    signal?.throwIfAborted()
    child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  } catch (error) {
    // A session created but never started would stay in the sidebar as an empty orphan; archive it, as side chat does.
    // The handoff's own failure is what the caller sees, even when archiving fails too.
    try { await ctx.get('workspaceRegistry').archiveSession(sessionId, { stopActivity: true }) } catch { /* reported below */ }
    throw error
  }
  return { sessionId, workspaceId: workspace.id, title: title ?? null, status: 'started', lifecycle: 'fig',
    text: `已启动新会话 ${sessionId}（标题：${title ?? '未命名'}）。可立即在 Fig 工作区侧栏打开，查看进度、停止或继续；退出 Fig 会停止运行，记录可恢复。` }
}

/** @param {any} ctx */
export async function apply(ctx) {
  const { defineTool } = await fromDsh('@deepseek-ai/dsh-tools')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Start ANOTHER DSH session from a handoff summary and let it run on its own in the background. Use it to '
      + 'split off a self-contained piece of work the user can open and review separately. The new session starts cold: put '
      + 'everything it needs into `prompt` (goal, context, files, what done looks like) — it does not see this conversation. '
      + 'Returns the new session id immediately; it does NOT wait for the work to finish. In Fig, it appears immediately in the '
      + 'workspace sidebar and supports normal progress, stop and resume; quitting Fig stops its work.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The full handoff: the task and all context the new session needs, since it starts with no memory of this one.' },
      title: { type: 'string', description: 'Short title for the handed-off task.' }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(value.text)],
      // What the conversation row needs to show the new session and open it.
      presentationMeta: (_args, value) => ({ kind: 'fig-handoff', sessionId: value.sessionId, title: value.title })
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Only DSH Web composes the Session Controller; Fig always runs Web.
      if (!ctx.get('sessionController') || !ctx.get('workspaceRegistry')) throw new Error('Handoff needs DSH Web: this host cannot start sibling sessions.')
      const settings = parentSettings(ctx, exec.agent)
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return managedHandoff(ctx, exec.agent, args, cwd, settings, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'Handoff session: ' + String(args.title ?? ''), kind: 'execute' })
  })))
}
