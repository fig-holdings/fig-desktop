import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { settingsService } from './settings.js'
import { dshHome } from '../shared/dsh-plugin.js'
import { pageRoute, registerPageRoute } from '../shared/http.js'
import { overlapOf } from './plugin-overlaps.js'
import { readJsonFile, writeRecord } from '../shared/atomic-json.ts'
import { profileShellDefaults } from '../shared/profile-contract.ts'

// Fig Desktop's skin, Host half: the folders and runtime facts its Runtime settings section shows, and which
// installed plugins duplicate a Fig feature. Config, written by Fig's main process at each start:
// - `startupDirectory`: where Fig started DSH (default: DSH's working directory);
// - `previousDshHome`: the data folder before the last move, while it can still be restored;
// - `skillDirectory`: the extra skill folder, when one is set;
// - `profile`: this Profile (app/main/profile.ts, shared/profile-contract.ts): edition, shell look, external plugins.
//   The page gets it as the `figProfile` service (client-profile.js). Without one, a personal Profile with the default look.

export const name = 'fig-desktop-skin'
const prefix = '/fig-skin'
const absolute = value => typeof value === 'string' && isAbsolute(value) ? value : undefined

/** The Profile the page sees; a personal one with the default look when main gave none. */
export function profileState(profile) {
  return profile && typeof profile === 'object' && typeof profile.id === 'string' ? profile
    : { id: 'personal', edition: 'personal', dshGeneration: 0, shell: profileShellDefaults(), plugins: [] }
}

/** The user's own sidebar pin choices in this Profile, over its defaults: panel id → shown. */
export function panelPins(home) {
  const path = join(home, 'fig', 'panel-pins.json')
  const valid = value => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'boolean')
  const current = async () => { const value = (await readJsonFile(path))?.pinned; return valid(value) ? value : {} }
  // Writes run one at a time, each reading the last one's result: two quick clicks must both be kept.
  let queue = Promise.resolve()
  return {
    read: async () => { await queue; return current() },
    write(id, pinned) {
      if (typeof id !== 'string' || !id || id.length > 200 || typeof pinned !== 'boolean') return Promise.reject(new Error('Invalid pin'))
      const operation = queue.then(async () => {
        await writeRecord(path, { pinned: { ...await current(), [id]: pinned } })
        return true
      })
      queue = operation.then(() => {}, () => {})
      return operation
    }
  }
}

/** The folder under the startup directory that becomes the first-use Workspace; DSH shows a Workspace titled this as 「默认工作区」. */
export const defaultWorkspaceName = 'default-workspace'

/**
 * Claims DSH's first-use Workspace before its page does. On an empty installation DSH's page asks the Workspace
 * controller to initialize the default Workspace, which creates `<Documents>/deepseek-harness/default-workspace`
 * outside the folder the user chose. The registry's own `initializeDefault` takes the directory from its caller and
 * answers every later call with the Workspace it already has, so calling it first with a folder under the startup
 * directory keeps the default there. An installation that already has a Workspace or a Session is not eligible and
 * nothing happens.
 * @param {{ initializeDefault?: (resolve: () => Promise<string>) => Promise<unknown> } | undefined} registry
 * @param {string | undefined} startup the startup directory Fig's main process chose; without one nothing is claimed
 * @param {{ warn?: (line: string) => void }} [logger]
 */
export async function claimDefaultWorkspace(registry, startup, logger) {
  if (!startup || typeof registry?.initializeDefault !== 'function') return undefined
  try {
    return await registry.initializeDefault(async () => join(startup, defaultWorkspaceName))
  } catch (error) {
    logger?.warn?.('fig-desktop-skin: the default workspace could not be set under the startup directory: ' + (error instanceof Error ? error.message : String(error)))
    return undefined
  }
}

/** @param {any} ctx @param {{ startupDirectory?: string, previousDshHome?: string, skillDirectory?: string, profile?: any }} [config] */
export function apply(ctx, config = {}) {
  const home = dshHome()
  const services = {
    home,
    profile: profileState(config?.profile),
    pins: panelPins(home),
    settings: settingsService({ home, startup: absolute(config?.startupDirectory) ?? process.cwd(),
      previousHome: absolute(config?.previousDshHome), skillDirectory: absolute(config?.skillDirectory) })
  }
  // Only a start by Fig's main process names the startup directory; DSH's working directory is not used for this.
  const startup = absolute(config?.startupDirectory)
  if (startup) ctx.inject(['workspaceRegistry'], scope => { void claimDefaultWorkspace(scope.workspaceRegistry, startup, ctx.logger) })
  registerPageRoute(ctx, prefix, 'fig-desktop-skin: route', (connection, req, res) => route(connection, req, res, services))
}

/** POST /fig-skin/<endpoint> for the page plugin. */
export const route = pageRoute({
  prefix,
  endpoints: {
    'settings/info': (_payload, { settings }) => settings.info(),
    'settings/open': (payload, { settings }) => settings.open(payload?.directory).then(() => true),
    'plugins/overlaps': (_payload, { home }) => installedOverlaps(home),
    'profile/state': (_payload, { profile }) => profile,
    'process/default-state': async (_payload, { home }) => ({ applied: (await readJsonFile(join(home, 'fig', 'process-default.json')))?.applied === true }),
    'process/default-applied': async (_payload, { home }) => { await writeRecord(join(home, 'fig', 'process-default.json'), { applied: true }); return true },
    'profile/pins': (_payload, { pins }) => pins.read(),
    'profile/pin': (payload, { pins }) => pins.write(payload?.id, payload?.pinned)
  },
  failure: (_error, endpoint) => ({ code: endpoint.split('/')[0].toUpperCase() })
})

/** Installed plugins of the Web profile that duplicate a Fig feature (plugin-overlaps.js), for the Plugins page. */
export async function installedOverlaps(home) {
  const manifest = await readFile(join(home, 'profiles/web/package.json'), 'utf8').then(JSON.parse, () => ({}))
  const selected = new Set(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  // An experimental plugin turned on is a bundle only, so both lists are read.
  const names = new Set([...Object.keys(manifest?.dependencies ?? {}), ...selected])
  return { plugins: [...names].flatMap(name => {
    const overlap = overlapOf(name)
    return overlap ? [{ name, feature: overlap.feature, partial: overlap.partial === true, on: selected.has(name) }] : []
  }) }
}

