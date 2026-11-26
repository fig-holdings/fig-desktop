import { createHash, createPublicKey, verify } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { readJsonFile, writeRecord } from '../../harness/shared/atomic-json.ts'
import { satisfies } from '../../harness/shared/dsh-range.ts'
import { errorText } from '../../harness/shared/log'
import type { ExternalPluginState, TeamPluginOff } from '../../harness/shared/profile-contract.ts'
import { deselectBundles, readWebProfile, selectBundles } from './web-profile'
import { groupName, type ExternalPluginEntry, type TrustedKey } from './profile'

// Plugins from outside Fig's build, installed into a Profile through the same path as Fig's own bundles (bundles.ts):
// `dsh plugin --profile web add <folder>` links the folder and selects it. The Profile descriptor (profile.ts) lists
// them. A folder source is linked where it is, so edits apply on the next reload (development); a package source is
// a signed archive, checked and unpacked under <DSH_HOME>/fig/external/<hash>/ first. Every source must be a standard
// DSH plugin bundle whose `engines.dsh` admits the release Fig starts. Nothing here is specific to any one plugin.
//
// A required plugin cannot stay switched off: it is selected again at every start. When one fails to load, the
// startup page stops it for that launch only (`suspend`); the Profile's state then tells the page which features are
// off and why, and the next start tries it again.
//
// Plugin groups: a descriptor entry may name a `group`, and a package may say
// the same in its manifest (`fig: { group, requires }`; Fig Cowork's `figCowork` block is read the same way). Each
// package keeps its own source, signature and version, so one can be updated alone. A group has two
// layers: the base layer (`layer: "base"`, the default) and business plugins (`layer: "business"`, `plugin: "<name>"`,
// several packages each). When a base package fails a check, misses a `requires` range or is suspended, every package of
// the group is stopped for this launch; when a business plugin's package does, only that business plugin stops. Each
// reason names the package that failed. A business plugin the platform paused, the tenant has not subscribed or the tenant
// switched off (`teamPlugins`) is not loaded and says why. Load order is not guaranteed; packages wait for each other through cordis services (ctx.inject).

const externalRoot = (dshHome: string) => join(dshHome, 'fig', 'external')
const recordPath = (dshHome: string) => join(dshHome, 'fig', 'external-plugins.json')

interface InstallRecord {
  /** What this module installed last time: package name → link spec. */
  installed: Record<string, string>
  /** Required plugins stopped for the next launch only, with the reason. */
  suspended: Record<string, string>
}

export interface WorkbenchProviderEntry { id: string, module: string }

/** A selected signed bundle may name its exact Cordis Host entry and file. Directory sources are development only. */
async function workbenchProvider(folder: string): Promise<WorkbenchProviderEntry | undefined> {
  const manifest = await readJsonFile(join(folder, 'package.json'))
  const declaration = manifest?.figDevelopment
  if (declaration?.version !== 1 || typeof declaration.entry !== 'string' || !/^[\w.-]{1,128}$/.test(declaration.entry) ||
    typeof declaration.module !== 'string' || !/^\.\/[\w./-]+\.[cm]?js$/.test(declaration.module)) return undefined
  const root = await realpath(folder)
  const file = await realpath(join(root, declaration.module)).catch(() => undefined)
  return file?.startsWith(root + sep) && await stat(file).then(entry => entry.isFile(), () => false) ? { id: declaration.entry, module: file } : undefined
}

async function readInstallRecord(dshHome: string): Promise<InstallRecord> {
  const value = await readJsonFile(recordPath(dshHome))
  const map = (item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).filter(([, spec]) => typeof spec === 'string')) as Record<string, string> : {}
  return { installed: map(value?.installed), suspended: map(value?.suspended) }
}

/** Fig's own package names and DSH's: an external plugin may not take them. */
const reservedName = (name: string) => name.startsWith('@deepseek-ai/') || /^@local\/dsh-/.test(name)
const packageName = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/

