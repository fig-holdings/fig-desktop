import { mkdir, mkdtemp, realpath, lstat, rm, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** A verification that could not run safely (missing evidence, credentials or isolation); reported as blocked, not failed. */
export class BlockedError extends Error { status = 'blocked' }

/** Whether `pid` (negative: a process group) still exists. */
const alive = pid => {
  try { process.kill(pid, 0); return true } catch (/** @type {any} */ error) { return error.code !== 'ESRCH' }
}

/** Waits up to `timeout` ms for every one of `pids` to exit; true once they all have. */
export async function exited(pids, timeout = 5000) {
  const end = Date.now() + timeout
  while (pids.some(alive) && Date.now() < end) await delay(50)
  return !pids.some(alive)
}

/** The DSH service's pid as Fig's startup window reports it, or undefined. */
export function servicePid(app) {
  return app.evaluate(async ({ BrowserWindow }) => {
    const page = BrowserWindow.getAllWindows()[0]?.webContents
    return page ? page.executeJavaScript('window.fig?.getState().then(s => s.pid)') : undefined
  })
}

/** An app's own process plus, when known, the DSH service and its process group. */
export const appProcesses = (pid, service) => service ? [pid, service, -service] : [pid]

/** Own only a freshly created profile; reused directories are never cleanup targets. */
export async function profileLifecycle({ evidence, prefix, reuse, reportName = `${prefix}lifecycle.json`, retainForReuse = false, timeout = 5000 }) {
  await mkdir(evidence, { recursive: true })
  const parent = await realpath(evidence)
  if (!prefix || /[/\\]/.test(prefix)) throw new Error('Invalid profile prefix')
  if (dirname(reportName) !== '.' || reportName.includes('..')) throw new Error('Invalid lifecycle report name')
  const profile = reuse ? await realpath(reuse) : await mkdtemp(join(parent, prefix))
  if (dirname(profile) !== parent || !profile.startsWith(join(parent, prefix))) throw new Error('Profile outside expected evidence parent/prefix')
  const identity = await lstat(profile)
  const applications = new Set()
  const pids = new WeakMap()
  const closed = new WeakSet()
  let unsafe = false
  return {
    profile,
    track(app) { const pid = app.process().pid; pids.set(app, pid); applications.add(pid); return app },
    async close(app) {
      if (!app || closed.has(app)) return
      const pid = pids.get(app) ?? app.process().pid
      applications.add(pid)
      let service
      try { service = await servicePid(app) } catch { unsafe = true }
      try { await app.close() } catch (error) { unsafe = true; throw error }
      if (!await exited(appProcesses(pid, service), timeout)) { unsafe = true; throw new Error('Verification processes still alive; profile retained') }
      applications.delete(pid)
      closed.add(app)
    },
    async finish(passed = false) {
      const report = { profile, outcome: passed ? 'passed' : 'failed', disposition: 'retained', reason: '' }
      if (!passed) report.reason = 'test-failed-or-incomplete'
      else if (reuse || retainForReuse) report.reason = 'explicit-reuse'
      else if (unsafe || applications.size) report.reason = 'process-exit-not-confirmed'
      else {
        const current = await lstat(profile)
        if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || await realpath(profile) !== resolve(profile)) throw new Error('Profile identity changed; refusing removal')
        // Exact newly-created absolute path, parent and inode were checked above. No directory scan.
        await rm(profile, { recursive: true })
        report.disposition = 'removed'
        report.reason = 'owned-successful-profile-processes-exited'
      }
      await writeFile(join(parent, reportName), JSON.stringify(report, null, 2) + '\n')
      if (report.disposition === 'retained') console.error('Verification profile retained:', profile, report.reason)
      return report
    }
  }
}
