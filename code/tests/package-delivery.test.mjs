import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { retain, swapInPlace } from '../scripts/package-delivery.mjs'
import { tempDir } from './helpers/temp-dir.mjs'

async function bundle(path, value) { await mkdir(path, { recursive: true }); await writeFile(join(path, 'value'), value) }
const value = path => readFile(join(path, 'value'), 'utf8')

test('the swap archives the current bundle and installs the candidate', async t => {
  const root = await tempDir(t, 'fig-swap-')
  const paths = { destination: join(root, 'current.app'), candidate: join(root, 'candidate.app'), archive: join(root, 'old.app') }
  await bundle(paths.destination, 'old'); await bundle(paths.candidate, 'new')
  await swapInPlace(paths)
  assert.equal(await value(paths.destination), 'new')
  assert.equal(await value(paths.archive), 'old')
  await assert.rejects(swapInPlace(paths), /already exists/)
})

test('a failed install puts the old bundle back', async t => {
  const root = await tempDir(t, 'fig-swap-')
  const paths = { destination: join(root, 'current.app'), candidate: join(root, 'candidate.app'), archive: join(root, 'old.app') }
  await bundle(paths.destination, 'old'); await bundle(paths.candidate, 'new')
  const { rename } = await import('node:fs/promises')
  const move = (from, to) => from === paths.candidate ? Promise.reject(new Error('disk full')) : rename(from, to)
  await assert.rejects(swapInPlace(paths, move), /disk full/)
  assert.equal(await value(paths.destination), 'old')
  assert.equal(await value(paths.candidate), 'new')
})

test('retention keeps the two newest version folders with a bundle', async t => {
  const root = await tempDir(t, 'fig-retain-')
  for (const name of ['0.1.9', '0.1.10', '0.1.11', '0.1.11-rebuild-x']) await bundle(join(root, name, 'Fig Desktop.app'), name)
  await mkdir(join(root, '0.1.2'))
  await bundle(join(root, 'Fig Desktop.app'), 'current')
  let trashed = []
  assert.deepEqual(await retain(root, 2, paths => { trashed = paths }), ['0.1.10', '0.1.9'])
  assert.deepEqual(trashed, [join(root, '0.1.10'), join(root, '0.1.9')])
  assert.ok((await readdir(root)).includes('0.1.2'))
})
