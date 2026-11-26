import { prepareDevRuntime } from './dev-runtime.mjs'
import { adHocSign, clearAttributes, helperApps, setPlist, verifySignature } from './macos-bundle.mjs'
import { stageApplicationPayload } from './third-party-licenses.mjs'
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('Build the macOS trial on a Mac')
const code = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(code, '..')
const { name, productName, version } = JSON.parse(await readFile(join(code, 'package.json'), 'utf8'))
const verification = process.argv.includes('--verification')
const bundleId = verification ? 'local.fig.desktop.verification' : 'local.fig.desktop.trial'
const bundleName = productName + (verification ? ' Verification.app' : '.app')
const build = join(root, verification ? 'work/build-verification' : 'work/build')
const staging = process.argv.find(arg => arg.startsWith('--staging='))?.slice(10)
if (staging && (!resolve(staging).startsWith(join(root, 'outputs/.staging/')) || verification)) throw new Error('Staging must be a trial directory under outputs/.staging')
const outputs = staging ? resolve(staging) : join(root, verification ? 'work/verification/package' : 'outputs')
const destination = join(outputs, bundleName)
await access(join(build, 'main/index.js'))
await access(join(build, 'preload/index.cjs'))
await access(join(build, 'preload/dsh-locale.cjs'))
await access(join(build, 'renderer/index.html'))
const copyBundle = (source, target) => execFileSync('/usr/bin/ditto', ['--norsrc', '--noextattr', '--noacl', source, target], { stdio: 'inherit' })
const setId = (target, id) => setPlist(join(target, 'Contents/Info.plist'), { CFBundleIdentifier: id })

// Stage the signing work outside the workspace to keep Finder metadata out of the signature.
const scratch = await mkdtemp(join(tmpdir(), 'fig-package-'))
let incoming
try {
  const bundle = join(scratch, bundleName)
  copyBundle(resolve(dirname(await prepareDevRuntime()), '../..'), bundle)
  const resources = join(bundle, 'Contents/Resources')
  const app = join(resources, 'app')
  await rm(join(resources, 'default_app.asar'), { force: true })
  await stageApplicationPayload(build, app, { name, productName, version })

  setId(bundle, bundleId)
  if (verification) setPlist(join(bundle, 'Contents/Info.plist'), {CFBundleDisplayName: 'Fig Desktop Verification'})
  for (const helper of await helperApps(bundle, productName)) {
    const id = bundleId + '.helper.' + helper.suffix
    setId(helper.path, id)
    adHocSign(helper.path, id)
  }
  clearAttributes(bundle)
  adHocSign(bundle, bundleId)
  verifySignature(bundle)

  await mkdir(outputs, { recursive: true })
  incoming = await mkdtemp(join(outputs, '.fig-package-'))
  const candidate = join(incoming, bundleName)
  copyBundle(bundle, candidate)
  // Workspace's file provider adds FinderInfo to copied bundles. The clean staging
  // bundle is verified in strict mode; verify its copied code and resources here.
  verifySignature(candidate, false)
  // A rebuild must not delete or merge into an existing trial bundle.
  try {
    await access(destination)
    throw new Error('Move the previous trial out of outputs before rebuilding: ' + destination)
  } catch (/** @type {any} */ error) {
    if (error.code !== 'ENOENT') throw error
  }
  await rename(candidate, destination)
  verifySignature(destination, false)
  console.log(destination)
} finally {
  if (incoming) await rm(incoming, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
}
