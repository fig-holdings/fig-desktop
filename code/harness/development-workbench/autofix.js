import { autofixStep, fixInstruction } from './actions.js'
import { activeCheck } from './ci.js'

// 自动修复: the Host watches one of a Session's pull requests and, when it needs fixing, sends the Session the same
// instruction as 交给 Agent (autofixStep decides). Watches live in memory only: a restart of Fig ends every one.

/** A watch whose look fails this many times in a row (about ten minutes) ends. */
const AUTOFIX_FAILURES = 10

/**
 * The auto-fix watches of one plugin instance.
 * @param {{ ctx: any, running: Map<string, any>, withSession: (sessionId: string, read: (tools: any) => Promise<any>) => Promise<any>,
 *   pullContext: (git: any, services: any, url: string, sessionId: string) => Promise<any>, send: (sessionId: string, text: string, allowed?: () => boolean | Promise<boolean>) => Promise<any>,
 *   externalInstruction?: (agent: any, pull: any, kind: string | undefined, chinese: boolean) => Promise<string | undefined> }} tools
 *   `running`: the Host's requests in flight by key, so a manual action on the Session holds the watch back.
 */
export function autofixWatches({ ctx, running, withSession, pullContext, send, externalInstruction }) {
  /** pull request address → its watch. */
  const watches = new Map()
  const stop = (url, sessionId) => {
    const watch = watches.get(url)
    if (!watch || watch.sessionId !== sessionId) return
    watch.stopped = true
    clearTimeout(watch.timer)
    watches.delete(url)
  }
  /** Starts watching `url` for the Session; a watch another Session held ends first. */
  const start = (sessionId, url, chinese) => {
    const existing = watches.get(url)
    if (existing && existing.sessionId !== sessionId) stop(url, existing.sessionId)
    if (watches.has(url)) return
    const watch = { sessionId, url, chinese, attempts: 0, handled: new Set(), status: 'watching', timer: undefined, stopped: false, failures: 0 }
    watches.set(url, watch)
    void tick(watch)
  }
  /** Session rows carry their watch's state, so the card shows 自动修复中 · 已发 N 次. */
  const withAutofix = (sessionId, value) => !value?.session ? value : { ...value, session: value.session.map(pull => {
    const watch = watches.get(pull.url)
    return watch && watch.sessionId === sessionId ? { ...pull, autofix: { status: watch.status, attempts: watch.attempts } } : pull
  }) }
  /** One look at a watched pull request: read it fresh, decide, maybe send, then look again later. */
  async function tick(watch) {
    if (watch.stopped) return
    let delay = 60_000
    try {
      const sessions = ctx.get('sessionController')
      await withSession(watch.sessionId, async ({ git, services, agent }) => {
        const context = await pullContext(git, services, watch.url, watch.sessionId)
        if (context.refused) { watch.status = 'error'; return }
        const external = context.pull.source === 'extension'
        if (external && !context.pull.policy?.allowed.includes('autofix')) { stop(watch.url, watch.sessionId); return }
        if (context.pull.checks?.some(activeCheck)) delay = 15_000
        const sessionRunning = Boolean((await sessions.state({ sessionId: watch.sessionId }, AbortSignal.timeout(5000)))?.running)
        const step = autofixStep(watch, context.pull, { onBranch: context.pull.current, running: sessionRunning })
        watch.status = step.status
        if (step.action === 'stop') { watch.stopped = true; if (step.status === 'ended') watches.delete(watch.url); return }
        if (step.action === 'wait') { if (step.status === 'waiting') delay = 15_000; return }
        // Switched off meanwhile, or a manual action on this Session in flight: nothing is sent this time.
        if (watch.stopped) return
        if (running.has('act:' + watch.sessionId)) { watch.status = 'waiting'; delay = 15_000; return }
        const attempt = watch.attempts + 1
        const instruction = external ? await externalInstruction?.(agent, context.pull, step.kind, watch.chinese)
          : fixInstruction({ pull: context.pull, kind: /** @type {any} */ (step.kind), root: context.root, attempt, chinese: watch.chinese })
        if (!instruction) { stop(watch.url, watch.sessionId); return }
        const sent = await send(watch.sessionId, instruction, async () => {
          if (watch.stopped) return false
          const current = await pullContext(git, services, watch.url, watch.sessionId)
          return !watch.stopped && !current.refused && current.pull.source === context.pull.source && current.pull.head === context.pull.head &&
            (!external || current.pull.policy?.allowed.includes('autofix') === true)
        })
        if (sent.sent) { watch.attempts = attempt; watch.handled.add(context.pull.head + ':' + step.kind) }
        else { watch.status = 'waiting'; delay = 15_000 }
      })
      watch.failures = 0
    } catch (error) {
      watch.status = 'error'
      ctx.logger?.warn?.(`fig-development-workbench: auto-fix ${watch.url}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)}`)
      // The Session was deleted, or looking keeps failing: the watch ends instead of retrying for the app's lifetime.
      watch.failures = (watch.failures ?? 0) + 1
      if (/** @type {any} */ (error)?.status === 404) { watch.stopped = true; watches.delete(watch.url) }
      else if (watch.failures >= AUTOFIX_FAILURES) watch.stopped = true
    }
    if (!watch.stopped) watch.timer = setTimeout(() => void tick(watch), delay)
  }
  /** Ends every watch, when the plugin is disposed. */
  const dispose = () => { for (const watch of watches.values()) { watch.stopped = true; clearTimeout(watch.timer) } watches.clear() }
  return { start, stop, withAutofix, dispose }
}
