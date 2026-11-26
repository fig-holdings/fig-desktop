import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dshVersion, launchDsh, verifiedDsh } from '../dsh-versions'
import { defaultWorkspacePath } from '../shared/workspace-registry.ts'

// Fig's Workspace and Runtime rows inside DSH settings. Paths are resolved here from fixed
// kinds; the page never sends a path to open.
// `version` reads the running DSH release; tests pass their own.
/** @param {{ home: string, startup: string, previousHome?: string, skillDirectory?: string, open?: (path: string) => Promise<void>, version?: () => Promise<string | undefined> }} options */
export function settingsService({ home, startup, previousHome = undefined, skillDirectory = undefined, open = openInFinder, version = dshVersion }) {
  // DSH has no default-workspace getter; the shared reader accepts only the registry format of a
  // release Fig verified, the same check the native default-workspace change applies.
  const defaultWorkspace = async () => defaultWorkspacePath(home, await version())

  // The running DSH, whether Fig verified it, and the npm latest the main process last noted.
  async function dshRelease() {
    const running = await version()
    let latest
    try { latest = JSON.parse(await readFile(join(home, 'fig/dsh-latest.json'), 'utf8'))?.latest } catch {}
    return { running, launch: launchDsh, verified: running !== undefined && verifiedDsh.includes(running),
      latest: typeof latest === 'string' ? latest : undefined, latestVerified: typeof latest === 'string' && verifiedDsh.includes(latest) }
  }

  return {
    async info() {
      return { startup, defaultWorkspace: await defaultWorkspace(), dshHome: home, ...(previousHome ? {previousDshHome: previousHome} : {}),
        ...(skillDirectory ? {skillDirectory} : {}), nodeVersion: process.version, dsh: await dshRelease() }
    },
    async open(kind) {
      const path = kind === 'startup' ? startup : kind === 'dshHome' ? home : kind === 'skillDirectory' ? skillDirectory
        : kind === 'defaultWorkspace' ? await defaultWorkspace() : undefined
      if (!path || !(await stat(path).catch(() => undefined))?.isDirectory()) throw new Error('unavailable')
      await open(path)
    }
  }
}

function openInFinder(path) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [path], error => error ? reject(error) : resolve())
  }))
}
