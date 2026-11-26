import { fromDsh } from '../shared/dsh-plugin.js'
import { pageRoute, registerPageRoute, RouteError } from '../shared/http.js'
import { guidanceSnapshot } from './harness-guidance.js'
import { instructionSettings, instructionsEnabled, instructionSnapshot, setInstructionsEnabled, sharedInstructionsPlan } from '../shared/workspace-instructions.js'

// Before each step: the short Harness guidance, and the AGENTS.md files between `startupDirectory` and the
// project's Git root that DSH's own nearest-root discovery leaves out. Config:
// - `startupDirectory`: where parent rules start; without it no parent rules are added.
// The parent-rules switch is a setting under the DSH home; the page reads and changes it on /fig-instructions. The same
// file can turn the short guidance off (`harnessGuidance: false`), which only tests do.
// While this package runs it offers the read-only `figInstructions` service, so rule sources can tell when it is off.

export const name = 'fig-instructions'
export const inject = ['workingDirectory']
const prefix = '/fig-instructions'

/** @param {any} ctx @param {{ startupDirectory?: string }} [config] */
export async function apply(ctx, config = {}) {
  const startup = typeof config?.startupDirectory === 'string' ? config.startupDirectory : undefined
  ctx.provide('figInstructions', Object.freeze({ startupDirectory: startup }))
  registerPageRoute(ctx, prefix, 'fig-instructions: route', (connection, req, res) => route(connection, req, res, {}))
  const { createUserMessage } = await fromDsh('@deepseek-ai/dsh-llm')
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const settings = await instructionSettings()
    const plan = await sharedInstructionsPlan(await ctx.workingDirectory.ensure(agent, signal), startup, settings.enabled)
    signal.throwIfAborted()
    const messages = [...agent.session.deriveMessages(), ...decision.messages]
    const snapshots = [guidanceSnapshot(messages, settings.harnessGuidance), instructionSnapshot(plan, messages)]
      .filter(Boolean).map(snapshot => createUserMessage(snapshot))
    if (!snapshots.length) return decision
    return { ...decision, messages: [...snapshots, ...decision.messages] }
  })
}

/** POST /fig-instructions/<endpoint>: the parent-rules switch. */
export const route = pageRoute({
  prefix,
  endpoints: {
    'settings': async () => ({ enabled: await instructionsEnabled() }),
    'enable': payload => {
      if (typeof payload?.enabled !== 'boolean') throw new RouteError(400, 'BAD_REQUEST')
      return setInstructionsEnabled(payload.enabled)
    }
  },
  failure: () => ({ code: 'INSTRUCTIONS' })
})