/** A readable reason in both languages for the page and the log. */
export const reason = (zh: string, en: string) => `${zh} / ${en}`

/** Checks that `folder` is a standard DSH plugin bundle that runs on `dshRelease`. Returns its name and version.
 * `fig`: the package is an update of one of Fig's own (plugin-updates.ts), so Fig's names are expected, not refused. */
export interface PackageInfo {
  name: string
  version: string
  description?: string
  group?: string
  /** The business plugin it belongs to; absent for the base layer. */
  plugin?: string
  pluginTitle?: string
  requires: Record<string, string>
}

/** A package's group membership: a package that names a plugin without a layer is in the business layer. */
function membershipOf(manifest: any): { group?: string, layer: unknown, plugin: unknown, title: string } {
  const membership = manifest?.fig ?? manifest?.figCowork
  return { group: typeof membership?.group === 'string' ? membership.group : undefined,
    layer: membership?.layer ?? (membership?.plugin === undefined ? 'base' : 'business'), plugin: membership?.plugin,
    title: typeof membership?.pluginTitle === 'string' ? membership.pluginTitle.trim().slice(0, 64) : '' }
}

export async function checkPackage(folder: string, dshRelease: string, { fig = false } = {}): Promise<PackageInfo> {
  // DSH's package handling trips on spaces in a linked path (bundles.ts places Fig's own packages for the same reason).
  if (/\s/.test(folder)) throw new Error(reason('插件目录路径不能包含空格', 'The plugin folder path must not contain spaces'))
  const manifest = await readJsonFile(join(folder, 'package.json'))
  if (!manifest) throw new Error(reason('缺少可读的 package.json', 'No readable package.json'))
  const { name, version } = manifest
  if (typeof name !== 'string' || !packageName.test(name)) throw new Error(reason('package.json 的 name 无效', 'Invalid package name'))
  if (!fig && reservedName(name)) throw new Error(reason(`包名 ${name} 属于 Fig 或 DSH，外部插件不能使用`, `The name ${name} belongs to Fig or DSH`))
  if (typeof version !== 'string') throw new Error(reason('package.json 缺少 version', 'package.json has no version'))
  const patch = manifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !await stat(join(folder, patch)).then(item => item.isFile(), () => false))
    throw new Error(reason('不是 DSH 插件包：缺少 dsh.bundle.patch 指向的文件', 'Not a DSH plugin bundle: dsh.bundle.patch is missing'))
  const range = manifest?.engines?.dsh
  if (typeof range !== 'string') throw new Error(reason('package.json 未声明 engines.dsh', 'package.json declares no engines.dsh'))
  const fits = satisfies(dshRelease, range)
  if (fits === undefined) throw new Error(reason(`无法识别 engines.dsh 范围「${range}」`, `Unreadable engines.dsh range "${range}"`))
  if (!fits) throw new Error(reason(`engines.dsh「${range}」不包含 Fig 使用的 DSH ${dshRelease}`, `engines.dsh "${range}" excludes DSH ${dshRelease}, which Fig runs`))
  const membership = manifest.fig ?? manifest.figCowork
  const { group, layer, plugin: named, title } = membershipOf(manifest)
  const requires = membership?.requires && typeof membership.requires === 'object' && !Array.isArray(membership.requires)
    ? Object.fromEntries(Object.entries(membership.requires).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {}
  if (group && layer !== 'base' && layer !== 'business') throw new Error(reason(`无法识别插件层「${layer}」`, `Unknown plugin layer "${layer}"`))
  const plugin = (group && layer === 'business' ? named : undefined) as string | undefined
  if (group && layer === 'business' && (typeof plugin !== 'string' || !groupName.test(plugin)))
    throw new Error(reason('业务插件的包缺少有效的 plugin 名', 'A business plugin package needs a valid plugin name'))
  if (group && layer === 'base' && named !== undefined)
    throw new Error(reason('基础能力的包不能声明 plugin', 'A base layer package cannot name a plugin'))
  const description = typeof manifest.description === 'string' ? manifest.description.trim().slice(0, 200) : ''
  return { name, version, ...description ? { description } : {}, group, ...plugin ? { plugin, ...title ? { pluginTitle: title } : {} } : {}, requires }
}

