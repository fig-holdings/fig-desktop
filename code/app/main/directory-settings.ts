import { constants, type CopyOptions } from 'node:fs'
import { access, chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeRecord } from '../../harness/shared/atomic-json'
import { readWorkspaceRegistry as readRegistry, WorkspaceFormatError } from '../../harness/shared/workspace-registry'
import { directoryActionPrefix } from '../../harness/shared/page-contract'

export const directoryKinds = ['startup', 'defaultWorkspace', 'dshHome', 'restoreDshHome', 'skillDirectory', 'clearSkillDirectory'] as const
export type DirectoryKind = typeof directoryKinds[number]
export interface DirectoryPreferences { schema: 1; startup?: string; dshHome?: string; previousDshHome?: string }
export interface Directories { startup: string; dshHome: string }
type DirectoryCopy = (source: string, target: string, options: CopyOptions) => Promise<void>

export const copyDirectoryContents: DirectoryCopy = async (source, target, options) => {
  // cp(errorOnExist) also rejects an existing root directory; every child must be new instead.
  for (const entry of await readdir(source)) await cp(join(source, entry), join(target, entry), options)
}

export class DirectoryError extends Error {
  constructor(public code: string) { super(code) }
}
const unavailable = () => new DirectoryError('DIRECTORY_UNAVAILABLE')

/**
 * Only fixed, pathless desktop actions are accepted from the workbench: `<prefix><kind>/<nonce>`, where the
 * nonce is the one main last gave the page (DirectoryNonce). A link in page content cannot know it.
 */
export function directoryAction(value: string): {kind: DirectoryKind; nonce: string} | undefined {
  if (typeof value !== 'string' || !value.startsWith(directoryActionPrefix)) return undefined
  const [kind, nonce, ...rest] = value.slice(directoryActionPrefix.length).split('/')
  const known = directoryKinds.find(item => item === kind)
  return known && rest.length === 0 && /^[a-f0-9]{32}$/.test(nonce ?? '') ? {kind: known, nonce} : undefined
}

/** The one-time nonce Fig's own settings section sends with a directory action; each is accepted once. */
export class DirectoryNonce {
  private current?: string
  issue(): string { return this.current = randomBytes(16).toString('hex') }
  consume(value: unknown): boolean {
    const current = this.current
    if (!current || typeof value !== 'string' || value.length !== current.length || !timingSafeEqual(Buffer.from(value), Buffer.from(current))) return false
    this.current = undefined
    return true
  }
}

export async function existingDirectory(path: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw unavailable()
  try {
    const canonical = await realpath(path)
    if (!(await lstat(canonical)).isDirectory()) throw unavailable()
    await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK)
    return canonical
  } catch { throw unavailable() }
}
function contains(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
}

/** Rebase internal links into the new home; external shared assets keep their existing targets. */
async function rebaseLinks(source: string, target: string, path = ''): Promise<void> {
  const from = join(source, path), to = join(target, path), entry = await lstat(from)
  if (entry.isSymbolicLink()) {
    const original = await readlink(from), resolved = resolve(dirname(from), original)
    const mapped = contains(source, resolved) ? relative(dirname(to), join(target, relative(source, resolved))) || '.' : resolved
    if (!(await lstat(to)).isSymbolicLink() || await readlink(to) !== original) throw new DirectoryError('COPY_VERIFICATION_FAILED')
    if (original !== mapped) { await unlink(to); await symlink(mapped, to) }
  } else if (entry.isDirectory()) {
    for (const name of await readdir(from)) await rebaseLinks(source, target, join(path, name))
  }
}

