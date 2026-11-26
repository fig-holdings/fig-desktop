import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { readJsonFile, writeRecord } from '../../harness/shared/atomic-json.ts'
import { activityLayoutKeys, groupName, profileShellDefaults, teamPluginPolicy, type Edition, type ShellProfile, type ActivityLayout, type TeamPluginOff } from '../../harness/shared/profile-contract.ts'
import { teamModels, type TeamModels } from '../../harness/shared/team-models.ts'

// A Profile is one DSH data folder (DSH_HOME) and what Fig makes of it: which edition it is, how the shell around
// DSH looks (shell configuration, not something a plugin changes), and which plugins from outside Fig's build are
// installed into it (external-plugins.ts). The descriptor lives with the data, at <DSH_HOME>/fig/profile.json, and
// is written by whoever creates the Profile: the user for a personal one (or nobody: no file means personal with
// the default look), the edition switch for a team one, and `npm run dev:isolated -- --plugin/--edition` for testing.
// The types below and harness/shared/profile-contract.ts are the contract; keep them backward compatible.

/** Where an external plugin comes from. */
export type PluginSource =
  /** A package folder, linked as it is: edits apply on the next reload. Development only. */
  | { kind: 'directory', path: string }
  /** A signed package archive (`.tgz` plus `<file>.sig.json`), checked and unpacked before it is installed. */
  | { kind: 'package', path: string }

export interface ExternalPluginEntry {
  source: PluginSource
  /** A required plugin cannot be switched off; when it is missing or fails, the features it provides stop, with the reason shown. */
  required: boolean
  /** A plugin group: its packages are signed and versioned one by one, but
   * run together; when a base layer package fails, the whole group stops and the reason names that package (a business
   * package stops only its own business plugin). */
  group?: string
  /** The group's business plugin this package belongs to; absent: the group's base layer. Named here
   * as well as in the package so a package that fails before its manifest is read stops only its own business plugin. */
  plugin?: string
}

export interface TrustedKey {
  /** Named by a package signature's `keyId`. */
  id: string
  /** Ed25519 public key, base64 DER (SPKI). */
  publicKey: string
}

export interface ProfileDescriptor {
  schema: 1
  /** Stable id of this Profile; created once and kept. */
  id: string
  edition: Edition
  shell: ShellProfile
  plugins: ExternalPluginEntry[]
  trustedKeys: TrustedKey[]
  /** The Cowork origin a team Profile belongs to: the only site `shellCapabilities.openExternal` opens. */
  coworkOrigin?: string
  teamModels?: TeamModels
  /** The organization's unavailable business plugins (team only; Cowork's `/api/desktop/session` `plugins`, read by
   * teamPluginPolicy). One listed is not loaded; one missing is on. */
  teamPlugins?: Record<string, TeamPluginOff>
  /** profile.json exists but is not valid JSON: it is left as written, and its plugins are not touched this launch. */
  unreadable?: boolean
}

/** Development-only overrides from `npm run dev:isolated -- --plugin <dir> --edition team` (scripts/run-desktop.mjs). */
export interface DevOverrides {
  edition?: Edition
  directories: string[]
}

export const descriptorPath = (dshHome: string) => join(dshHome, 'fig', 'profile.json')

export { groupName }

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined

function readShell(value: any): ShellProfile {
  const defaults = profileShellDefaults()
  return {
    pluginMenuActions: typeof value?.pluginMenuActions === 'boolean' ? value.pluginMenuActions : defaults.pluginMenuActions,
    pinnedPanels: strings(value?.pinnedPanels) ?? defaults.pinnedPanels,
    // Each part missing or not a boolean stays on.
    activity: Object.fromEntries(activityLayoutKeys.map(key => [key, typeof value?.activity?.[key] === 'boolean' ? value.activity[key] : true])) as unknown as ActivityLayout
  }
}

function readSource(value: any): PluginSource | undefined {
  if (typeof value === 'string' && isAbsolute(value)) return { kind: 'directory', path: value }
  if ((value?.kind === 'directory' || value?.kind === 'package') && typeof value.path === 'string' && isAbsolute(value.path))
    return { kind: value.kind, path: value.path }
  return undefined
}

function readOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    // https only, except a loopback Cowork during development.
    const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    return (url.protocol === 'https:' || loopback) && !url.username && !url.password ? url.origin : undefined
  } catch { return undefined }
}

/** The descriptor's contents as Fig uses them; anything unreadable falls back to the edition's defaults. */
export function parseDescriptor(value: any, id: string): ProfileDescriptor {
  const edition: Edition = value?.edition === 'team' ? 'team' : 'personal'
  const plugins = Array.isArray(value?.plugins) ? value.plugins.flatMap((item: any) => {
    const source = readSource(item?.source ?? item)
    const group = typeof item?.group === 'string' && groupName.test(item.group) ? item.group : undefined
    const plugin = group && typeof item?.plugin === 'string' && groupName.test(item.plugin) ? item.plugin : undefined
    return source ? [{ source, required: item?.required === true, ...group ? { group } : {}, ...plugin ? { plugin } : {} }] : []
  }) : []
  const trustedKeys = Array.isArray(value?.trustedKeys) ? value.trustedKeys.filter((key: any) =>
    typeof key?.id === 'string' && /^[\w.-]{1,64}$/.test(key.id) && typeof key?.publicKey === 'string') : []
  return { schema: 1, id, edition, shell: readShell(value?.shell), plugins, trustedKeys,
    coworkOrigin: readOrigin(value?.coworkOrigin), ...(edition === 'team' ? { teamModels: teamModels(value?.teamModels), teamPlugins: teamPluginPolicy(value?.teamPlugins) } : {}) }
}


/**
 * Reads this Profile's descriptor, giving it an id the first time. Development overrides replace the edition and add
 * directory sources (required in a team Profile, as a team plugin would be).
 */
export async function loadProfile(dshHome: string, dev?: DevOverrides): Promise<ProfileDescriptor> {
  const path = descriptorPath(dshHome)
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : '')
  let stored: any
  try { stored = raw === undefined ? undefined : JSON.parse(raw) } catch {
    // A hand edit gone wrong (say, a trailing comma) must not cost the team its descriptor: keep the file for repair,
    // run this launch as a personal Profile with a passing id, and leave the installed plugins alone.
    return { ...parseDescriptor(undefined, randomUUID()), unreadable: true }
  }
  let id = typeof stored?.id === 'string' && /^[\w-]{8,64}$/.test(stored.id) ? stored.id : undefined
  if (!id) {
    id = randomUUID()
    // Only the id is added; whatever else the file holds is kept as written.
    await writeRecord(path, { ...stored && typeof stored === 'object' ? stored : { schema: 1 }, id }).catch(() => undefined)
  }
  const merged = dev ? { ...stored, edition: dev.edition ?? stored?.edition,
    // An edition chosen on the command line takes that edition's default look, not the file's.
    shell: dev.edition ? undefined : stored?.shell } : stored
  const descriptor = parseDescriptor(merged, id)
  if (dev?.directories.length) {
    const known = new Set(descriptor.plugins.map(item => item.source.path))
    for (const path of dev.directories) if (!known.has(path))
      descriptor.plugins.push({ source: { kind: 'directory', path }, required: descriptor.edition === 'team' })
  }
  return descriptor
}

/** Reads `FIG_DESKTOP_DEV_PLUGINS` (absolute folders, `path.delimiter`-separated) and `FIG_DESKTOP_DEV_EDITION`. */
export function devOverrides(environment: NodeJS.ProcessEnv, delimiter: string): DevOverrides | undefined {
  const directories = (environment.FIG_DESKTOP_DEV_PLUGINS ?? '').split(delimiter).filter(path => path && isAbsolute(path))
  const edition = environment.FIG_DESKTOP_DEV_EDITION === 'team' ? 'team' : environment.FIG_DESKTOP_DEV_EDITION === 'personal' ? 'personal' : undefined
  return directories.length || edition ? { edition, directories } : undefined
}

/** Counts DSH starts in this Profile, persisted, so every report a team plugin makes can name the DSH run it came from. */
export async function nextGeneration(dshHome: string): Promise<number> {
  const path = join(dshHome, 'fig', 'dsh-generation.json')
  const current = await readJsonFile(path)
  const next = (Number.isSafeInteger(current?.generation) && current.generation >= 0 ? current.generation : 0) + 1
  await writeRecord(path, { generation: next })
  return next
}