/** A package archive's detached signature, `<archive>.sig.json`. */
export interface PackageSignature {
  keyId: string
  algorithm: 'ed25519'
  /** sha256 of the archive, hex. */
  sha256: string
  /** Ed25519 signature over the archive bytes, base64. */
  signature: string
}

/** Verifies an archive against its signature and the given keys (a Profile's trusted keys, or Fig's built-in update keys); returns its sha256. */
export function verifyArchive(archive: Buffer, signature: any, keys: readonly TrustedKey[]): string {
  const digest = createHash('sha256').update(archive).digest('hex')
  if (signature?.algorithm !== 'ed25519' || typeof signature?.signature !== 'string' || typeof signature?.keyId !== 'string')
    throw new Error(reason('签名文件格式无效', 'Invalid signature file'))
  if (signature.sha256 !== digest) throw new Error(reason('插件包内容哈希与签名不符', 'The package hash does not match its signature'))
  const key = keys.find(item => item.id === signature.keyId)
  if (!key) throw new Error(reason(`签名密钥 ${signature.keyId} 不在受信任列表中`, `Signing key ${signature.keyId} is not trusted`))
  let valid = false
  try {
    valid = verify(null, archive, createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature.signature, 'base64'))
  } catch { valid = false }
  if (!valid) throw new Error(reason('插件包签名校验失败', 'The package signature does not verify'))
  return digest
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // bsdtar refuses `..` members and strips leading slashes by default; the archive is already verified.
    const child = spawn('tar', ['-xzf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', chunk => { error += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(reason('插件包无法解压', 'The package could not be unpacked') + ': ' + error.slice(-200))))
  })
}

/** Verifies and unpacks a signed package once, under `<root>/<hash>/` (by default <DSH_HOME>/fig/external/); returns its
 * package folder. */
export async function unpackSigned(archivePath: string, keys: readonly TrustedKey[], dshHome: string, root = externalRoot(dshHome)): Promise<string> {
  const archive = await readFile(archivePath).catch(() => { throw new Error(reason('找不到插件包文件', 'The package file was not found')) })
  const signature = await readJsonFile(archivePath + '.sig.json')
  if (!signature) throw new Error(reason('缺少签名文件 <插件包>.sig.json', 'No <package>.sig.json signature'))
  const digest = verifyArchive(archive, signature, keys)
  const target = join(root, digest.slice(0, 16))
  // npm pack places the package under package/.
  const folder = join(target, 'package')
  if (await stat(folder).then(() => true, () => false)) return folder
  const incoming = target + '.incoming-' + process.pid
  await rm(incoming, { recursive: true, force: true })
  await mkdir(incoming, { recursive: true })
  try {
    await untar(archivePath, incoming)
    if (!await stat(join(incoming, 'package')).then(item => item.isDirectory(), () => false))
      throw new Error(reason('插件包应按 npm pack 格式，内容位于 package/ 下', 'The archive must be npm pack output, with its files under package/'))
    await rename(incoming, target)
  } catch (error) {
    await rm(incoming, { recursive: true, force: true })
    throw error
  }
  return folder
}

export interface ExternalOptions {
  entries: readonly ExternalPluginEntry[]
  trustedKeys: readonly TrustedKey[]
  dshHome: string
  /** The DSH release Fig starts; `engines.dsh` must admit it. */
  dshRelease: string
  /** Runs `dsh plugin --profile web <args...>`; rejects on failure. */
  plugin: (args: string[]) => Promise<void>
  /** The organization's unavailable business plugins (team Profiles): not loaded, with the cause. */
  teamPlugins?: Readonly<Record<string, TeamPluginOff>>
  log?: (line: string) => void
}

