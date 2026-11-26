import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const supervisor = fileURLToPath(new URL('./owned-agent-supervisor.js', import.meta.url))

/** Signal only a group still pinned by the original live ChildProcess handle. */
export function signalOwnedGroup(leader, kind, kill = process.kill) {
  if (!leader.pid || leader.exitCode !== null || leader.signalCode !== null) throw new Error('leader-exited')
  try { kill(-leader.pid, kind) } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error
  }
}

/** Run one private CLI group. The DSH tool policy owns the deadline; this helper only owns cleanup. */
export async function runOwnedAgent({ file, args, cwd, input, signal, env = process.env, nodeExecutable = process.execPath, onOutput = undefined }) {
  signal?.throwIfAborted()
  const startedAt = performance.now()
  return new Promise((resolve, reject) => {
    const leader = spawn(nodeExecutable, [supervisor], {
      cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })
    let state = 'running'
    let result, failure, timer
    let out = '', err = ''
    const live = () => leader.pid && leader.exitCode === null && leader.signalCode === null
    function cleanupFailed(code) {
      failure = Object.assign(new Error(`External agent cleanup unconfirmed (${code})`), { code: 'AGENT_CLEANUP_FAILED' })
      state = 'cleanup-failed'
    }
    function signalGroup(kind) {
      // Never signal the saved group number once its owning leader has exited.
      try { signalOwnedGroup(leader, kind) } catch (error) {
        cleanupFailed(/** @type {NodeJS.ErrnoException} */ (error).code || 'leader-exited')
      }
    }
    function stop() {
      if (state !== 'running') return
      state = 'stopping'
      signalGroup('SIGTERM')
      // IPC lets the supervisor finish cleanup even if the parent later disappears.
      if (leader.connected) leader.send({ type: 'stop' }, () => {})
      timer = setTimeout(() => {
        if (live()) signalGroup('SIGKILL')
      }, 2000)
    }
    const abort = () => stop()
    signal?.addEventListener('abort', abort, { once: true })
    const output = (kind, chunk) => {
      if (kind === 'stdout') out += chunk; else err += chunk
      try { onOutput?.(kind, String(chunk)) } catch (error) { failure = error; stop() }
    }
    leader.stdout?.on('data', chunk => output('stdout', chunk))
    leader.stderr?.on('data', chunk => output('stderr', chunk))
    leader.stdin?.on('error', () => {})
    leader.on('message', raw => {
      const message = /** @type {{type?: string, code?: number, error?: string, signal?: string}} */ (raw)
      if (message?.type === 'ready' && state === 'running') {
        leader.send({ type: 'start', file, args, cwd }, () => {})
        leader.stdin?.end(input)
      } else if (message?.type === 'result' && !result) {
        result = message
        stop()
      } else if (message?.type === 'cleanup-error') cleanupFailed(message.code)
    })
    leader.on('error', error => { failure = error })
    leader.on('exit', () => {
      if (state === 'running') cleanupFailed('unexpected-leader-exit')
      // A process that escaped via setsid may still hold these descriptors. It is outside our
      // ownership boundary; do not hang or send any more signals to the departed leader's PGID.
      leader.stdout?.destroy()
      leader.stderr?.destroy()
      leader.stdin?.destroy()
    })
    leader.on('close', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure) return reject(failure)
      state = 'closed'
      if (signal?.aborted) return reject(signal.reason || new Error('External agent cancelled'))
      if (!result) return reject(new Error('External agent exited without a result'))
      if (result.error) return reject(Object.assign(new Error(`External agent spawn failed (${result.error})`), { code: result.error }))
      resolve({ code: result.code, signal: result.signal, out, err, elapsedMs: Math.round(performance.now() - startedAt) })
    })
    // Abort may have arrived between the initial check and listener registration.
    if (signal?.aborted) stop()
  })
}
