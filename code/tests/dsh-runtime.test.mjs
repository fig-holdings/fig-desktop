import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDshRuntime, installedRuntime, lockedRelease, runtimeFolder, staleRuntimes } from '../harness/shared/dsh-runtime.js'

const code = new URL('..', import.meta.url).pathname
const read = name => JSON.parse(readFileSync(join(code, name), 'utf8'))

/** A manifest and lock pinning `version`, shaped like npm's. */
function pinned(version) {
  const manifest = { name: '@local/dsh-runtime', version: '0.0.0', private: true, dependencies: { '@deepseek-ai/dsh': version } }
  return { manifest, lock: { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies }, 'node_modules/@deepseek-ai/dsh': { version } } } }
}

/** An `npm` stand-in: `ci` writes the locked DSH package (or fails when FAKE_NPM_FAIL is set) and records its arguments. */
async function fakeNpm(dir) {
  const path = join(dir, 'fake-npm.mjs')
  await writeFile(path, `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')
if (process.env.FAKE_NPM_FAIL) { console.error('npm error code ENOTFOUND'); process.exit(1) }
const version = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages['node_modules/@deepseek-ai/dsh'].version
mkdirSync('node_modules/@deepseek-ai/dsh/lib', { recursive: true })
writeFileSync('node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
writeFileSync('node_modules/@deepseek-ai/dsh/lib/bin.js', '')
`)
  return path
}

test('the committed lockfile pins the DSH release Fig verified, and only a fixed release', () => {
  const release = lockedRelease(read('dsh-runtime/package.json'), read('dsh-runtime/package-lock.json'))
  assert.equal(release.version, read('harness/dsh-versions.json').verified.at(-1))
  assert.match(release.digest, /^[0-9a-f]{12}$/)
  const { manifest, lock } = pinned('0.2.2-rc.5')
  assert.throws(() => lockedRelease({ ...manifest, dependencies: { '@deepseek-ai/dsh': '^0.2.2-rc.5' } }, lock), /fixed DSH release/)
  assert.throws(() => lockedRelease({ ...manifest, dependencies: { ...manifest.dependencies, other: '1.0.0' } }, lock), /exactly one/)
  assert.throws(() => lockedRelease(manifest, { ...lock, packages: { ...lock.packages, 'node_modules/@deepseek-ai/dsh': { version: '0.2.2-rc.6' } } }), /does not install/)
})

test('a locked release installs once, beside itself, and a failed or stopped install leaves nothing in its place', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fig-dsh-runtime-')), root = join(dir, 'dsh')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const npm = await fakeNpm(dir), locked = pinned('0.2.2-rc.5')
  const options = { ...locked, root, node: process.execPath, npm, cache: join(dir, 'npm') }

  await assert.rejects(ensureDshRuntime({ ...options, env: { ...process.env, FAKE_NPM_FAIL: '1' } }), /ENOTFOUND/)
  assert.deepEqual(readdirSync(root), [], 'a failed install leaves no folder')

  let announced = 0
  const first = await ensureDshRuntime({ ...options, onInstall: () => announced++ })
  assert.equal(first.installed, true)
  assert.equal(first.entry, join(runtimeFolder(root, lockedRelease(locked.manifest, locked.lock)), 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  assert.match(readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').at(-1), /^ci --omit=dev --no-audit --no-fund --cache .*npm$/, 'install scripts run')
  const again = await ensureDshRuntime({ ...options, onInstall: () => announced++ })
  assert.deepEqual([again.installed, again.entry, announced], [false, first.entry, 1])

  // A folder without the marker (removed by hand part-way) is replaced.
  await rm(join(first.folder, '.fig-dsh-runtime.json'))
  assert.equal(installedRuntime(root, lockedRelease(locked.manifest, locked.lock)), undefined)
  assert.equal((await ensureDshRuntime(options)).installed, true)

  await ensureDshRuntime({ ...options, ignoreScripts: true })
  const license = await ensureDshRuntime({ ...options, root: join(dir, 'licenses'), ignoreScripts: true })
  assert.equal(license.installed, true)
  assert.match(readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').at(-1), /--ignore-scripts$/)
})

test('older installs and stopped installs are removed; the current one and the newest other stay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fig-dsh-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const now = Date.now()
  const finished = async (name, ageMs) => {
    await mkdir(join(root, name))
    await writeFile(join(root, name, '.fig-dsh-runtime.json'), '{}')
    utimesSync(join(root, name, '.fig-dsh-runtime.json'), (now - ageMs) / 1000, (now - ageMs) / 1000)
  }
  await finished('0.2.2-rc.1-aaaaaaaaaaaa', 3e6)
  await finished('0.2.2-rc.3-bbbbbbbbbbbb', 2e6)
  await finished('0.2.2-rc.5-cccccccccccc', 1e6)
  await mkdir(join(root, '.install-0.2.2-rc.5-cccccccccccc-1234abcd'))
  await mkdir(join(root, 'unfinished-folder'))
  const current = join(root, '0.2.2-rc.1-aaaaaaaaaaaa')
  assert.deepEqual(staleRuntimes(root, current, { now }), [join(root, '0.2.2-rc.3-bbbbbbbbbbbb')], 'a fresh stopped install may still be running')
  assert.deepEqual(staleRuntimes(root, current, { now: now + 3_700_000 }).sort(),
    [join(root, '.install-0.2.2-rc.5-cccccccccccc-1234abcd'), join(root, '0.2.2-rc.3-bbbbbbbbbbbb')].sort())
  assert.ok(existsSync(join(root, 'unfinished-folder')))
  assert.deepEqual(staleRuntimes(join(root, 'missing'), current), [])
  assert.equal(JSON.parse(await readFile(join(root, '0.2.2-rc.5-cccccccccccc', '.fig-dsh-runtime.json'), 'utf8')).constructor, Object)
})
