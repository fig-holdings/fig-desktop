import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile, writeRecord } from '../../harness/shared/atomic-json.ts'
import { compareVersions, parseVersion } from '../../harness/shared/dsh-range.ts'
import { errorText } from '../../harness/shared/log'
import { checkPackage, pruneUnpacked, reason, unpackSigned } from './external-plugins'
import { readWebProfile } from './web-profile'
import type { TrustedKey } from './profile'

// Plugin updates: one of Fig's feature packages built and signed on its
// own (scripts/plugin-update.mjs pack), placed in <DSH_HOME>/fig/updates/ as `<file>.tgz` with `<file>.tgz.sig.json`.
// The .app keeps a complete set of packages; an update only replaces one of them, and only for the Fig release it was
// built against. A package keeps at most one update: at each start, among the updates of a package that verify against
// the keys built into Fig (harness/plugin-update-keys.json, never the Profile's), name a package Fig ships, were built
// for this Fig release, are newer than the built-in copy and run on this DSH, the newest is kept and the others are
// deleted. It is linked instead of the built-in copy unless it failed to load before; then the built-in copy is used.
// Updates for another Fig release, or not newer than the built-in copy, are stale after an app update and are deleted.

export const updatesRoot = (dshHome: string) => join(dshHome, 'fig', 'updates')
const unpackedRoot = (dshHome: string) => join(updatesRoot(dshHome), 'unpacked')
const recordPath = (dshHome: string) => join(updatesRoot(dshHome), 'state.json')

export interface UpdateRecord {
  /** package name → the update version in use since the last start */
  active: Record<string, string>
  /** `<name>@<version>` → why it failed to load; that version is not used again */
  failed: Record<string, string>
}

export interface UpdateState {
  /** the archive's file name under fig/updates/ */
  archive: string
  name?: string
  version?: string
  /** active: linked instead of the built-in copy; removed: stale or replaced by a newer update, deleted; failed: failed
   * to load before, so the built-in copy is used; rejected: did not verify or does not fit */
  status: 'active' | 'removed' | 'failed' | 'rejected'
  reason?: string
}

export interface UpdateSelection {
  /** package folder → the update's unpacked package folder, for ensureBundles */
  overrides: Record<string, string>
  /** package name → update version in use */
  active: Record<string, string>
  states: UpdateState[]
}

export interface SelectOptions {
  dshHome: string
  /** the build folder holding the built-in packages */
  built: string
  /** the built-in package folders that may be updated */
  packages: readonly string[]
  /** this Fig release (app.getVersion()) */
  appVersion: string
  /** the DSH release Fig starts */
  dshRelease: string
  /** keys built into Fig */
  keys: readonly TrustedKey[]
  log?: (line: string) => void
}

export async function readUpdateRecord(dshHome: string): Promise<UpdateRecord> {
  const value = await readJsonFile(recordPath(dshHome))
  const map = (item: unknown): Record<string, string> => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).filter(([, entry]) => typeof entry === 'string')) as Record<string, string> : {}
  return { active: map(value?.active), failed: map(value?.failed) }
}

/** The archives under fig/updates/, in name order (the newest is chosen by version, not by this order). */
export async function updateArchives(dshHome: string): Promise<string[]> {
  return (await readdir(updatesRoot(dshHome)).catch(() => [] as string[])).filter(file => file.endsWith('.tgz')).sort()
}

const newer = (a: string, b: string) => {
  const x = parseVersion(a), y = parseVersion(b)
  return x !== undefined && y !== undefined && compareVersions(x, y) > 0
}

