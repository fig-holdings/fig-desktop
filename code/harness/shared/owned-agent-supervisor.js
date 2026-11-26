import { spawn } from 'node:child_process'

// This entry is a private child of owned-agent.js (delegate_agent, the shell's page capture, Grok sign-in), never a DSH plugin. Remain the process-group
// leader until SIGKILL so the parent never signals a recycled PGID after the CLI has exited.
let started = false
let stopping = false
let stopStarted = 0
let orphanTimer
const report = value => {
  if (process.connected) process.send?.(value, () => {})
}
function stop() {
  // While connected the parent owns escalation. Competing KILL timers can race into a transient
  // macOS EPERM as the group disappears. Take over only when that parent is gone.
  if (!process.connected && !orphanTimer) {
    orphanTimer = setTimeout(() => process.kill(-process.pid, 'SIGKILL'), stopping ? Math.max(0, 2000 - (performance.now() - stopStarted)) : 2000)
  }
  if (!stopping) {
    stopping = true
    stopStarted = performance.now()
    try { process.kill(-process.pid, 'SIGTERM') } catch (error) {
      report({ type: 'cleanup-error', code: /** @type {NodeJS.ErrnoException} */ (error).code })
    }
  }
}
process.on('SIGTERM', stop)
process.on('disconnect', stop)
process.on('message', raw => {
  const message = /** @type {{type?: string, file: string, args: string[], cwd: string}} */ (raw)
  if (message?.type === 'stop') return stop()
  if (message?.type !== 'start' || started || stopping) return
  started = true
  const child = spawn(message.file, message.args, {
    cwd: message.cwd, env: process.env, detached: false, stdio: ['pipe', 'inherit', 'inherit']
  })
  child.stdin.on('error', () => {})
  process.stdin.pipe(child.stdin)
  child.on('error', error => report({ type: 'result', error: /** @type {NodeJS.ErrnoException} */ (error).code || 'SPAWN_FAILED' }))
  // 'close' may wait forever for a descendant holding stdout; 'exit' is the logical CLI result.
  child.on('exit', (code, signal) => report({ type: 'result', code, signal }))
})
report({ type: 'ready' })
