import electronExecutable from 'electron'
import { readFile, writeFile, mkdir, cp, rename, readdir, stat, rm } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { figCacheRoot } from '../harness/shared/npx-cache.js'
import { adHocSign, clearAttributes, helperApps, setPlist, verifySignature } from './macos-bundle.mjs'
// In Node the electron package exports the path to its executable; its types describe the Electron API.
const electronPath = /** @type {string} */ (/** @type {unknown} */ (electronExecutable))

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(code, '..')
const product = 'Fig Desktop'
const bundleId = 'local.fig.desktop.dev'

/** A separate, reproducible development host; never edit the installed Electron dependency. */
export async function prepareDevRuntime() {
  if (process.platform !== 'darwin') return electronPath
  const pkg = JSON.parse(await readFile(join(code, 'package.json'), 'utf8'))
  const electronPackage = JSON.parse(await readFile(join(code, 'node_modules/electron/package.json'), 'utf8'))
  const icon = join(root, 'assets/brand/app-icon.icns')
  const identity = { revision: 1, product, bundleId, version: pkg.version, electron: electronPackage.version,
    iconSha256: createHash('sha256').update(await readFile(icon)).digest('hex') }
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12)
  // FIG_DEV_RUNTIME_DIR moves the cache, e.g. for a sandboxed agent that cannot write
  // ~/Library/Caches. An unwritable default falls back to work/dev-runtime too.
  const projectCache = join(root, 'work/dev-runtime')
  const bases = process.env.FIG_DEV_RUNTIME_DIR
    ? [resolve(process.env.FIG_DEV_RUNTIME_DIR)]
    : [join(figCacheRoot(), 'dev-runtime'), projectCache]
  for (const base of bases) {
    const executable = join(base, key, `${product}.app`, 'Contents/MacOS', product)
    try {
      if (JSON.stringify(JSON.parse(await readFile(join(base, key, 'identity.json'), 'utf8'))) === JSON.stringify(identity)) {
        await stat(executable)
        return executable
      }
    } catch { /* Not prepared here yet. */ }
  }
  let output = '' // set by the loop below, which throws when no base is writable
  for (const base of bases) {
    try {
      await mkdir(join(base, key), { recursive: true })
      output = join(base, key)
      break
    } catch (/** @type {any} */ error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES' || base === bases.at(-1)) throw error
    }
  }
  const bundle = join(output, `${product}.app`)
  const executable = join(bundle, 'Contents/MacOS', product)
  const staging = join(output, `preparing-${process.pid}.app`)
  const original = resolve(dirname(electronPath), '../..')
  try {
    await cp(original, staging, { recursive: true, verbatimSymlinks: true })
    const contents = join(staging, 'Contents')
    const info = join(contents, 'Info.plist')
    setPlist(info, { CFBundleName: product, CFBundleDisplayName: product,
      CFBundleIdentifier: bundleId, CFBundleExecutable: product, CFBundleIconFile: 'fig-desktop.icns',
      CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version })
    await rename(join(contents, 'MacOS/Electron'), join(contents, 'MacOS', product))
    await cp(icon, join(contents, 'Resources/fig-desktop.icns'))
    for (const helper of await helperApps(staging, 'Electron')) {
      const name = helper.name.replace(/^Electron/, product)
      setPlist(join(helper.path, 'Contents/Info.plist'), { CFBundleName: name, CFBundleDisplayName: name,
        CFBundleIdentifier: `${bundleId}.helper.${helper.suffix}`, CFBundleExecutable: name })
      await rename(join(helper.path, 'Contents/MacOS', helper.name), join(helper.path, 'Contents/MacOS', name))
      await rename(helper.path, join(contents, 'Frameworks', `${name}.app`))
    }
    // Inner bundles first, so each outer signature covers signed contents.
    async function signNested(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const nested = join(directory, entry.name)
        await signNested(nested)
        if (/\.(app|framework|xpc|bundle)$/.test(entry.name)) adHocSign(nested)
      }
    }
    clearAttributes(staging)
    await signNested(join(contents, 'Frameworks'))
    adHocSign(staging, bundleId)
    verifySignature(staging)
    await rename(staging, bundle)
    await writeFile(join(output, 'identity.json'), JSON.stringify(identity) + '\n')
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  await pruneSiblings(dirname(output), key)
  return executable
}

/**
 * Each version or Electron update prepares a new key, so drop the older finished hosts under the same base.
 * Only key-named folders with an identity.json are removed; a host still being prepared has none yet.
 */
export async function pruneSiblings(base, key) {
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === key || !/^[0-9a-f]{12}$/.test(entry.name)) continue
    const folder = join(base, entry.name)
    if (!await stat(join(folder, 'identity.json')).then(() => true, () => false)) continue
    await rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}
