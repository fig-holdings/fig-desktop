import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ensureBundles, planBundles } from '../app/main/bundles'
import { tempDir } from './helpers/temp-dir.mjs'

async function build(root: string, marker: string) {
  for (const [folder, name] of [['side-chat', '@local/dsh-side-chat'], ['composer', '@local/dsh-composer']]) {
    await mkdir(join(root, folder), { recursive: true })
    await writeFile(join(root, folder, 'package.json'), JSON.stringify({ name }))
    await writeFile(join(root, folder, 'index.js'), '// ' + marker)
  }
}

/** A stand-in for `dsh plugin --profile web`: writes what pnpm and DSH would to the profile manifest. */
function pluginRunner(home: string, calls: string[][], fail = false) {
  const path = join(home, 'profiles/web/package.json')
  return async (args: string[]) => {
    calls.push(args)
    if (fail) throw new Error('pnpm failed')
    const manifest = await readFile(path, 'utf8').then(JSON.parse, () => ({ dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    for (const target of args.slice(1)) {
      if (args[0] === 'add') {
        const name = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).name
        manifest.dependencies[name] = 'link:' + target
        if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
      } else {
        delete manifest.dependencies[target]
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((item: string) => item !== target)
      }
    }
    await mkdir(join(home, 'profiles/web'), { recursive: true })
    await writeFile(path, JSON.stringify(manifest))
  }
}

test('Fig packages become Web profile bundles, relinked only when the build changes, keeping the user\'s choices', async t => {
  const built = await tempDir(t, 'fig-bundles-built-'), home = await tempDir(t, 'fig-bundles-home-')
  await build(built, 'v1')
  const calls: string[][] = []
  const plugin = pluginRunner(home, calls)
  const first = await ensureBundles({ built, packages: ['side-chat', 'composer'], dshHome: home, plugin })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'add')
  assert.deepEqual([...first.selected].sort(), ['composer', 'side-chat'])
  assert.deepEqual(first.missing, [])
  const placements = await readdir(join(home, 'fig/packages'))
  assert.equal(placements.length, 1)
  assert.deepEqual((await readdir(join(home, 'fig/packages', placements[0]))).sort(), ['composer', 'side-chat'], 'each package is placed on its own, with no shared code beside it')

  // Unchanged build: nothing runs.
  await ensureBundles({ built, packages: ['side-chat', 'composer'], dshHome: home, plugin })
  assert.equal(calls.length, 1)

  // The user switches composer off on the Plugins page; a new build relinks both and leaves composer off.
  const path = join(home, 'profiles/web/package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== '@local/dsh-composer')
  await writeFile(path, JSON.stringify(manifest))
  await build(built, 'v2')
  const second = await ensureBundles({ built, packages: ['side-chat', 'composer'], dshHome: home, plugin })
  assert.equal(calls.length, 2)
  assert.deepEqual([...second.selected], ['side-chat'])
  assert.deepEqual([...second.switchedOff], ['composer'])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@local/dsh-side-chat'])
  assert.deepEqual((await readdir(join(home, 'fig/packages'))).length, 1, 'the old placement is removed once relinked')
})

test('a package Fig no longer ships is removed; only packages the profile lacks are patched in when linking fails', async t => {
  const home = await tempDir(t, 'fig-bundles-plan-')
  const placement = join(home, 'fig/packages/abc')
  const plan = planBundles({ dependencies: { '@local/dsh-old': `link:${join(home, 'fig/packages/old')}/old`, dshmarket: '^1.0.0', '@local/dsh-side-chat': `link:${placement}/side-chat` },
    bundles: ['@local/dsh-side-chat', 'dshmarket'] }, { 'side-chat': join(placement, 'side-chat') }, { 'side-chat': '@local/dsh-side-chat' }, home)
  assert.deepEqual(plan, { add: [], remove: ['@local/dsh-old'], keepOff: [] }, 'a user\'s own plugin is never touched')

  const built = await tempDir(t, 'fig-bundles-fail-')
  await build(built, 'v1')
  const logged: string[] = []
  const result = await ensureBundles({ built, packages: ['side-chat', 'composer'], dshHome: home, plugin: pluginRunner(home, [], true), log: line => logged.push(line) })
  assert.deepEqual(result.missing.sort(), ['composer', 'side-chat'])
  assert.equal(result.selected.size, 0)
  assert.match(logged[0], /could not be linked/)

  // Linked from an earlier build, then relinking fails: the old links keep loading, on or off as the user left
  // them, and nothing is patched in twice.
  const earlier = await tempDir(t, 'fig-bundles-earlier-')
  await pluginRunner(earlier, [])(['add', join(built, 'side-chat'), join(built, 'composer')])
  const path = join(earlier, 'profiles/web/package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== '@local/dsh-composer')
  await writeFile(path, JSON.stringify(manifest))
  await build(built, 'v2')
  const kept = await ensureBundles({ built, packages: ['side-chat', 'composer'], dshHome: earlier, plugin: pluginRunner(earlier, [], true) })
  assert.deepEqual(kept.missing, [])
  assert.deepEqual([...kept.selected], ['side-chat'])
  assert.deepEqual([...kept.switchedOff], ['composer'])
})

test('an add that fails after relinking still leaves the user\'s switched-off package off', async t => {
  const built = await tempDir(t, 'fig-bundles-built-'), home = await tempDir(t, 'fig-bundles-home-')
  await build(built, 'v1')
  await pluginRunner(home, [])(['add', join(built, 'side-chat'), join(built, 'composer')])
  const path = join(home, 'profiles/web/package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== '@local/dsh-composer')
  await writeFile(path, JSON.stringify(manifest))
  await build(built, 'v2')
  // pnpm relinks and reselects both, then the run is stopped (timeout or quit) before Fig switches composer off again.
  const linking = pluginRunner(home, [])
  const interrupted = async (args: string[]) => { await linking(args); if (args[0] === 'add') throw new Error('aborted') }
  const state = await ensureBundles({ built, packages: ['side-chat', 'composer'], dshHome: home, plugin: interrupted, log: () => {} })
  assert.ok(!JSON.parse(await readFile(path, 'utf8')).dsh.profile.bundles.includes('@local/dsh-composer'))
  assert.deepEqual([...state.switchedOff], ['composer'])
})

test('a package with an update links the update\'s folder; dropping the update links the build again', async t => {
  const built = await tempDir(t, 'fig-bundles-built-'), home = await tempDir(t, 'fig-bundles-home-'), update = await tempDir(t, 'fig-bundles-update-')
  await build(built, 'v1')
  await writeFile(join(update, 'package.json'), JSON.stringify({ name: '@local/dsh-side-chat', version: '0.1.1' }))
  const calls: string[][] = []
  const plugin = pluginRunner(home, calls)
  await ensureBundles({ built, packages: ['side-chat', 'composer'], overrides: { 'side-chat': update }, dshHome: home, plugin })
  const path = join(home, 'profiles/web/package.json')
  let dependencies = JSON.parse(await readFile(path, 'utf8')).dependencies
  assert.equal(dependencies['@local/dsh-side-chat'], 'link:' + update)
  const placements = await readdir(join(home, 'fig/packages'))
  assert.deepEqual(await readdir(join(home, 'fig/packages', placements[0])), ['composer'], 'the updated package is not placed from the build')

  await ensureBundles({ built, packages: ['side-chat', 'composer'], dshHome: home, plugin })
  dependencies = JSON.parse(await readFile(path, 'utf8')).dependencies
  assert.match(dependencies['@local/dsh-side-chat'], /fig\/packages\/[0-9a-f]{16}\/side-chat$/)
})
