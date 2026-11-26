import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { markUpdatesFailed, pruneUpdates, readUpdateRecord, selectUpdates, updatesRoot } from '../app/main/plugin-updates'
import { tempDir } from './helpers/temp-dir.mjs'

const release = '0.2.2-rc.1'
const app = '0.1.90'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const keys = [{ id: 'fig-test', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }]

function manifest(name: string, version: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ name, version, engines: { dsh: release }, dsh: { bundle: { patch: './bundle.patch.yml' } }, ...extra })
}

/** Fig's build: side-chat and composer at 0.1.0. */
async function built(root: string) {
  for (const [folder, name] of [['side-chat', '@local/dsh-side-chat'], ['composer', '@local/dsh-composer']]) {
    await mkdir(join(root, folder), { recursive: true })
    await writeFile(join(root, folder, 'package.json'), manifest(name, '0.1.0', { fig: { base: app } }))
  }
  return root
}

/** A signed update in npm pack layout, dropped into fig/updates/. */
async function update(home: string, scratch: string, file: string, name: string, version: string, options: { base?: string, key?: typeof privateKey, dsh?: string } = {}) {
  const source = join(scratch, file, 'package')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'package.json'), manifest(name, version, { fig: { base: options.base ?? app }, engines: { dsh: options.dsh ?? release } }))
  await writeFile(join(source, 'bundle.patch.yml'), '- insert: []\n')
  const archive = join(updatesRoot(home), file)
  await mkdir(updatesRoot(home), { recursive: true })
  execFileSync('tar', ['-czf', archive, '-C', join(scratch, file), 'package'])
  const bytes = await readFile(archive)
  await writeFile(archive + '.sig.json', JSON.stringify({ keyId: 'fig-test', algorithm: 'ed25519', sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: sign(null, bytes, options.key ?? privateKey).toString('base64') }))
  return archive
}

const select = (home: string, root: string) => selectUpdates({ dshHome: home, built: root, packages: ['side-chat', 'composer'], appVersion: app, dshRelease: release, keys })

test('without updates the built-in copies are used', async t => {
  const home = await tempDir(t, 'fig-updates-home-'), root = await built(await tempDir(t, 'fig-updates-built-'))
  assert.deepEqual(await select(home, root), { overrides: {}, active: {}, states: [] })
})

