// Test-only host probe. Mounted explicitly in an isolated Web profile, never in the product.
import { randomUUID } from 'node:crypto'
import { pageRoute, registerPageRoute } from '../../harness/shared/http.js'

export const inject = ['agents', 'tools', 'agentPresets', 'permissionPresets', 'approval']
export function apply(ctx) {
  const handles = new Map()
  registerPageRoute(ctx, '/harness-probe', 'harness-probe', pageRoute({
    prefix: '/harness-probe',
    failure: error => ({ code: 'PROBE', message: String(error.stack ?? error) }),
    endpoints: {
      async create({ preset = 'standard', cwd, route }) {
        const handle = await ctx.agents.create({ sessionId: 'audit-' + randomUUID(), meta: { cwd, agentPreset: preset },
          agentOptions: route ?? { provider: 'deepseek-official', model: 'deepseek-flash' },
          setup: async scope => { await ctx.agentPresets.mount(scope, preset) } })
        handles.set(handle.agent.session.id, handle)
        ctx.permissionPresets.set(handle.agent.session, 'workspace-write')
        ctx.approval.setPolicy(handle.agent, 'never')
        const toolSet = await ctx.tools.resolve({ agent: handle.agent, modelSelection: handle.agent.model.current(), signal: AbortSignal.timeout(30_000) })
        try { return { id: handle.agent.session.id, tools: ctx.tools.schemas(handle.agent, toolSet) } }
        finally { toolSet.dispose() }
      },
      async call({ id, name, args, permission, requestContext }) {
        const agent = handles.get(id).agent
        if (permission) ctx.permissionPresets.set(agent.session, permission)
        const signal = AbortSignal.timeout(90_000)
        const toolSet = await ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal })
        try {
          const execute = () => ctx.tools.execute({ agent, signal, toolSet, calls: [
            { type: 'tool_call', id: randomUUID(), name, arguments: JSON.stringify(args ?? {}) }
          ] })
          if (!requestContext) return await execute()
          agent.session.append('request/context', requestContext)
          return await ctx.agents.withInitiator(agent, execute)
        } finally { toolSet.dispose() }
      },
      async close() {
        for (const handle of handles.values()) await handle.dispose()
        handles.clear()
        return true
      },
      inspect({ id }) {
        const agent = ctx.agents.get(id)
        return { route: agent?.model.current(), preset: agent ? ctx.permissionPresets.current(agent.session) : null }
      }
    }
  }))
}
