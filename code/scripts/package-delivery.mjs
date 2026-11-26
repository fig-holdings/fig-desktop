import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, rename, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acceptPackage } from './package-acceptance.mjs'
import { verifySignature } from './macos-bundle.mjs'

// Packages the trial and swaps it in at the fixed outputs/Fig Desktop.app right away. A Fig running from that path keeps
// running the version it started with and takes the new one at its next launch: macOS keeps a moved bundle's loaded code,
// and the app itself refuses to start DSH again from a replaced bundle (app/main/bundle-replacement.ts).
// Measured before adopting this: work/verification/hot-swap/.

const bundleName = 'Fig Desktop.app'
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
const bundleVersion = async bundle => JSON.parse(await readFile(join(bundle, 'Contents/Resources/app/package.json'), 'utf8')).version
const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true })

/**
 * Archives the current bundle and moves the candidate into its place: two renames in one folder. If the second fails,
 * the first is undone. Never deletes or overwrites.
 */
export async function swapInPlace({ destination, candidate, archive }, move = rename) {
  if (await exists(archive)) throw new Error('Archive destination already exists: ' + archive)
  const hadOld = await exists(destination)
  if (hadOld) await move(destination, archive)
  try {
    await move(candidate, destination)
  } catch (error) {
    if (hadOld && !await exists(destination)) await move(archive, destination)
    throw error
  }
}

/**
 * Keeps the newest `keep` version folders of outputs that hold a bundle and moves older ones to the Trash with the
 * system's own command (renaming into ~/.Trash fails inside the iCloud-synced Workspace). Returns what it trashed.
 */
export async function retain(outputs, keep = 2, trash = paths => execFileSync('/usr/bin/trash', paths, { stdio: 'pipe' })) {
  const versions = []
  for (const entry of await readdir(outputs, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d+\.\d+\.\d+(?:-[\w-]+)?$/.test(entry.name) && await exists(join(outputs, entry.name, bundleName))) versions.push(entry.name)
  }
  const old = versions.sort((a, b) => byVersion(b, a)).slice(keep)
  if (old.length) trash(old.map(name => join(outputs, name)))
  return old
}

/**
 * Source checks, a signed bundle in outputs/.staging, acceptance of that exact bundle, then the swap and retention.
 * @param {string} code @param {(command: string, args: string[]) => Promise<boolean>} step
 */
export async function deliverPackage(code, step, { rebuild = false } = {}) {
  const root = resolve(code, '..'), outputs = join(root, 'outputs')
  const destination = join(outputs, bundleName)
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const lock = join(outputs, '.staging', 'lock')
  await mkdir(join(outputs, '.staging'), { recursive: true })
  // One packaging run at a time; a lock left by a crashed run is removed by hand after a look.
  try { await mkdir(lock) } catch { throw new Error('Another packaging run holds ' + lock) }
  try {
    const { version } = JSON.parse(await readFile(join(code, 'package.json'), 'utf8'))
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid trial version')
    const oldVersion = await exists(destination) ? await bundleVersion(destination) : undefined
    if (oldVersion && (byVersion(version, oldVersion) < 0 || (version === oldVersion && !rebuild))) throw new Error('Increment package.json and package-lock.json first; a same-version rebuild needs --rebuild')
    const archive = join(outputs, (oldVersion ?? '0.0.0') + (version === oldVersion ? '-rebuild-' + id : ''), bundleName)
    if (await exists(archive)) throw new Error('Historical bundle exists; refusing overwrite: ' + archive)
    const staging = join(outputs, '.staging', id)
    if (!await step('npm', ['run', 'check'])) throw new Error('Source checks failed')
    if (!await step('node', ['scripts/package-mac.mjs', '--staging=' + staging])) throw new Error('Packaging failed')
    const candidate = join(staging, bundleName)
    await acceptPackage(candidate, join(root, 'work/build'), join(root, 'work/verification', 'package-' + version + '-' + id))
    // Only an existing bundle is archived; a first package leaves no empty version folder.
    if (await exists(destination)) await mkdir(resolve(archive, '..'), { recursive: true })
    await swapInPlace({ destination, candidate, archive }).catch(async error => { await rmdir(resolve(archive, '..')).catch(() => {}); throw error })
    verifySignature(destination, false)
    await rmdir(staging)
    let trashed = []
    try { trashed = await retain(outputs) } catch (error) { console.warn('Retention postponed: ' + (error instanceof Error ? error.message : String(error))) }
    console.log(`Installed ${version} at ${destination}` + (oldVersion ? `; ${oldVersion} archived.` : '.')
      + (trashed.length ? ` Moved to the Trash: ${trashed.join(', ')}.` : '')
      + '\nA Fig already running keeps its version until it is quit and opened again.')
  } finally {
    await rmdir(lock)
  }
}