/** The business plugin a package's manifest names, for a package that failed a check; only within the entry's group. */
async function businessOf(folder: string, group?: string): Promise<{ group: string, name?: string, plugin: string, pluginTitle?: string } | undefined> {
  const manifest = await readJsonFile(join(folder, 'package.json'))
  const membership = membershipOf(manifest)
  if (!membership.group || (group && membership.group !== group)) return undefined
  if (membership.layer !== 'business' || typeof membership.plugin !== 'string' || !groupName.test(membership.plugin)) return undefined
  return { group: membership.group, ...typeof manifest.name === 'string' && packageName.test(manifest.name) ? { name: manifest.name } : {},
    plugin: membership.plugin, ...membership.title ? { pluginTitle: membership.title } : {} }
}

/** Why a business plugin is not loaded, in both languages. */
export function unavailableText(title: string, off: TeamPluginOff): string {
  if (off.off === 'platform') {
    const [zh, en] = off.platformOff?.kind === 'fault' ? ['故障', 'a fault'] : off.platformOff?.kind === 'security' ? ['安全问题', 'a security issue'] : ['平台原因', 'the platform']
    const why = off.platformOff?.reason
    return reason(`平台因${zh}暂停了业务插件 ${title}${why ? '：' + why : ''}`, `The platform paused the business plugin ${title} for ${en}${why ? ': ' + why : ''}`)
  }
  if (off.off === 'unsubscribed') return reason(`未订阅业务插件 ${title}，请租户管理员订阅`, `The business plugin ${title} is not subscribed; ask your tenant admin to subscribe`)
  return reason(`组织未启用业务插件 ${title}`, `Your organization has not enabled the business plugin ${title}`)
}

/** What stops together: the whole group for its base layer, `<group>/<plugin>` for a business plugin. */
const unitOf = (state: Pick<ExternalPluginState, 'group' | 'plugin'>) => state.group ? state.plugin ? `${state.group}/${state.plugin}` : state.group : undefined

