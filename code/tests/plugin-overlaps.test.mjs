import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { overlapOf, packageOf, pluginOverlaps } from '../harness/desktop-skin/plugin-overlaps.js'
import { installedOverlaps } from '../harness/desktop-skin/index.js'
import { tempDir } from './helpers/temp-dir.mjs'

test('a spec names its package without version or tag, in any case', () => {
  assert.equal(packageOf(' dsh-keep-awake@1.0.0 '), 'dsh-keep-awake')
  assert.equal(packageOf('@MichengAI/dsh-btw@latest'), '@michengai/dsh-btw')
  assert.equal(packageOf('@michengai/dsh-btw'), '@michengai/dsh-btw')
  assert.equal(packageOf('github:owner/repo extra'), '')
  assert.equal(packageOf(''), '')
})

test('listed packages map to the Fig feature they duplicate; others to nothing', () => {
  assert.deepEqual(overlapOf('dsh-keep-awake@2.0.0')?.feature, 'keep-awake')
  assert.equal(overlapOf('@goodandready/dsh-subscriptions')?.partial, true)
  assert.equal(overlapOf('dsh-everforest'), undefined)
  assert.deepEqual(overlapOf('@deepseek-ai/dsh-experimental-forge-bundle'), { feature: 'development-workbench', partial: true,
    packages: ['@deepseek-ai/dsh-experimental-forge-bundle'] })
  const all = pluginOverlaps.flatMap(overlap => overlap.packages)
  assert.equal(new Set(all).size, all.length, 'A package is listed once')
  assert.ok(all.every(name => name === packageOf(name)), 'Listed as plain lower-case package names')
})

test('the Plugins page learns which installed plugins duplicate Fig, and whether they are on', async t => {
  const home = await tempDir(t, 'fig-overlaps-')
  assert.deepEqual(await installedOverlaps(home), { plugins: [] }, 'No profile yet')
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({
    dependencies: { '@michengai/dsh-btw': '^1.3.5', 'dsh-everforest': '^1.4.0', 'dsh-keep-awake': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@michengai/dsh-btw', 'dsh-everforest'] } } }))
  assert.deepEqual(await installedOverlaps(home), { plugins: [
    { name: '@michengai/dsh-btw', feature: 'side-chat', partial: false, on: true },
    { name: 'dsh-keep-awake', feature: 'keep-awake', partial: false, on: false }
  ] })
})

test('an experimental plugin turned on counts though it is only a bundle', async t => {
  const home = await tempDir(t, 'fig-overlaps-')
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({
    dependencies: { 'dsh-keep-awake': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-forge-bundle', 'dsh-keep-awake'] } } }))
  assert.deepEqual(await installedOverlaps(home), { plugins: [
    { name: 'dsh-keep-awake', feature: 'keep-awake', partial: false, on: true },
    { name: '@deepseek-ai/dsh-experimental-forge-bundle', feature: 'development-workbench', partial: true, on: true }
  ] })
})
