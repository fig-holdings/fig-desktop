// Test-only native permission/approval seam; no model calls and no product registration.
import {randomUUID} from 'node:crypto'
import {pageRoute, registerPageRoute} from '../../harness/shared/http.js'
export const inject = ['agents','tools','permissionPresets','approval']
export function apply(ctx) {
  const modes = new Map(), answers = new Map(), jobs = new Map()
  let asked = 0, disposeAuto
  ctx.on('approval/request', async (request, next) => {
    if (request.toolName !== 'preview' || !modes.has(request.agent.session.id)) return next()
    asked++
    const mode = modes.get(request.agent.session.id)
    if (mode === 'native-ui') return next()
    if (mode === 'defer') return new Promise(resolve => answers.set(request.agent.session.id, resolve))
    return mode
  }, {prepend: true})
  const agent = id => {const value = ctx.agents.get(id); if (!value) throw Error('Unknown synthetic Agent'); return value}
  registerPageRoute(ctx, '/preview-probe', 'preview native fixture', pageRoute({prefix: '/preview-probe', failure: () => ({code: 'PREVIEW_PROBE'}), endpoints: {
    configure({id, preset, mode = 'allowed-once', policy}) {
      const value = agent(id)
      if (preset === 'auto' && !disposeAuto) disposeAuto = ctx.permissionPresets.registerAuto(() => {})
      ctx.permissionPresets.set(value.session, preset === 'custom' ? 'danger-full-access' : preset)
      if (preset === 'custom') ctx.approval.setPolicy(value, 'ask')
      if (policy) ctx.approval.setPolicy(value, policy)
      modes.set(id, mode)
      const current = ctx.permissionPresets.current(value.session)
      let spec; try {spec = ctx.permissionPresets.resolve(current)} catch {}
      return {current, spec, asked, effectiveApproval: ctx.approval.effectivePolicy(value.session)}
    },
    meta: () => ({available: Boolean(ctx.tools.get('preview')), services: {approval: Boolean(ctx.get('approval')), permissionPresets: Boolean(ctx.get('permissionPresets'))}}),
    stats: () => ({asked, waiting: answers.size}),
    answer({id}) {answers.get(id)?.('allowed-once'); answers.delete(id); return true},
    run({id, args}) {
      const key = randomUUID(), controller = new AbortController(), record = {status: 'running', controller, result: undefined}
      jobs.set(key, record)
      void (async () => {
        const value = agent(id), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
        const toolSet = await ctx.tools.resolve({agent: value, modelSelection: value.model.current(), signal})
        try {record.result = (await ctx.tools.execute({agent: value, signal, toolSet, calls: [{type: 'tool_call', id: randomUUID(), name: 'preview', arguments: JSON.stringify(args)}]})).results[0].result}
        finally {toolSet.dispose()}
      })().catch(error => {record.result = {isError: true, error: {message: String(error.message)}}}).finally(() => {record.status = 'done'})
      return {key}
    },
    status({key}) {const record = jobs.get(key); return {status: record.status, result: record.result}},
    stop({key}) {jobs.get(key)?.controller.abort(); return true}
  }}))
  ctx.effect(() => () => {for (const record of jobs.values()) record.controller.abort(); disposeAuto?.()})
}