/** Installs, updates and removes the Profile's external plugins; returns each one's state for this launch. */
export async function ensureExternalPlugins({ entries, trustedKeys, dshHome, dshRelease, plugin, teamPlugins = {}, log, onWorkbenchProvider }: ExternalOptions & {
  onWorkbenchProvider?: (entry: WorkbenchProviderEntry) => void
}): Promise<ExternalPluginState[]> {
  const record = await readInstallRecord(dshHome)
  // Nothing listed and nothing installed before: leave the Profile and the record untouched.
  if (!entries.length && !Object.keys(record.installed).length) return []
  const states: ExternalPluginState[] = []
  const wanted = new Map<string, { folder: string, required: boolean, requires: Record<string, string>, state: ExternalPluginState }>()
  for (const entry of entries) {
    const state: ExternalPluginState = { source: entry.source.kind, origin: entry.source.kind === 'directory' ? entry.source.path : basename(entry.source.path),
      required: entry.required, status: 'failed', ...entry.group ? { group: entry.group } : {}, ...entry.group && entry.plugin ? { plugin: entry.plugin } : {} }
    states.push(state)
    let folder: string | undefined
    try {
      folder = entry.source.kind === 'directory' ? entry.source.path : await unpackSigned(entry.source.path, trustedKeys, dshHome)
      const { name, version, description, group, plugin: business, pluginTitle, requires } = await checkPackage(folder, dshRelease)
      Object.assign(state, { name, version }, description ? { description } : {})
      if (group && entry.group && group !== entry.group)
        throw new Error(reason(`包声明的插件组 ${group} 与描述文件的 ${entry.group} 不一致`, `The package's group ${group} differs from the descriptor's ${entry.group}`))
      if (group) state.group = group
      if (group && entry.plugin && business !== entry.plugin)
        throw new Error(reason(`包声明的业务插件 ${business ?? '（基础能力）'} 与描述文件的 ${entry.plugin} 不一致`, `The package's business plugin ${business ?? '(base layer)'} differs from the descriptor's ${entry.plugin}`))
      if (business) Object.assign(state, { plugin: business }, pluginTitle ? { pluginTitle } : {})
      else if (group) delete state.plugin
      if (wanted.has(name)) throw new Error(reason(`与另一个来源的 ${name} 重名`, `Another source already provides ${name}`))
      wanted.set(name, { folder, required: entry.required, requires, state })
    } catch (error) {
      state.reason = errorText(error)
      // A verified package that fails a later check (engines.dsh, bundle) still says which business plugin it belongs
      // to: read that from its manifest so only that plugin stops, as when the descriptor names it.
      if (folder && !state.plugin) await businessOf(folder, entry.group).then(found => { if (found) Object.assign(state, found) }, () => undefined)
      log?.(`External plugin ${state.origin} not installed: ${state.reason}`)
    }
  }

  // A package whose `requires` are not met fails like any other check. Removing one can break another that needs it,
  // so the check repeats until nothing more is removed.
  for (let removed = true; removed;) {
    removed = false
    for (const [name, item] of [...wanted]) {
      const unmet = Object.entries(item.requires).find(([dependency, range]) => {
        const version = wanted.get(dependency)?.state.version
        return !version || satisfies(version, range) !== true
      })
      if (!unmet) continue
      const [dependency, range] = unmet, found = wanted.get(dependency)?.state.version
      item.state.reason = found ? reason(`需要 ${dependency} ${range}，当前是 ${found}`, `Needs ${dependency} ${range}; found ${found}`)
        : reason(`需要 ${dependency} ${range}，但它没有装入`, `Needs ${dependency} ${range}, which is not installed`)
      log?.(`External plugin ${name} not installed: ${item.state.reason}`)
      wanted.delete(name)
      removed = true
    }
  }
  // The first failed or suspended package stops its unit for this launch: the whole group when it is a base package,
  // its business plugin otherwise. A business plugin the organization switched off is not loaded (`disabled`).
  const culprit = new Map<string, { name: string, why: string }>()
  for (const state of states) {
    const unit = unitOf(state)
    if (unit && state.status === 'failed' && state.reason && !(state.name && wanted.has(state.name)) && !culprit.has(unit))
      culprit.set(unit, { name: state.name ?? state.origin, why: state.reason })
  }
  for (const [name, why] of Object.entries(record.suspended)) {
    const item = wanted.get(name), unit = item && unitOf(item.state)
    if (unit && item.required && !culprit.has(unit)) culprit.set(unit, { name, why })
  }
  const groupStopped = (state: ExternalPluginState) => state.group
    ? culprit.get(state.group) ?? (state.plugin ? culprit.get(`${state.group}/${state.plugin}`) : undefined) : undefined
  const switchedOff = (state: ExternalPluginState) => state.group && state.plugin ? teamPlugins[state.plugin] : undefined
  const stoppedText = (state: ExternalPluginState, stop: { name: string, why: string }) => {
    // A reason is usually 「中文 / English」 (reason()); each language half takes its own.
    const [zh, en = zh] = stop.why.split(' / ')
    const base = culprit.get(state.group!) === stop
    if (base) return reason(`插件组 ${state.group} 已停用：${stop.name} 未通过（${zh}）`, `Plugin group ${state.group} is off: ${stop.name} failed (${en})`)
    const title = state.pluginTitle ?? state.plugin
    return reason(`业务插件 ${title} 已停用：${stop.name} 未通过（${zh}）`, `Business plugin ${title} is off: ${stop.name} failed (${en})`)
  }
  // A package that failed before its manifest was read lacks the title its siblings declare.
  const titles = new Map(states.filter(state => state.plugin && state.pluginTitle).map(state => [unitOf(state), state.pluginTitle!]))
  for (const state of states) if (state.plugin && !state.pluginTitle && titles.has(unitOf(state))) state.pluginTitle = titles.get(unitOf(state))
  for (const state of states) {
    const stop = groupStopped(state)
    if (stop && (state.name !== stop.name || state.status === 'failed')) state.reason = stoppedText(state, stop)
  }
  const stoppedNames = [...wanted].filter(([, item]) => groupStopped(item.state) || switchedOff(item.state)).map(([name]) => name)

  const before = await readWebProfile(dshHome)
  const dependencies = before?.dependencies ?? {}
  const selected = new Set(before?.bundles ?? [])
  // Only what this module installed earlier is removed; a plugin the user added on the Plugins page is theirs.
  const remove = Object.entries(record.installed).filter(([name, spec]) => !wanted.has(name) && dependencies[name] === spec).map(([name]) => name)
  const add = [...wanted.values()].filter(item => dependencies[item.state.name!] !== `link:${item.folder}`)
  // An optional plugin the user switched off stays off after it is linked again.
  const keepOff = [...wanted.values()].filter(item => !item.required && Object.hasOwn(dependencies, item.state.name!) && !selected.has(item.state.name!)).map(item => item.state.name!)
  const required = [...wanted.values()].filter(item => item.required && !groupStopped(item.state) && !switchedOff(item.state)).map(item => item.state.name!)
  try {
    if (remove.length) await plugin(['remove', ...remove])
    if (add.length) await plugin(['add', ...add.map(item => item.folder)])
  } catch (error) {
    log?.('External plugins could not be linked: ' + errorText(error))
  } finally {
    await deselectBundles(dshHome, keepOff).catch(() => [])
    await selectBundles(dshHome, required).catch(() => [])
  }
  const suspend = [...new Set([...Object.keys(record.suspended).filter(name => wanted.get(name)?.required), ...stoppedNames])]
  if (suspend.length) await deselectBundles(dshHome, suspend).catch(() => [])

  const after = await readWebProfile(dshHome)
  const installed: Record<string, string> = {}
  for (const [name, item] of wanted) {
    const linked = after?.dependencies[name] === `link:${item.folder}`
    if (linked) installed[name] = `link:${item.folder}`
    const stop = groupStopped(item.state)
    if (!linked) item.state.reason = reason('未能装入 Profile，详见启动诊断', 'Could not be linked into the Profile; see the startup diagnostics')
    else if (stop) Object.assign(item.state, { status: record.suspended[stop.name] ? 'suspended' : 'failed' })
    else if (switchedOff(item.state)) {
      const off = switchedOff(item.state)!
      Object.assign(item.state, { status: 'disabled', unavailable: off, reason: unavailableText(item.state.pluginTitle ?? item.state.plugin!, off) })
    }
    else if (record.suspended[name] && item.required) Object.assign(item.state, { status: 'suspended', reason: record.suspended[name] })
    else item.state.status = after?.bundles.includes(name) ? 'ready' : 'off'
    if (onWorkbenchProvider && item.state.status === 'ready' && item.state.source === 'package') {
      const provider = await workbenchProvider(item.folder)
      if (provider) onWorkbenchProvider(provider)
    }
  }
  // Suspension lasts one launch; installed names are remembered so a later removal from the descriptor uninstalls them.
  await writeRecord(recordPath(dshHome), { installed, suspended: {} })
  await pruneUnpacked(externalRoot(dshHome), [...wanted.values()].map(item => item.folder))
  return states
}

/** Stops required plugins that failed to load, for the next launch only, keeping the reason to show. */
export async function suspendRequired(dshHome: string, reasons: Record<string, string>): Promise<void> {
  const record = await readInstallRecord(dshHome)
  await writeRecord(recordPath(dshHome), { ...record, suspended: { ...record.suspended, ...reasons } })
}

/** Removes the unpacked packages under `root` that no path in `inUse` lies inside; half-unpacked ones are left alone. */
export async function pruneUnpacked(root: string, inUse: readonly string[]): Promise<void> {
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    const folder = join(root, entry)
    if (!entry.includes('.incoming-') && !inUse.some(path => path.startsWith(folder + '/'))) await rm(folder, { recursive: true, force: true })
  }
}