/** File bytes/permissions and link destinations are verified without following shared external links. */
export async function directoryDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(path: string, name: string) {
    const before = await lstat(path)
    if (before.isSymbolicLink()) {
      const resolved = resolve(dirname(path), await readlink(path))
      hash.update(JSON.stringify([name, 'link', contains(root, resolved) ? ['internal', relative(root, resolved)] : ['external', resolved]]))
      return
    }
    if (!before.isFile() && !before.isDirectory()) throw new DirectoryError('UNSUPPORTED_DATA_FILE')
    hash.update(JSON.stringify([name, before.isDirectory() ? 'directory' : 'file', before.mode & 0o777, before.isFile() ? before.size : null]))
    if (before.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), name ? name + '/' + entry : entry)
    } else {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await file.stat()
        if (before.ino !== opened.ino || before.dev !== opened.dev) throw new DirectoryError('SOURCE_CHANGED')
        for await (const chunk of file.createReadStream({autoClose: false})) hash.update(chunk)
      } finally { await file.close() }
      const after = await lstat(path)
      if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.isSymbolicLink()) throw new DirectoryError('SOURCE_CHANGED')
    }
  }
  await visit(root, '')
  return hash.digest('hex')
}

/** Native preferences stay in Electron userData, outside the DSH home being migrated. */
export class DirectorySettings {
  readonly path: string
  readonly journal: string
  /** The optional extra skill folder Fig registers with DSH (fig-skills). A file of its own, so rolling back to a
   * release that does not know it leaves directory-settings.json readable. */
  readonly skills: string
  constructor(private userData: string, private copy: DirectoryCopy = copyDirectoryContents, private write = writeRecord) {
    this.path = join(userData, 'directory-settings.json')
    this.journal = join(userData, 'directory-migration.json')
    this.skills = join(userData, 'skill-directory.json')
  }
  /** The saved extra skill folder, or undefined when none is set or the file is unreadable (the feature stays off). */
  async readSkillDirectory(): Promise<string | undefined> {
    try {
      const value = JSON.parse(await readFile(this.skills, 'utf8'))
      return value?.schema === 1 && typeof value.path === 'string' && isAbsolute(value.path) ? value.path : undefined
    } catch { return undefined }
  }
  /** Saves a startup folder chosen outside the change flow (first run, or adopting the earlier fixed default). */
  async saveStartup(path: string): Promise<void> {
    await this.write(this.path, {...await this.read(), startup: path})
  }
  async writeSkillDirectory(path: string | undefined): Promise<void> {
    await this.write(this.skills, path === undefined ? {schema: 1} : {schema: 1, path})
  }
  async read(): Promise<DirectoryPreferences> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      if (value?.schema !== 1 || Object.keys(value).some(key => !['schema', 'startup', 'dshHome', 'previousDshHome'].includes(key)) ||
        ['startup', 'dshHome', 'previousDshHome'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || !isAbsolute(value[key])))) throw new Error('schema')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {schema: 1}
      throw new DirectoryError('PREFERENCES_UNREADABLE')
    }
  }
  /** The data directory stays strict. An unavailable startup directory (e.g. an unmounted disk) falls back
   * to the default for this launch and is reported, while the saved choice is left as it is. */
  async load(defaults: Directories): Promise<Directories & {unavailableStartup?: string}> {
    const value = await this.read()
    const startup = value.startup ? await existingDirectory(value.startup).catch(() => undefined) : defaults.startup
    return {
      startup: startup ?? defaults.startup,
      dshHome: value.dshHome ? await existingDirectory(value.dshHome) : defaults.dshHome,
      ...(startup === undefined ? {unavailableStartup: value.startup} : {})
    }
  }
  /** Set an unreadable preferences file aside, kept next to it with a timestamp, so defaults apply. */
  async reset(now = new Date()): Promise<string> {
    const kept = `${this.path}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
    await rename(this.path, kept)
    return kept
  }
  /** An interrupted copy is never selected automatically. Keep its journal for recovery. */
  async recoverNotice(): Promise<boolean> {
    let value
    try { value = JSON.parse(await readFile(this.journal, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new DirectoryError('PREFERENCES_UNREADABLE')
    }
    if (value.status === 'committed') return false
    const preferences = await this.read()
    if (value.status === 'verified' && preferences.dshHome === value.to) {
      await this.write(this.journal, {...value, status: 'committed'})
      return false
    }
    await rename(this.journal, join(this.userData, 'directory-migration-interrupted-' + randomUUID() + '.json'))
    return true
  }
  async validateMigration(sourcePath: string, targetPath: string): Promise<{source: string; target: string}> {
    const source = await existingDirectory(sourcePath), target = await existingDirectory(targetPath)
    if (contains(source, target) || contains(target, source)) throw new DirectoryError('OVERLAPPING_DIRECTORIES')
    if ((await readdir(target)).length) throw new DirectoryError('TARGET_NOT_EMPTY')
    return {source, target}
  }
  /** Caller must first confirm every owned DSH process has stopped. No source data is moved or deleted. */
  async commit(kind: DirectoryKind, targetPath: string, current: Directories, release: string): Promise<void> {
    const value = await this.read()
    const target = await existingDirectory(targetPath)
    if (kind === 'startup') {
      await this.write(this.path, {...value, startup: target})
    } else if (kind === 'skillDirectory') {
      await this.writeSkillDirectory(target)
    } else if (kind === 'defaultWorkspace') {
      await setDefaultWorkspace(current.dshHome, target, release)
    } else if (kind === 'restoreDshHome') {
      if (!value.previousDshHome || target !== await existingDirectory(value.previousDshHome)) throw unavailable()
      await this.write(this.path, {...value, dshHome: target, previousDshHome: current.dshHome})
    } else {
      const {source} = await this.validateMigration(current.dshHome, target)
      const operation = {schema: 1, id: randomUUID(), from: source, to: target}
      await this.write(this.journal, {...operation, status: 'copying'})
      const digest = await directoryDigest(source)
      // The selected empty folder is only a candidate until the final atomic preferences write.
      // A crash/failure leaves the active home and all original bytes intact, plus a recovery journal.
      await chmod(target, (await lstat(source)).mode & 0o777)
      await this.copy(source, target, {recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true})
      await rebaseLinks(source, target)
      if (await directoryDigest(source) !== digest || await directoryDigest(target) !== digest) throw new DirectoryError('COPY_VERIFICATION_FAILED')
      await this.write(this.journal, {...operation, status: 'verified', digest})
      await this.write(this.path, {...value, dshHome: target, previousDshHome: source})
      // A crash here is recovered by recoverNotice using the already-committed preferences.
      await this.write(this.journal, {...operation, status: 'committed', digest}).catch(() => {})
    }
  }
}

/** Read-only check of the release and its v2 registry format (harness/shared/workspace-registry.ts). Safe while
 * the Host runs, so an unsupported format fails before DSH is stopped; the stopped-Host write below checks the file again. */
export async function readWorkspaceRegistry(home: string, release: string) {
  try { return await readRegistry(home, release) } catch (error) {
    throw error instanceof WorkspaceFormatError ? new DirectoryError(error.code) : error
  }
}

/** DSH has no public setter. Apply its v2 registry format only while the Host is stopped. */
export async function setDefaultWorkspace(home: string, target: string, release: string): Promise<void> {
  const {path, raw, value, state, records} = await readWorkspaceRegistry(home, release)
  target = await existingDirectory(target)
  let id = Object.keys(records).find(id => records[id].path === target)
  if (state.defaultWorkspaceId === id && id !== undefined) return
  const backup = join(home, 'fig/directory-backups', randomUUID() + '-workspace.json')
  await mkdir(dirname(backup), {recursive: true})
  await writeFile(backup, raw, {mode: 0o600, flag: 'wx'})
  if (id === undefined) {
    id = randomUUID()
    const now = new Date().toISOString()
    records[id] = {path: target, title: basename(target), sessionIds: [], createdAt: now, updatedAt: now}
    state.workspaceIds = [id, ...state.workspaceIds]
  }
  state.defaultWorkspaceId = id
  await writeRecord(path, value)
}
