// The DSH release Fig runs, installed from a committed lockfile (code/dsh-runtime/) instead of npx, so every Mac runs
// the dependency tree Fig verified: npx resolves DSH's own dependencies by range, and they drift after verification.
// Main starts DSH from the installed folder; scripts and tests install and read the same folders.
//
// A release's folder is <root>/<version>-<lock digest>/ with node_modules from `npm ci` and a marker written last.
// It is installed beside itself under a temporary name and renamed into place, so a stopped install leaves no
// half-finished folder behind; another Fig finishing the same install first is fine (its folder is identical).

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { figCacheRoot, figNpmCache } from './npx-cache.js'
import { runOwnedAgent } from './owned-agent.js'

export const dshPackage = '@deepseek-ai/dsh'
const marker = '.fig-dsh-runtime.json'
const releasePattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Where Fig installs locked DSH releases. */
export const dshRuntimeRoot = (home = homedir()) => join(figCacheRoot(home), 'dsh')

/**
 * The release a manifest and lockfile pin, and the lock's digest; throws unless the manifest names exactly one
 * fixed DSH release and the lock installs that release.
 * @param {any} manifest @param {any} lock @returns {{ version: string, digest: string }}
 */
export function lockedRelease(manifest, lock) {
  const wanted = manifest?.dependencies?.[dshPackage]
  if (Object.keys(manifest?.dependencies ?? {}).length !== 1 || typeof wanted !== 'string' || !releasePattern.test(wanted))
    throw new Error('The DSH runtime manifest must depend on exactly one fixed DSH release')
  if (lock?.lockfileVersion !== 3 || lock.packages?.['']?.dependencies?.[dshPackage] !== wanted || lock.packages?.[`node_modules/${dshPackage}`]?.version !== wanted)
    throw new Error(`The DSH runtime lockfile does not install DSH ${wanted}`)
  return { version: wanted, digest: createHash('sha256').update(JSON.stringify(lock)).digest('hex').slice(0, 12) }
}

/** @param {string} root @param {{ version: string, digest: string }} release */
export const runtimeFolder = (root, release) => join(root, `${release.version}-${release.digest}`)

/** The DSH entry in an installed folder, after checking the package there is the expected release. @param {string} folder @param {string} version */
export function runtimeEntry(folder, version) {
  const pkg = JSON.parse(readFileSync(join(folder, 'node_modules', dshPackage, 'package.json'), 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
  if (pkg.name !== dshPackage || pkg.version !== version || typeof bin !== 'string') throw new Error(`Not DSH ${version}: ${folder}`)
  return join(folder, 'node_modules', dshPackage, bin)
}

/** The finished install of `release` under `root`, or undefined. @param {string} root @param {{ version: string, digest: string }} release */
export function installedRuntime(root, release) {
  const folder = runtimeFolder(root, release)
  try {
    const record = JSON.parse(readFileSync(join(folder, marker), 'utf8'))
    if (record.version !== release.version || record.digest !== release.digest) return undefined
    return { folder, entry: runtimeEntry(folder, release.version) }
  } catch { return undefined }
}

/**
 * Installs the locked release once and returns its folder and DSH entry.
 * `ignoreScripts` is for the license inventory only: DSH itself needs its packages' install scripts (node-pty, koffi).
 * @param {{ manifest: any, lock: any, root?: string, node: string, npm: string, env?: NodeJS.ProcessEnv, cache?: string,
 *   ignoreScripts?: boolean, signal?: AbortSignal, onInstall?: () => void }} options
 * @returns {Promise<{ folder: string, entry: string, version: string, installed: boolean }>}
 */
export async function ensureDshRuntime({ manifest, lock, root = dshRuntimeRoot(), node, npm, env = process.env, cache = figNpmCache(),
  ignoreScripts = false, signal, onInstall }) {
  const release = lockedRelease(manifest, lock)
  const done = installedRuntime(root, release)
  if (done) return { ...done, version: release.version, installed: false }
  onInstall?.()
  await mkdir(root, { recursive: true })
  const staging = join(root, `.install-${release.version}-${release.digest}-${randomUUID().slice(0, 8)}`)
  try {
    await mkdir(staging)
    await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(join(staging, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
    const result = await runOwnedAgent({ file: node, nodeExecutable: node, cwd: staging, input: '', signal,
      args: [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--cache', cache, ...ignoreScripts ? ['--ignore-scripts'] : []],
      env: { ...env, npm_config_update_notifier: 'false' } })
    if (result.code !== 0) throw new Error(`npm ci for DSH ${release.version} failed: ${(result.err || result.out).trim().split('\n').slice(-6).join('\n')}`)
    runtimeEntry(staging, release.version)
    await writeFile(join(staging, marker), JSON.stringify({ version: release.version, digest: release.digest, installedAt: new Date().toISOString() }) + '\n')
    const target = runtimeFolder(root, release)
    await rename(staging, target).catch(async error => {
      // Another Fig finished the same lock first; a folder without the marker is a leftover to replace.
      if (installedRuntime(root, release)) return
      if (!existsSync(target)) throw error
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    })
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
  const installed = installedRuntime(root, release)
  if (!installed) throw new Error(`DSH ${release.version} did not install`)
  return { ...installed, version: release.version, installed: true }
}

/**
 * Folders under `root` that can go: finished installs other than the newest `keep` (by install time, always keeping
 * `current`), and stopped installs untouched for `quietMs` (another Fig may still be installing).
 * @param {string} root @param {string} current @param {{ keep?: number, quietMs?: number, now?: number }} [options]
 */
export function staleRuntimes(root, current, { keep = 2, quietMs = 3_600_000, now = Date.now() } = {}) {
  if (!existsSync(root)) return []
  const entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name))
  const finished = entries.filter(folder => !folder.split('/').at(-1)?.startsWith('.') && existsSync(join(folder, marker)))
    .map(folder => ({ folder, at: statSync(join(folder, marker)).mtimeMs })).sort((a, b) => b.at - a.at)
  const kept = new Set([current, ...finished.filter(item => item.folder !== current).slice(0, Math.max(keep - 1, 0)).map(item => item.folder)])
  const stopped = entries.filter(folder => folder.split('/').at(-1)?.startsWith('.install-') && now - statSync(folder).mtimeMs >= quietMs)
  return [...finished.map(item => item.folder).filter(folder => !kept.has(folder)), ...stopped]
}

/** Reads a manifest and lockfile pair from a folder. @param {string} folder */
export async function readRuntimeLock(folder) {
  const [manifest, lock] = await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(join(folder, name), 'utf8').then(JSON.parse)))
  return { manifest, lock }
}
