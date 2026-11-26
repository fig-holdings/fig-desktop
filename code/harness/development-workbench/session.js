import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { RouteError } from '../shared/http.js'
import { gitRunner } from './git.js'

// The 研发工作台 Host's link to DSH's Sessions: a git runner under a Session's working directory and sandbox policy, the
// instructions it queues for the Session's Agent, and the new Sessions it opens in a worktree.

/**
 * Runs `read` with a git runner for the Session's working directory and sandbox policy.
 * @param {any} ctx @param {string} sessionId
 * @param {(tools: { git: any, services: any, directory: string, agent: any }) => Promise<any>} read
 */
export async function withSession(ctx, sessionId, read) {
  const sessions = ctx.get('sessionController')
  const directories = ctx.get('workingDirectory')
  const services = { subprocess: ctx.get('subprocess'), sandbox: ctx.get('sandbox') }
  const policies = ctx.get('sandboxPolicy')
  if (!sessions || !directories || !services.subprocess || !services.sandbox || !policies) throw new RouteError(503, 'WORKBENCH_UNAVAILABLE')
  const { agent } = await sessions.resolveAgent(sessionId)
  if (!agent) throw new RouteError(404, 'UNKNOWN_SESSION')
  const directory = directories.get(agent.session)
  if (!directory) return { repository: null }
  const git = gitRunner(services, policies.resolve({ session: agent.session }), directory, AbortSignal.timeout(30_000))
  return read({ git, services, directory, agent })
}

/** Queues `text` as the Session's next message. @param {any} sessions - DSH's session controller @param {string} sessionId @param {string} text */
export const promptSession = (sessions, sessionId, text) =>
  sessions.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(10_000))

/**
 * Sends one fixed instruction to the Session's Agent, only while it is idle: like 提交…, a write never interleaves with
 * a running turn. @param {any} ctx @param {string} sessionId @param {string} text @param {() => boolean | Promise<boolean>} [allowed]
 */
export async function send(ctx, sessionId, text, allowed = () => true) {
  const sessions = ctx.get('sessionController')
  // The permission re-check can take seconds; the idle check comes after it, right before the prompt.
  if (!await allowed()) return { refused: 'changed' }
  if ((await sessions.state({ sessionId }, AbortSignal.timeout(5000)))?.running) return { refused: 'running' }
  await promptSession(sessions, sessionId, text)
  return { sent: true }
}

/**
 * A new Session in the source Session's Workspace, working in `path` (same preset and model as the source).
 * @param {any} ctx @param {string} sourceId @param {string} path @param {string} [message]
 */
export async function openSessionIn(ctx, sourceId, path, message) {
  const sessions = ctx.get('sessionController'), workspaces = ctx.get('workspaceRegistry'), directories = ctx.get('workingDirectory')
  const workspace = workspaces?.list?.().find(each => [...(each.sessionIds ?? [])].includes(sourceId))
  if (!workspace) return { refused: 'no-workspace' }
  const { sessionId } = await sessions.create({ workspaceId: workspace.id })
  const [{ agent }, { agent: source }] = await Promise.all([sessions.resolveAgent(sessionId), sessions.resolveAgent(sourceId)])
  await directories.set(agent, path, AbortSignal.timeout(10_000))
  try { const presets = ctx.get('permissionPresets'); presets?.set?.(agent.session, presets.current(source.session)) } catch { /* the default preset applies */ }
  try { agent.model?.select?.(source.model.current()) } catch { /* the default model applies */ }
  if (message) await promptSession(sessions, sessionId, message)
  return { sessionId, opened: true }
}

/** A path under the home folder as ~/…, as the card shows it. @param {string} path */
export function homePath(path) {
  const home = homedir()
  return path === home ? '~' : path.startsWith(home + sep) ? '~' + path.slice(home.length) : path
}
