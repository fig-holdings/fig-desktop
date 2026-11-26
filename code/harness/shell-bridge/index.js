import { open, realpath, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { spawn } from 'node:child_process'
import { runOwnedAgent } from '../shared/owned-agent.js'
import { registerPageRoute } from '../shared/http.js'
import { desktopBridge } from './bridge.ts'
import { publicProfile } from '../shared/profile-contract.ts'
import { teamModels } from '../shared/team-models.ts'
import { dshHome } from '../shared/dsh-home.js'

// Fig Desktop's shell, as seen from inside DSH. Packages never reach
// the Electron main process themselves; this package is the one place that does, in both directions:
// - capabilities the shell lends to packages, offered as the optional `shellCapabilities` service: `renderPage`
//   (the preview package's page capture) and `alerts` (main turns task activity into notifications, a Dock badge
//   and keeping the Mac awake). A package that finds no such service keeps the matching feature off.
// - state main reads from packages: the task activity package's `figAttention` service, served to main on a
//   loopback route that only the one-use capability from bootstrap.js opens.
// - the Profile's public facts, `profile` ({ id, edition, dshGeneration }), and `openExternal(url)`, which opens a page
//   of the Profile's Cowork site (its admin or account pages) in the default browser. Each capability is present only
//   when the shell provides it, so a package that also runs without Fig's shell (DSH Web in the cloud) checks for it and
//   falls back. Signed `coworkTeam` request headers and `openCachedFile` are Host-only team capabilities.
// Config `renderer`: how the shell starts its page capture, `{ executable, args }`; without one there is no `renderPage`.
// Config `profile`: the Profile's public facts; `coworkOrigin`: the only origin `openExternal` opens (app/main/plugin-config.ts).

export const name = 'fig-shell-bridge'

/** Runs the shell's page capture for one preview job; writes its log next to the job. */
export function pageRenderer(command) {
  return async function renderPage(jobPath, { signal, logPath }) {
    const env = Object.fromEntries(['HOME','PATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    try {
      const result = await runOwnedAgent({file: command.executable, args: [...command.args, '--fig-capture=' + jobPath], cwd: process.cwd(), input: '', env, signal})
      await writeFile(logPath, `exit ${result.code} ${result.signal ?? ''}\n${result.out.slice(-4000)}\n${result.err.slice(-4000)}`)
      if (result.code !== 0) throw new Error('The page capture did not finish; see its local capture.log')
    } catch (error) {
      if (signal?.aborted) throw new Error('Preview cancelled or timed out; owned process cleanup awaited.')
      throw error
    }
  }
}

/** Opens `url` in the default browser when it is on `origin` over https (or a loopback http origin in development). */
const runOpen = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: 'ignore' })
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve(undefined) : reject(new Error('The system could not open the target')))
})

export function externalOpener(origin, run = runOpen) {
  return async function openExternal(url) {
    let target
    try { target = new URL(url) } catch { throw new Error('openExternal: invalid URL') }
    if (target.origin !== origin || target.username || target.password) throw new Error('openExternal: only the Profile\'s Cowork site can be opened')
    // macOS `open` hands the URL to the default browser; `--` keeps it from being read as an option.
    await run('/usr/bin/open', ['--', target.href])
  }
}

const launchable = new Set(['.app', '.command', '.terminal', '.workflow', '.scpt', '.scptd', '.sh', '.zsh', '.bash', '.pkg', '.mpkg', '.dmg', '.webloc', '.inetloc', '.url', '.alias',
  '.fileloc', '.mobileconfig', '.jar', '.prefpane', '.saver', '.action', '.definition', '.osax', '.kext', '.plugin', '.bundle'])

/** Opens a downloaded regular document inside this Profile's Cowork cache through its OS association. */
export function cachedFileOpener(home, run = runOpen) {
  return async function openCachedFile(relativePath) {
    if (typeof relativePath !== 'string' || isAbsolute(relativePath) || /[\\\0]/.test(relativePath) ||
      relativePath.split('/').some(piece => !piece || piece === '.' || piece === '..') || launchable.has(extname(relativePath).toLowerCase()))
      throw new Error('Invalid Cowork cache path')
    const path = join(await realpath(home), 'fig', 'cowork-files', relativePath)
    if (await realpath(path) !== path) throw new Error('Cowork cache links cannot be opened')
    // O_NOFOLLOW prevents substituting a final symlink before the stat. The cache is owned by the local Host.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.mode & 0o111) throw new Error('Expected a Cowork cache document')
      await run('/usr/bin/open', ['--', path])
    } finally { await file.close() }
  }
}

/** Only this Host can ask main for the headers of a specific Cowork team request. */
export function coworkTeamCapability(port, token) {
  return Object.freeze({ version: 1, async authorize(request) {
    const response = await fetch(`http://127.0.0.1:${port}/authorize`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request)
    })
    if (!response.ok) throw new Error(response.status === 401 ? 'COWORK_AUTH_EXPIRED' : 'COWORK_TEAM_UNAVAILABLE')
    return response.json()
  } })
}

/** @param {any} ctx @param {{ renderer?: { executable?: string, args?: string[] }, profile?: any, coworkOrigin?: string, teamModels?: any }} [config] */
export function apply(ctx, config = {}) {
  // Left by bootstrap.js when main started this Host with its desktop channel; read once, then gone.
  const key = Symbol.for('fig.attention.bootstrap')
  const bootstrap = globalThis[key]
  delete globalThis[key]
  const renderer = config?.renderer
  const command = typeof renderer?.executable === 'string' && renderer.executable
    ? { executable: renderer.executable, args: Array.isArray(renderer.args) ? renderer.args.filter(item => typeof item === 'string') : [] } : undefined
  const profile = publicProfile(config?.profile)
  const origin = typeof config?.coworkOrigin === 'string' ? config.coworkOrigin : undefined
  ctx.provide('shellCapabilities', {
    ...command ? { renderPage: pageRenderer(command) } : {},
    alerts: Boolean(bootstrap),
    ...profile ? { profile } : {},
    ...profile?.edition === 'team' ? { teamModels: teamModels(config.teamModels) } : {},
    ...profile?.edition === 'team' && bootstrap && process.platform === 'darwin' ? { openCachedFile: cachedFileOpener(dshHome()) } : {},
    ...profile?.edition === 'team' && bootstrap?.teamPort ? { coworkTeam: coworkTeamCapability(bootstrap.teamPort, bootstrap.teamCapability) } : {},
    ...origin && process.platform === 'darwin' ? { openExternal: externalOpener(origin) } : {}
  })
  if (!bootstrap) return
  ctx.inject(['figAttention'], scope => {
    const bridge = desktopBridge(bootstrap.capability, bootstrap.generation, scope.figAttention)
    registerPageRoute(scope, '/fig-desktop', 'desktop reads', (_connection, req, res) => bridge(req, res))
  })
}
