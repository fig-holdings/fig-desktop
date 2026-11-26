// Test-only host probe for the managed handoff. Mounted explicitly in an isolated Web profile, never in the product.
// Parents are created the way the Web UI creates them: through the Session Controller inside a Workspace.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(process.argv[1])
import { pageRoute, registerPageRoute } from '../../harness/shared/http.js'

export const inject = ['agents', 'tools', 'permissionPresets', 'approval', 'workingDirectory']
export function apply(ctx) {
  const attentionRequests = new Map()
  const recorded = new Map()
  const gates = new Map()
  const rejectPrompts = new Set()
  let promptWrapped = false, rejectedPrompts = 0
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    const gate = gates.get(agent.session.id)
    if (!gate || decision.kind === 'reject') return decision
    gate.entries.push(decision.messages.filter(message => message.source?.kind === 'user').map(message => ({ id: message.id, source: message.source, content: message.content })))
    // A deterministic slow-model boundary. Only cancellation releases it, so this fixture never
    // issues a model call even when queued input automatically wakes another native turn.
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
    return decision
  })
  ctx.on('session/event', (session, event) => {
    if (!['tool/call', 'tool/result', 'turn/start', 'turn/end', 'user/message', 'goal/change'].includes(event.type)) return
    const events = recorded.get(session.id) ?? []
    events.push(event)
    recorded.set(session.id, events.slice(-3000))
  })
  const agent = id => {
    const found = ctx.agents.get(id)
    if (!found) throw new Error('unknown session ' + id)
    return found
  }
  const workspaceOf = id => ctx.get('workspaceRegistry').list().find(workspace => workspace.sessionIds.includes(id))
  registerPageRoute(ctx, '/handoff-probe', 'handoff-probe', pageRoute({
    prefix: '/handoff-probe',
    failure: error => ({ code: typeof error.code === 'string' ? error.code : 'PROBE', message: String(error.stack ?? error) }),
    endpoints: {
      goalState({id, disarm}) {
        const goals = ctx.get('goals'), current = agent(id)
        if (disarm) goals.disarm(current)
        return goals.get(current) ?? null
      },
      attentionPending({id, cancel}) {
        if (cancel) { attentionRequests.get(id)?.abort(); attentionRequests.delete(id); return true }
        const controller = new AbortController()
        attentionRequests.set(id, controller)
        void ctx.approval.request({agent: agent(id), toolName: 'synthetic-attention', reason: 'Synthetic pending input fixture; no action executes.', signal: controller.signal}).catch(() => undefined).finally(() => attentionRequests.delete(id))
        return true
      },
      environmentAudit() {
        return { capabilityAbsent: process.env.FIG_ATTENTION_CAPABILITY === undefined,
          generationAbsent: process.env.FIG_ATTENTION_GENERATION === undefined,
          nodeOptionsAbsent: process.env.NODE_OPTIONS === undefined,
          bootstrapConsumed: globalThis[Symbol.for('fig.attention.bootstrap')] === undefined }
      },
      async idle() {
        // Synchronisation only: the same reading as the Host's desktop activity read (fig-attention/index.js),
        // which main asks over its capability bridge. Tests then check main's own refusal.
        const controller = ctx.get('sessionController'), jobs = ctx.get('jobs')
        const { items } = await controller.list({}, AbortSignal.timeout(2500))
        const busy = job => job.status === 'running' || job.status === 'stopping'
        return !items.some(item => item.running || jobs.list(item.sessionId).some(busy)) && !jobs.list().some(busy)
      },
      async credentialAtomic() {
        const key = 'fig-synthetic/atomic'
        const credentials = ctx.get('credentials')
        const first = credentials.modifyRecord(key, async () => { await new Promise(resolve => setTimeout(resolve, 30)); return {kind: 'grant', payload: {synthetic: true}} })
        const second = credentials.deleteRecord(key)
        await Promise.all([first, second])
        const deleted = await credentials.readRecord(key) === undefined
        await credentials.deleteRecord(key)
        return {deleted}
      },
      async parent({ workspacePath, cwd, preset, route, title }) {
        const workspace = await ctx.get('workspaceRegistry').create(workspacePath)
        const { sessionId } = await ctx.get('sessionController').create({ workspaceId: workspace.id, agentPreset: 'standard' })
        const parent = agent(sessionId)
        if (route) parent.model.select(route)
        if (title) ctx.get('sessionTitle').rename(parent.session, title)
        ctx.permissionPresets.set(parent.session, preset)
        if (cwd) await ctx.workingDirectory.set(parent, cwd, AbortSignal.timeout(10_000))
        return { id: sessionId, workspaceId: workspace.id }
      },
      async call({ id, name, args, timeoutMs = 60000 }) {
        const parent = agent(id)
        const signal = AbortSignal.timeout(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 180000 ? timeoutMs : 60000)
        const toolSet = await ctx.tools.resolve({ agent: parent, modelSelection: parent.model.current(), signal })
        try {
          const result = await ctx.tools.execute({ agent: parent, signal, toolSet, calls: [
            { type: 'tool_call', id: randomUUID(), name, arguments: JSON.stringify(args ?? {}) }
          ] })
          return result.results[0]
        } finally { toolSet.dispose() }
      },
      inspect({ id }) {
        const child = agent(id)
        return {
          preset: ctx.permissionPresets.current(child.session),
          approval: ctx.approval.effectivePolicy(child.session),
          cwd: ctx.workingDirectory.get(child.session),
          headerCwd: child.session.header.cwd ?? null,
          workspaceId: workspaceOf(id)?.id ?? null,
          agentPreset: ctx.get('agentPresets')?.composedPreset(child.ctx),
          archived: ctx.get('workspaceRegistry').archivedSessionIds.includes(id),
          workspaces: ctx.get('workspaceRegistry').list().map(workspace => workspace.path),
          route: child.model.current(),
          messages: child.session.deriveMessages().map(message => ({ role: message.role, source: message.source?.kind ?? null,
            sourceMeta: message.source ?? null, id: message.id,
            text: (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join("\n").slice(0, 4000) }))
        }
      },
      async followup({ id, text }) {
        const { createUserMessage } = await import(new URL('file://' + require.resolve('@deepseek-ai/dsh-llm')).href)
        agent(id).followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
        return true
      },
      async stop({ id }) {
        await ctx.get('workspaceRegistry').stopSessionActivity(id).catch(() => undefined)
        return true
      },
      async guidance({ enabled }) {
        // Only mounted by these isolated tests; fresh sessions make OFF/ON source history independent. The
        // instructions package reads the switch from its settings file before each step.
        const { readFile, writeFile, mkdir } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const path = join(process.env.DSH_HOME, 'fig', 'workspace-instructions.json')
        const current = await readFile(path, 'utf8').then(JSON.parse, () => ({ schema: 1 }))
        await mkdir(join(process.env.DSH_HOME, 'fig'), { recursive: true })
        await writeFile(path, JSON.stringify({ ...current, harnessGuidance: enabled === true }) + '\n')
        return true
      },
      events({ id }) {
        agent(id) // never return a different or disposed session's events
        return recorded.get(id) ?? []
      },
      state({ id }) {
        return ctx.get('sessionController').state({ sessionId: id }, AbortSignal.timeout(5000))
      },
      prompt({ id, requestId, mode, content }) {
        return ctx.get('sessionController').prompt({ sessionId: id, requestId, mode, content }, AbortSignal.timeout(5000))
      },
      updateQueue({ id, itemId, action }) {
        return ctx.get('sessionController').updateQueue({ sessionId: id, itemId, action })
      },
      cancel({ id }) {
        return ctx.get('sessionController').cancel({ sessionId: id })
      },
      hold({ id }) {
        agent(id)
        gates.set(id, { entries: [] })
        return true
      },
      held({ id }) {
        return gates.get(id) ?? null
      },
      async skillInfo({ id }) {
        const current = agent(id), signal = AbortSignal.timeout(5000)
        const snapshot = await ctx.get('skills').snapshot({ scope: current, cwd: await ctx.workingDirectory.ensure(current, signal), signal })
        return { complete: snapshot.complete, skills: snapshot.skills.map(skill => ({ name: skill.name, path: skill.path ?? null })) }
      },
      rejectNext({ id }) {
        if (!promptWrapped) {
          const controller = ctx.get('sessionController'), original = controller.prompt.bind(controller)
          controller.prompt = async (request, signal) => {
            if (rejectPrompts.delete(request.sessionId)) {
              rejectedPrompts++
              const { RemoteError } = await import(new URL('file://' + require.resolve('@deepseek-ai/dsh-typert-protocol')).href)
              throw new RemoteError('session/agent-busy', 'Synthetic submission rejection', { sessionId: request.sessionId })
            }
            return original(request, signal)
          }
          promptWrapped = true
        }
        rejectPrompts.add(id)
        return true
      },
      rejectedPrompts() {
        return rejectedPrompts
      }
    }
  }))
}
