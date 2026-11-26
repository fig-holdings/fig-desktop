import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { checkFigModules, generateThirdPartyLicenses } from '../scripts/third-party-licenses.mjs'
import { pnpmVersion } from '../app/main/pnpm-shim.ts'
import { tempDir } from './helpers/temp-dir.mjs'
import { lockedRelease, runtimeFolder } from '../harness/shared/dsh-runtime.js'

const entry = name => ({
  name, version: '1.0.0', license: 'MIT',
  resolved: `https://registry.npmjs.org/${name}/-/sample-1.0.0.tgz`, integrity: 'sha512-test'
})
const dshLocation = 'node_modules/@deepseek-ai/dsh'
const optionalLocation = 'node_modules/sample-native'

async function fixture(t) {
  const root = await tempDir(t, 'fig-licenses-test-')
  const code = join(root, 'code')
  const cache = join(root, 'npm')
  async function put(folder, path, data) {
    const file = join(folder, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data))
  }

  const packages = {
    'node_modules/yaml': { ...entry('yaml'), dev: true },
    'node_modules/electron': { ...entry('electron'), dev: true }
  }
  const tree = {
    [dshLocation]: { ...entry('@deepseek-ai/dsh'), bin: { dsh: 'lib/bin.js' } },
    [optionalLocation]: { ...entry('sample-native'), optional: true }
  }
  await put(code, 'package-lock.json', { packages })
  await put(code, 'harness/dsh-versions.json', { verified: ['1.0.0'] })
  // The locked DSH tree (code/dsh-runtime/) and its install (shared/dsh-runtime.js) in the cache folder.
  const manifest = { dependencies: { '@deepseek-ai/dsh': '1.0.0' } }
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: manifest.dependencies }, ...tree } }
  await put(code, 'dsh-runtime/package.json', manifest)
  await put(code, 'dsh-runtime/package-lock.json', lock)
  const release = lockedRelease(manifest, lock)
  const npx = runtimeFolder(cache, release)
  await put(npx, '.fig-dsh-runtime.json', release)
  await put(npx, 'package-lock.json', lock)
  await put(npx, 'node_modules/.package-lock.json', { packages: tree })
  for (const [base, installed] of [[code, packages], [npx, tree]]) {
    for (const [location, pkg] of Object.entries(installed)) {
      await put(base, location + '/package.json', pkg)
      await put(base, location + '/LICENSE', 'Package permission text for ' + pkg.name)
    }
  }
  await put(code, 'node_modules/electron/dist/LICENSE', 'Electron license text')
  await put(code, 'node_modules/electron/dist/LICENSES.chromium.html', '<h1>Chromium Credits</h1>')
  await put(root, 'NOTICE', 'Fig NOTICE')
  await put(code, 'spdx/MIT.txt', 'MIT template')
  await put(code, 'adapted/NOTICE', 'Adapted upstream notice')
  await put(code, 'assets/OFL.txt', 'Font permission text')
  const configured = (name, path) => ({ name, version: '1.0.0', license: 'MIT', source: path, files: [{ path }] })
  await put(code, 'third-party-licenses.config.json', {
    figBundledDev: ['node_modules/yaml'], dshEvidence: {}, spdx: { MIT: { path: 'spdx/MIT.txt' } },
    dsh: [{ ...configured('pnpm', 'spdx/MIT.txt'), version: pnpmVersion }],
    adapted: [configured('Adapted', 'adapted/NOTICE')], assets: [configured('Font', 'assets/OFL.txt')]
  })

  const generate = () => generateThirdPartyLicenses({
    code, cache, electronVersions: () => ({ electron: '1.0.0', chrome: '123.4.5.6' })
  })
  return { root, code, cache, npx, generate, installed: npx.slice(root.length + 1) }
}

test('build inventory includes installed optional dependencies and is reproducible', async t => {
  const { code, generate } = await fixture(t)
  const { files, figLocations } = generate()
  const manifest = JSON.parse(files.get('manifest.json'))
  assert.deepEqual(new Set(manifest.entries.map(entry => entry.category)), new Set(['fig', 'electron', 'dsh', 'adapted', 'assets']))
  assert.ok(manifest.entries.some(entry => entry.location === optionalLocation))
  assert.deepEqual([...generate().files], [...files])
  checkFigModules(code, figLocations, [join(code, 'node_modules/yaml/index.js')], ['electron', 'node:path'])
  assert.throws(() => checkFigModules(code, figLocations, [join(code, 'node_modules/unlisted/index.js')]), /Unlisted npm module/)
})

test('the build inventory fails on a missing license or notice from each source', async t => {
  for (const [source, path, error] of [
    ['Fig', 'code/node_modules/yaml/LICENSE', /Missing license evidence for yaml@/],
    ['Electron', 'code/node_modules/electron/dist/LICENSES.chromium.html', /Missing license or notice for Chromium/],
    ['DSH', 'DSH:' + optionalLocation + '/LICENSE', /Missing license evidence for sample-native@/],
    ['Adapted source', 'code/adapted/NOTICE', /Missing license or notice for Adapted@/],
    ['Asset', 'code/assets/OFL.txt', /Missing license or notice for Font@/]
  ]) {
    await t.test(source, async child => {
      const { root, generate, installed } = await fixture(child)
      await rm(join(root, path.replace(/^DSH:/, installed + '/')))
      assert.throws(generate, error)
    })
  }
})

test('a missing cache or a removed installed optional package cannot produce a DSH inventory', async t => {
  const { cache, npx, generate } = await fixture(t)
  await rm(join(npx, optionalLocation, 'package.json'))
  assert.throws(generate, /Missing DSH installed package.*sample-native/)
  await rm(cache, { recursive: true })
  assert.throws(generate, /Missing DSH.*npm run licenses:prepare -- 1.0.0/)
})
