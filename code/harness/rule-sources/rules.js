import { sharedInstructionsPlan, instructionDigest } from '../shared/workspace-instructions.js'
import { harnessGuidanceSource, workspaceInstructionsSource } from '../shared/message-sources.js'
import { RouteError } from '../shared/http.js'

/**
 * Reads only this Host's already-active Agent. No resolve/create/retain, no body-text source inference.
 * The instructions package offers the optional `figInstructions` service while it runs; without it no rule file is
 * injected on the next step, so the current files are not listed (status `off`).
 * @param {any} ctx @param {unknown} sessionId @param {string} [startup] the configured startup folder
 */
export async function rulesInfo(ctx, sessionId, startup) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new RouteError(400, 'BAD_REQUEST')
  const checkedAt = new Date().toISOString()
  const agent = ctx.agents.get(sessionId)
  if (!agent) return {status: 'unknown', reason: 'inactive', nativeProject: 'unknown', checkedAt}
  // get() is the public, committed effective directory; ensure() may perform recovery writes.
  const cwd = ctx.workingDirectory?.get(agent.session)
  if (typeof cwd !== 'string') return {status: 'unknown', reason: 'cwd', nativeProject: 'unknown', checkedAt}
  const messages = agent.session.deriveMessages()
  const source = messages.findLast(message => message.source?.kind === workspaceInstructionsSource)?.source
  const structured = source?.schema === 2 && Array.isArray(source.sections)
  const injected = structured ? source.sections.map(section => ({path: section.path, status: section.status, contentDigest: section.contentDigest})) : undefined
  const guidance = messages.findLast(message => message.source?.kind === harnessGuidanceSource)?.source?.version
  const result = { status: 'off', cwd, injectedCwd: structured ? source.cwd : undefined, injectedDigest: structured ? source.digest : undefined,
    injected, checkedAt, nativeProject: 'unknown', guidance }
  if (ctx.get('figInstructions') !== undefined) {
    const plan = await sharedInstructionsPlan(cwd, startup)
    const digest = instructionDigest(plan)
    Object.assign(result, { status: structured ? source.digest === digest ? 'matching' : 'changed' : 'unknown', currentDigest: digest, current: plan.sections })
  }
  // No text, reasoning, credentials or arbitrary sources are returned.
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) return {status: 'unknown', reason: 'bound', nativeProject: 'unknown', checkedAt}
  return result
}