/** Chooses, per package, the update to link instead of the built-in copy; see the module comment. */
export async function selectUpdates({ dshHome, built, packages, appVersion, dshRelease, keys, log }: SelectOptions): Promise<UpdateSelection> {
  const archives = await updateArchives(dshHome)
  const record = await readUpdateRecord(dshHome)
  const selection: UpdateSelection = { overrides: {}, active: {}, states: [] }
  if (!archives.length) {
    if (Object.keys(record.active).length) await writeRecord(recordPath(dshHome), { active: {}, failed: record.failed })
    return selection
  }
  const builtIn = new Map<string, { folder: string, version: string }>()
  for (const folder of packages) {
    const manifest = await readJsonFile(join(built, folder, 'package.json'))
    if (typeof manifest?.name === 'string' && typeof manifest?.version === 'string') builtIn.set(manifest.name, { folder, version: manifest.version })
  }
  const best = new Map<string, { state: UpdateState, folder: string, remove: (why: string) => Promise<void> }>()
  for (const archive of archives) {
    const path = join(updatesRoot(dshHome), archive)
    const state: UpdateState = { archive, status: 'rejected' }
    selection.states.push(state)
    const remove = async (why: string) => {
      Object.assign(state, { status: 'removed', reason: why })
      log?.(`Plugin update ${archive} deleted: ${why}`)
      await rm(path, { force: true })
      await rm(path + '.sig.json', { force: true })
    }
    try {
      const folder = await unpackSigned(path, keys, dshHome, unpackedRoot(dshHome))
      const { name, version } = await checkPackage(folder, dshRelease, { fig: true })
      Object.assign(state, { name, version })
      const base = (await readJsonFile(join(folder, 'package.json')))?.fig?.base
      const current = builtIn.get(name)
      if (!current) throw new Error(reason(`${name} 不是 Fig 自带的功能插件`, `${name} is not one of Fig's feature packages`))
      if (parseVersion(version) === undefined) throw new Error(reason(`版本号「${version}」无效`, `Invalid version "${version}"`))
      if (base !== appVersion) { await remove(reason(`为 Fig ${base ?? '未知版本'} 构建，当前是 ${appVersion}`, `Built for Fig ${base ?? 'an unknown release'}, this is ${appVersion}`)); continue }
      if (!newer(version, current.version)) { await remove(reason(`不比内置版 ${current.version} 新`, `Not newer than the built-in ${current.version}`)); continue }
      const earlier = best.get(name)
      const replaced = (by: string) => reason(`已被更新的 ${by} 取代`, `Replaced by the newer ${by}`)
      if (earlier && !newer(version, earlier.state.version!)) { await remove(replaced(earlier.state.version!)); continue }
      if (earlier) await earlier.remove(replaced(version))
      const failure = record.failed[`${name}@${version}`]
      Object.assign(state, failure ? { status: 'failed', reason: failure } : { status: 'active' })
      best.set(name, { state, folder, remove })
    } catch (error) {
      if (state.status === 'rejected') state.reason = errorText(error)
    }
    if (state.status === 'rejected') log?.(`Plugin update ${archive} not used: ${state.reason}`)
  }
  for (const [name, { state, folder }] of best) {
    if (state.status !== 'active') continue
    selection.overrides[builtIn.get(name)!.folder] = folder
    selection.active[name] = state.version!
  }
  await writeRecord(recordPath(dshHome), { active: selection.active, failed: record.failed })
  return selection
}

/** Records active updates that failed to load, so the next start uses the built-in copies. Returns the names recorded. */
export async function markUpdatesFailed(dshHome: string, names: readonly string[], why: string): Promise<string[]> {
  const record = await readUpdateRecord(dshHome)
  const failing = names.filter(name => record.active[name])
  if (!failing.length) return []
  const failed = { ...record.failed, ...Object.fromEntries(failing.map(name => [`${name}@${record.active[name]}`, why])) }
  const active = Object.fromEntries(Object.entries(record.active).filter(([name]) => !failing.includes(name)))
  await writeRecord(recordPath(dshHome), { active, failed })
  return failing
}

/**
 * Removes unpacked updates the Web profile no longer links. Runs after the profile is linked (bundles.ts): when linking
 * fails, the profile still points at the earlier folder and that folder must stay.
 */
export async function pruneUpdates(dshHome: string): Promise<void> {
  const linked = Object.values((await readWebProfile(dshHome))?.dependencies ?? {})
    .filter((spec): spec is string => typeof spec === 'string' && spec.startsWith('link:')).map(spec => spec.slice('link:'.length) + '/')
  await pruneUnpacked(unpackedRoot(dshHome), linked)
}
