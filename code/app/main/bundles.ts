import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { errorText } from '../../harness/shared/log'
import { deselectBundles, readWebProfile, type WebProfileManifest } from './web-profile'

// Fig's plugin packages as DSH plugin bundles (each one listed on DSH's Plugins page). The built packages
// are placed under the DSH home in a folder named by their content, so the path has no spaces (the app's own path
// does, which DSH's package handling trips on) and changes exactly when the code does. They are installed into the
// Web profile as `link:` dependencies through `dsh plugin --profile web add`, which also selects them; DSH's Plugins
// page then lists them and the user can switch them off. A new build relinks them and keeps the user's choices.
// Each package is self-contained (electron.vite.config.ts builds its host script alone). A package with a plugin
// update (plugin-updates.ts) is linked from the update's folder instead of being placed from the build.

const placementRoot = (dshHome: string) => join(dshHome, 'fig', 'packages')

async function files(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(root, join(directory, entry.name))
    : Promise.resolve(entry.isFile() ? [relative(root, join(directory, entry.name))] : [])))
  return nested.flat().sort()
}

/** A short hash of every file the packages consist of. */
export async function contentHash(built: string, packages: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const name of [...packages].sort()) {
    for (const file of await files(join(built, name))) {
      hash.update(name + '/' + file + '\0')
      hash.update(await readFile(join(built, name, file)))
    }
  }
  return hash.digest('hex').slice(0, 16)
}

/** Copies the packages to `<dshHome>/fig/packages/<hash>/` once; returns that folder. */
export async function placePackages(built: string, packages: readonly string[], dshHome: string): Promise<string> {
  const target = join(placementRoot(dshHome), await contentHash(built, packages))
  if (await stat(target).then(() => true, () => false)) return target
  const incoming = target + '.incoming-' + process.pid
  await rm(incoming, { recursive: true, force: true })
  await mkdir(incoming, { recursive: true })
  for (const name of packages) await cp(join(built, name), join(incoming, name), { recursive: true })
  // Another Fig (an isolated test profile on the same home) may have placed the same content meanwhile.
  await rename(incoming, target).catch(async error => {
    await rm(incoming, { recursive: true, force: true })
    if (!await stat(target).then(() => true, () => false)) throw error
  })
  return target
}

export interface BundlePlan {
  /** absolute package folders to `add`: new, moved to a new placement, or missing */
  add: string[]
  /** Fig bundles from an earlier placement this build no longer ships, to `remove` */
  remove: string[]
  /** Fig bundles the user had switched off; switched off again after `add` selects them */
  keepOff: string[]
}

/** What to change so the profile links every package from its folder in `sources` (folder → absolute package folder).
 * `names` maps folder → package name. */
export function planBundles(profile: WebProfileManifest | undefined, sources: Record<string, string>, names: Record<string, string>, dshHome: string): BundlePlan {
  const dependencies = profile?.dependencies ?? {}
  const selected = new Set(profile?.bundles ?? [])
  const ours = `link:${placementRoot(dshHome)}/`
  const shipped = new Set(Object.values(names))
  const add = Object.entries(names).filter(([folder, name]) => dependencies[name] !== `link:${sources[folder]}`).map(([folder]) => sources[folder])
  const remove = Object.entries(dependencies).filter(([name, spec]) => !shipped.has(name) && typeof spec === 'string' && spec.startsWith(ours)).map(([name]) => name)
  const keepOff = Object.entries(names).filter(([, name]) => Object.hasOwn(dependencies, name) && !selected.has(name)).map(([, name]) => name)
  return { add, remove, keepOff }
}

/** Removes placements other than `current`; links into them are gone once the profile is relinked. */
export async function prunePlacements(dshHome: string, current: string): Promise<void> {
  const root = placementRoot(dshHome)
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    // A placement another process is still copying is left alone.
    if (join(root, entry) !== current && !entry.includes('.incoming-')) await rm(join(root, entry), { recursive: true, force: true })
  }
}

export interface EnsureOptions {
  /** the build folder holding the packages (work/build/main or the app's) */
  built: string
  /** package folders to install as bundles */
  packages: readonly string[]
  /** folder → an updated package's folder, linked instead of the built one (plugin-updates.ts) */
  overrides?: Readonly<Record<string, string>>
  dshHome: string
  /** runs `dsh plugin --profile web <args...>`; rejects on failure */
  plugin: (args: string[]) => Promise<void>
  /** a diagnostics line when linking failed */
  log?: (line: string) => void
}

export interface BundleState {
  /** folders installed in the profile and selected: DSH loads them, their config rows apply */
  selected: Set<string>
  /** folders installed but switched off by the user */
  switchedOff: Set<string>
  /** folders not in the profile at all (linking failed): patched in so Fig keeps working */
  missing: string[]
}

/**
 * Places the packages and links them into the Web profile when this build differs from what the profile links.
 * A package still linked from an earlier placement (linking this build failed) keeps loading from there, on or
 * off as the user left it; only a package the profile lacks altogether is patched in instead.
 */
export async function ensureBundles({ built, packages, overrides = {}, dshHome, plugin, log }: EnsureOptions): Promise<BundleState> {
  let names: Record<string, string>
  const source = (folder: string) => overrides[folder] ?? join(built, folder)
  try {
    names = Object.fromEntries(await Promise.all(packages.map(async folder =>
      [folder, JSON.parse(await readFile(join(source(folder), 'package.json'), 'utf8')).name as string] as const)))
  } catch (error) {
    log?.('Fig plugins could not be read from the build or its updates: ' + errorText(error))
    return { selected: new Set(), switchedOff: new Set(), missing: [...packages] }
  }
  try {
    const placed = packages.filter(folder => !Object.hasOwn(overrides, folder))
    const placement = await placePackages(built, placed, dshHome)
    const sources = Object.fromEntries(packages.map(folder => [folder, overrides[folder] ?? join(placement, folder)]))
    const plan = planBundles(await readWebProfile(dshHome), sources, names, dshHome)
    try {
      if (plan.remove.length) await plugin(['remove', ...plan.remove])
      if (plan.add.length) await plugin(['add', ...plan.add])
    } finally {
      // pnpm may have relinked and reselected packages before failing or being stopped: switch the user's choices back off.
      await deselectBundles(dshHome, plan.keepOff)
    }
    if (plan.add.length || plan.remove.length) await prunePlacements(dshHome, placement)
  } catch (error) {
    log?.('Fig plugins could not be linked into the Web profile: ' + errorText(error))
  }
  const profile = await readWebProfile(dshHome)
  const installed = (folder: string) => Object.hasOwn(profile?.dependencies ?? {}, names[folder])
  const on = (folder: string) => installed(folder) && Boolean(profile?.bundles.includes(names[folder]))
  return {
    selected: new Set(packages.filter(on)),
    switchedOff: new Set(packages.filter(folder => installed(folder) && !on(folder))),
    missing: packages.filter(folder => !installed(folder))
  }
}