test('the newest verified update for this Fig release replaces the built-in copy; others leave it in place', async t => {
  const home = await tempDir(t, 'fig-updates-home-'), root = await built(await tempDir(t, 'fig-updates-built-')), scratch = await tempDir(t, 'fig-updates-src-')
  await update(home, scratch, 'a-side-chat-0.1.1.tgz', '@local/dsh-side-chat', '0.1.1')
  await update(home, scratch, 'b-side-chat-0.1.2.tgz', '@local/dsh-side-chat', '0.1.2')
  await update(home, scratch, 'c-composer-old-app.tgz', '@local/dsh-composer', '0.1.5', { base: '0.1.89' })
  await update(home, scratch, 'd-composer-same.tgz', '@local/dsh-composer', '0.1.0')
  await update(home, scratch, 'e-forged.tgz', '@local/dsh-composer', '0.2.0', { key: generateKeyPairSync('ed25519').privateKey })
  await update(home, scratch, 'f-not-fig.tgz', '@team/console', '1.0.0')
  await update(home, scratch, 'g-dsh.tgz', '@local/dsh-composer', '0.3.0', { dsh: '^0.3.0' })

  const result = await select(home, root)
  assert.deepEqual(Object.keys(result.overrides), ['side-chat'])
  assert.match(result.overrides['side-chat'], /fig\/updates\/unpacked\/[0-9a-f]{16}\/package$/)
  assert.deepEqual(result.active, { '@local/dsh-side-chat': '0.1.2' })
  const status = Object.fromEntries(result.states.map(state => [state.archive, state.status]))
  assert.deepEqual(status, { 'a-side-chat-0.1.1.tgz': 'removed', 'b-side-chat-0.1.2.tgz': 'active', 'c-composer-old-app.tgz': 'removed',
    'd-composer-same.tgz': 'removed', 'e-forged.tgz': 'rejected', 'f-not-fig.tgz': 'rejected', 'g-dsh.tgz': 'rejected' })
  const reasons = Object.fromEntries(result.states.map(state => [state.archive, state.reason ?? '']))
  assert.match(reasons['a-side-chat-0.1.1.tgz'], /Replaced by the newer 0\.1\.2/)
  assert.match(reasons['c-composer-old-app.tgz'], /Built for Fig 0\.1\.89/)
  assert.match(reasons['d-composer-same.tgz'], /Not newer than the built-in 0\.1\.0/)
  assert.match(reasons['e-forged.tgz'], /does not verify/)
  assert.match(reasons['f-not-fig.tgz'], /not one of Fig's feature packages/)
  assert.match(reasons['g-dsh.tgz'], /excludes DSH/)
  const left = await readdir(updatesRoot(home))
  assert.ok(!left.includes('a-side-chat-0.1.1.tgz') && !left.includes('c-composer-old-app.tgz') && !left.includes('d-composer-same.tgz'),
    'replaced and stale updates are deleted with their signatures')
  assert.ok(!left.includes('c-composer-old-app.tgz.sig.json'))
  assert.ok(left.includes('e-forged.tgz'), 'a rejected update stays for the developer to see')
  assert.deepEqual((await readUpdateRecord(home)).active, { '@local/dsh-side-chat': '0.1.2' })
})

test('an update that failed to load is not used again; the built-in copy is, never an older update', async t => {
  const home = await tempDir(t, 'fig-updates-home-'), root = await built(await tempDir(t, 'fig-updates-built-')), scratch = await tempDir(t, 'fig-updates-src-')
  await update(home, scratch, 'side-chat-0.1.1.tgz', '@local/dsh-side-chat', '0.1.1')
  assert.deepEqual((await select(home, root)).active, { '@local/dsh-side-chat': '0.1.1' })
  assert.deepEqual(await markUpdatesFailed(home, ['@local/dsh-side-chat', '@local/dsh-composer'], 'boom'), ['@local/dsh-side-chat'], 'only an active update is recorded')
  const after = await select(home, root)
  assert.deepEqual(after.overrides, {})
  assert.deepEqual(after.states.map(state => [state.status, state.reason]), [['failed', 'boom']])
  assert.equal(await markUpdatesFailed(home, ['@local/dsh-side-chat'], 'again').then(names => names.length), 0)

  await update(home, scratch, 'side-chat-0.1.2.tgz', '@local/dsh-side-chat', '0.1.2')
  assert.deepEqual((await select(home, root)).active, { '@local/dsh-side-chat': '0.1.2' })
  assert.deepEqual(await readdir(updatesRoot(home)).then(files => files.filter(file => file.endsWith('.tgz'))), ['side-chat-0.1.2.tgz'], 'the failed 0.1.1 is replaced')

  // The newest update fails while an older one is still placed (both copied in at once): the built-in copy is used.
  await update(home, scratch, 'side-chat-0.1.3.tgz', '@local/dsh-side-chat', '0.1.3')
  await select(home, root)
  await markUpdatesFailed(home, ['@local/dsh-side-chat'], 'boom')
  await update(home, scratch, 'side-chat-0.1.0b.tgz', '@local/dsh-side-chat', '0.1.2')
  const fallback = await select(home, root)
  assert.deepEqual(fallback.overrides, {}, 'no fallback to the older update')
  assert.deepEqual(fallback.states.map(state => [state.archive, state.status]), [['side-chat-0.1.0b.tgz', 'removed'], ['side-chat-0.1.3.tgz', 'failed']])
})

test('an app update makes earlier updates stale', async t => {
  const home = await tempDir(t, 'fig-updates-home-'), root = await built(await tempDir(t, 'fig-updates-built-')), scratch = await tempDir(t, 'fig-updates-src-')
  await update(home, scratch, 'side-chat-0.1.1.tgz', '@local/dsh-side-chat', '0.1.1')
  assert.deepEqual((await select(home, root)).active, { '@local/dsh-side-chat': '0.1.1' })
  const next = await selectUpdates({ dshHome: home, built: root, packages: ['side-chat', 'composer'], appVersion: '0.1.91', dshRelease: release, keys })
  assert.deepEqual(next.overrides, {})
  assert.equal(next.states[0].status, 'removed')
  // The copy the Web profile still links survives selection; it goes once the profile no longer links it.
  const unpacked = await readdir(join(updatesRoot(home), 'unpacked'))
  assert.equal(unpacked.length, 1, 'kept until the profile is relinked')
  const linked = join(updatesRoot(home), 'unpacked', unpacked[0], 'package')
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({ dependencies: { '@local/dsh-side-chat': 'link:' + linked } }))
  await pruneUpdates(home)
  assert.equal((await readdir(join(updatesRoot(home), 'unpacked'))).length, 1, 'still linked: linking the built-in copy failed')
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({ dependencies: { '@local/dsh-side-chat': 'link:/elsewhere/side-chat' } }))
  await pruneUpdates(home)
  assert.deepEqual(await readdir(join(updatesRoot(home), 'unpacked')), [], 'pruned once nothing links it')
})
