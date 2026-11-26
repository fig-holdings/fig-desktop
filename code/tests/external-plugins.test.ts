import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { checkPackage, ensureExternalPlugins, suspendRequired, verifyArchive } from '../app/main/external-plugins'
import { devOverrides, loadProfile, nextGeneration, parseDescriptor } from '../app/main/profile'
import { satisfies } from '../harness/shared/dsh-range'
import { blockedRequired, taskActivityPanel, teamPluginPolicy } from '../harness/shared/profile-contract'
import { webConfigRows } from '../app/main/plugin-config'
import { tempDir } from './helpers/temp-dir.mjs'

const release = '0.2.2-rc.1'

async function pluginPackage(folder: string, manifest: Record<string, unknown> = {}) {
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: '@team/console', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' },
    dsh: { bundle: { patch: './bundle.patch.yml' } }, ...manifest }))
  await writeFile(join(folder, 'bundle.patch.yml'), "- insert:\n    - id: team-console\n      name: '@team/console'\n")
  return folder
}

/** A stand-in for `dsh plugin --profile web`, as in bundles.test.ts. */
function pluginRunner(home: string, calls: string[][] = []) {
  const path = join(home, 'profiles/web/package.json')
  return async (args: string[]) => {
    calls.push(args)
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

const profileManifest = async (home: string) => JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))

test('engines.dsh ranges: exact, alternatives, comparators, caret and prerelease rules', () => {
  assert.equal(satisfies('0.2.2-rc.1', '0.2.2-rc.1'), true)
  assert.equal(satisfies('0.2.2-rc.3', '0.2.2-rc.1 || 0.2.2-rc.3'), true)
  assert.equal(satisfies('0.2.2-rc.3', '^0.2.2-rc.1'), true)
  assert.equal(satisfies('0.3.0-rc.1', '^0.2.2-rc.1'), false, 'Caret on 0.x stays within the minor')
  assert.equal(satisfies('0.2.2-rc.1', '>=0.2.0'), false, 'A prerelease needs a prerelease comparator of the same version')
  assert.equal(satisfies('0.2.2', '>=0.2.0 <0.3.0'), true)
  assert.equal(satisfies('0.2.2', '*'), true)
  assert.equal(satisfies('0.2.2', '0.2.x'), undefined, 'Unread forms are reported, not guessed')
})

test('a package must be a standard DSH bundle, not take Fig\'s or DSH\'s names, and admit the DSH Fig runs', async t => {
  const root = await tempDir(t, 'fig-external-check-')
  assert.deepEqual(await checkPackage(await pluginPackage(join(root, 'ok')), release), { name: '@team/console', version: '1.0.0', group: undefined, requires: {} })
  await assert.rejects(checkPackage(await pluginPackage(join(root, 'fig'), { name: '@local/dsh-attention' }), release), /belongs to Fig or DSH/)
  await assert.rejects(checkPackage(await pluginPackage(join(root, 'dsh'), { name: '@deepseek-ai/dsh-base' }), release), /belongs to Fig or DSH/)
  await assert.rejects(checkPackage(await pluginPackage(join(root, 'engines'), { engines: { dsh: '^0.3.0' } }), release), /excludes DSH 0\.2\.2-rc\.1/)
  await assert.rejects(checkPackage(await pluginPackage(join(root, 'noengine'), { engines: undefined }), release), /no engines\.dsh/)
  await assert.rejects(checkPackage(await pluginPackage(join(root, 'nopatch'), { dsh: {} }), release), /Not a DSH plugin bundle/)
  await assert.rejects(checkPackage(await pluginPackage(join(root, 'with space')), release), /spaces/)
})

test('a signed package verifies against the Profile\'s trusted keys only', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const other = generateKeyPairSync('ed25519')
  const keys = [{ id: 'cowork-1', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }]
  const archive = Buffer.from('archive bytes')
  const signature = { keyId: 'cowork-1', algorithm: 'ed25519', sha256: createHash('sha256').update(archive).digest('hex'), signature: sign(null, archive, privateKey).toString('base64') }
  assert.equal(verifyArchive(archive, signature, keys), signature.sha256)
  assert.throws(() => verifyArchive(Buffer.from('tampered'), signature, keys), /hash does not match/)
  assert.throws(() => verifyArchive(archive, { ...signature, keyId: 'unknown' }, keys), /not trusted/)
  assert.throws(() => verifyArchive(archive, { ...signature, signature: sign(null, archive, other.privateKey).toString('base64') }, keys), /does not verify/)
})

test('folder and signed sources install through dsh plugin add; required ones stay on, removed ones are uninstalled', async t => {
  const home = await tempDir(t, 'fig-external-home-'), root = await tempDir(t, 'fig-external-src-')
  const calls: string[][] = []
  const folder = await pluginPackage(join(root, 'console'))
  // A signed package: npm pack layout (package/...), detached signature.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  await pluginPackage(join(root, 'pack/package'), { name: '@team/market', version: '2.0.0' })
  const archivePath = join(root, 'market-2.0.0.tgz')
  execFileSync('tar', ['-czf', archivePath, '-C', join(root, 'pack'), 'package'])
  const archive = await readFile(archivePath)
  await writeFile(archivePath + '.sig.json', JSON.stringify({ keyId: 'k', algorithm: 'ed25519', sha256: createHash('sha256').update(archive).digest('hex'), signature: sign(null, archive, privateKey).toString('base64') }))
  const trustedKeys = [{ id: 'k', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }]
  const entries = [{ source: { kind: 'directory' as const, path: folder }, required: true }, { source: { kind: 'package' as const, path: archivePath }, required: false },
    { source: { kind: 'directory' as const, path: join(root, 'missing') }, required: false }]

  const first = await ensureExternalPlugins({ entries, trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home, calls) })
  assert.deepEqual(first.map(item => [item.name, item.status]), [['@team/console', 'ready'], ['@team/market', 'ready'], [undefined, 'failed']])
  assert.match(first[2].reason!, /package\.json/)
  let manifest = await profileManifest(home)
  assert.equal(manifest.dependencies['@team/console'], 'link:' + folder, 'A folder is linked where it is, so edits apply on reload')
  assert.match(manifest.dependencies['@team/market'], /fig\/external\/[0-9a-f]{16}\/package$/)

  // The user switches both off on the Plugins page: the required one is on again at the next start, the optional stays off.
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base']
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify(manifest))
  calls.length = 0
  const second = await ensureExternalPlugins({ entries, trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home, calls) })
  assert.deepEqual(calls, [], 'Nothing changed, nothing relinked')
  assert.deepEqual(second.slice(0, 2).map(item => item.status), ['ready', 'off'])

  // A required plugin that failed to load is paused for one launch only, with the reason.
  await suspendRequired(home, { '@team/console': 'failed to load' })
  const paused = await ensureExternalPlugins({ entries, trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home) })
  assert.deepEqual([paused[0].status, paused[0].reason], ['suspended', 'failed to load'])
  assert.deepEqual(blockedRequired({ plugins: paused }).map(item => item.name), ['@team/console'])
  assert.ok(!(await profileManifest(home)).dsh.profile.bundles.includes('@team/console'))
  const again = await ensureExternalPlugins({ entries, trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home) })
  assert.equal(again[0].status, 'ready', 'The next start loads it again')

  // Dropped from the descriptor: uninstalled, and only what Fig installed.
  manifest = await profileManifest(home)
  manifest.dependencies['user-own'] = '^1.0.0'
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify(manifest))
  calls.length = 0
  await ensureExternalPlugins({ entries: entries.slice(0, 1), trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home, calls) })
  assert.deepEqual(calls, [['remove', '@team/market']])
  assert.ok(Object.hasOwn((await profileManifest(home)).dependencies, 'user-own'))
  // The last one dropped too: removed, and the user's own plugin still stays.
  calls.length = 0
  assert.deepEqual(await ensureExternalPlugins({ entries: [], trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home, calls) }), [])
  assert.deepEqual(calls, [['remove', '@team/console']])
  calls.length = 0
  await ensureExternalPlugins({ entries: [], trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home, calls) })
  assert.deepEqual(calls, [], 'Nothing left to do')
  assert.ok(Object.hasOwn((await profileManifest(home)).dependencies, 'user-own'))
})

test('a plugin group runs whole: one failed or suspended package stops the group, each package updates alone', async t => {
  const home = await tempDir(t, 'fig-group-home-'), root = await tempDir(t, 'fig-group-src-')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const trustedKeys = [{ id: 'k', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }]
  // A signed package of the group; `fig` is Fig's block, `figCowork` Fig Cowork's name for the same.
  async function signed(name: string, version: string, extra: Record<string, unknown> = {}) {
    const dir = join(root, name.replace(/\W/g, '-') + '-' + version)
    await pluginPackage(join(dir, 'package'), { name, version, ...extra })
    const archivePath = join(root, `${name.replace(/\W/g, '-')}-${version}.tgz`)
    execFileSync('tar', ['-czf', archivePath, '-C', dir, 'package'])
    const archive = await readFile(archivePath)
    await writeFile(archivePath + '.sig.json', JSON.stringify({ keyId: 'k', algorithm: 'ed25519', sha256: createHash('sha256').update(archive).digest('hex'), signature: sign(null, archive, privateKey).toString('base64') }))
    return { source: { kind: 'package' as const, path: archivePath }, required: true, group: 'team' }
  }
  const core = await signed('@team/core', '0.1.0', { fig: { group: 'team' } })
  const exec = await signed('@team/exec', '0.1.0', { figCowork: { group: 'team', role: 'module', requires: { '@team/core': '^0.1.0' } } })
  const board = await signed('@team/board', '0.1.0', { fig: { group: 'team', requires: { '@team/core': '^0.1.0' } } })
  const run = (entries: any[]) => ensureExternalPlugins({ entries, trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home) })
  const selected = async () => (await profileManifest(home)).dsh.profile.bundles.filter((name: string) => name.startsWith('@team/')).sort()

  const ready = await run([core, exec, board])
  assert.deepEqual(ready.map(item => [item.name, item.status, item.group]), [['@team/core', 'ready', 'team'], ['@team/exec', 'ready', 'team'], ['@team/board', 'ready', 'team']])

  // One package fails its signature: the whole group is off, each reason names that package.
  const goodSignature = await readFile(board.source.path + '.sig.json', 'utf8')
  await writeFile(board.source.path + '.sig.json', goodSignature.replace(/"signature":"[^"]+"/, '"signature":"AAAA"'))
  const broken = await run([core, exec, board])
  assert.deepEqual(broken.map(item => item.status), ['failed', 'failed', 'failed'])
  for (const item of broken) assert.match(item.reason!, /^插件组 team 已停用：-team-board-0\.1\.0\.tgz 未通过（插件包签名校验失败） \/ Plugin group team is off: -team-board-0\.1\.0\.tgz failed \(The package signature does not verify\)$/)
  assert.deepEqual(await selected(), [], 'No package of the group runs')
  assert.equal(blockedRequired({ plugins: broken }).length, 3)
  await writeFile(board.source.path + '.sig.json', goodSignature)

  // One package updated alone: the others keep their link.
  const linked = (await profileManifest(home)).dependencies['@team/core']
  const exec2 = await signed('@team/exec', '0.1.1', { fig: { group: 'team', requires: { '@team/core': '^0.1.0' } } })
  const updated = await run([core, exec2, board])
  assert.deepEqual(updated.map(item => [item.version, item.status]), [['0.1.0', 'ready'], ['0.1.1', 'ready'], ['0.1.0', 'ready']])
  assert.equal((await profileManifest(home)).dependencies['@team/core'], linked)
  assert.deepEqual(await selected(), ['@team/board', '@team/core', '@team/exec'])

  // An update that needs a newer core than the group has stops the group.
  const exec3 = await signed('@team/exec', '0.2.0', { fig: { group: 'team', requires: { '@team/core': '^0.2.0' } } })
  const unmet = await run([core, exec3, board])
  assert.deepEqual(unmet.map(item => item.status), ['failed', 'failed', 'failed'])
  assert.match(unmet[0].reason!, /@team\/exec 未通过（需要 @team\/core \^0\.2\.0，当前是 0\.1\.0/)

  // A package that failed to load is paused with its group for one launch.
  await run([core, exec2, board])
  await suspendRequired(home, { '@team/board': 'failed to load' })
  const paused = await run([core, exec2, board])
  assert.deepEqual(paused.map(item => item.status), ['suspended', 'suspended', 'suspended'])
  assert.match(paused[1].reason!, /@team\/board 未通过（failed to load）/)
  assert.deepEqual(await selected(), [])
  assert.deepEqual((await run([core, exec2, board])).map(item => item.status), ['ready', 'ready', 'ready'], 'The next start runs the group again')

  // A package that names another group than its descriptor entry is refused.
  const stray = await signed('@team/stray', '0.1.0', { fig: { group: 'other' } })
  const mismatch = await run([core, exec2, board, stray])
  assert.match(mismatch[3].reason!, /插件组 other 与描述文件的 team 不一致/)
  assert.equal(mismatch[0].status, 'failed', 'and stops its group')
})

test('a group\'s business plugin stops alone; the base layer stops the group; the organization can leave one off', async t => {
  const home = await tempDir(t, 'fig-layer-home-'), root = await tempDir(t, 'fig-layer-src-')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const trustedKeys = [{ id: 'k', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }]
  async function signed(name: string, extra: Record<string, unknown> = {}, plugin?: string) {
    const dir = join(root, name.replace(/\W/g, '-'))
    await pluginPackage(join(dir, 'package'), { name, version: '0.1.0', description: name + ' does one thing', ...extra })
    const archivePath = join(root, `${name.replace(/\W/g, '-')}.tgz`)
    execFileSync('tar', ['-czf', archivePath, '-C', dir, 'package'])
    const archive = await readFile(archivePath)
    await writeFile(archivePath + '.sig.json', JSON.stringify({ keyId: 'k', algorithm: 'ed25519', sha256: createHash('sha256').update(archive).digest('hex'), signature: sign(null, archive, privateKey).toString('base64') }))
    return { source: { kind: 'package' as const, path: archivePath }, required: true, group: 'team', ...plugin ? { plugin } : {} }
  }
  const tasks = { layer: 'business', plugin: 'tasks', pluginTitle: '任务协作', requires: { '@team/core': '^0.1.0' } }
  const core = await signed('@team/core', { figCowork: { group: 'team', layer: 'base' } })
  const team = await signed('@team/team', { figCowork: { group: 'team', requires: { '@team/core': '^0.1.0' } } })
  const market = await signed('@team/market', { figCowork: { group: 'team', ...tasks } }, 'tasks')
  const exec = await signed('@team/exec', { figCowork: { group: 'team', ...tasks } }, 'tasks')
  const audit = await signed('@team/audit', { figCowork: { group: 'team', layer: 'business', plugin: 'audit', requires: { '@team/core': '^0.1.0' } } }, 'audit')
  const all = [core, team, market, exec, audit]
  const run = (entries: any[], plugins?: unknown) => ensureExternalPlugins({ entries, trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home), teamPlugins: teamPluginPolicy(plugins) })
  const selected = async () => (await profileManifest(home)).dsh.profile.bundles.filter((name: string) => name.startsWith('@team/')).sort()

  const ready = await run(all)
  assert.deepEqual(ready.map(item => [item.name, item.status, item.plugin ?? null, item.pluginTitle ?? null]), [['@team/core', 'ready', null, null], ['@team/team', 'ready', null, null],
    ['@team/market', 'ready', 'tasks', '任务协作'], ['@team/exec', 'ready', 'tasks', '任务协作'], ['@team/audit', 'ready', 'audit', null]])
  assert.equal(ready[2].description, '@team/market does one thing')

  // A business package fails its signature: only its business plugin stops, named by the descriptor before any manifest is read.
  const good = await readFile(market.source.path + '.sig.json', 'utf8')
  await writeFile(market.source.path + '.sig.json', good.replace(/"signature":"[^"]+"/, '"signature":"AAAA"'))
  const business = await run(all)
  assert.deepEqual(business.map(item => item.status), ['ready', 'ready', 'failed', 'failed', 'ready'])
  assert.match(business[3].reason!, /^业务插件 任务协作 已停用：-team-market\.tgz 未通过（插件包签名校验失败） \/ Business plugin 任务协作 is off/)
  assert.equal(business[2].pluginTitle, '任务协作', 'The failed package takes its siblings\' title')
  assert.deepEqual(await selected(), ['@team/audit', '@team/core', '@team/team'])
  await writeFile(market.source.path + '.sig.json', good)

  // A base package fails: the whole group stops.
  const goodCore = await readFile(core.source.path + '.sig.json', 'utf8')
  await writeFile(core.source.path + '.sig.json', goodCore.replace(/"signature":"[^"]+"/, '"signature":"AAAA"'))
  const base = await run(all)
  assert.deepEqual(base.map(item => item.status), ['failed', 'failed', 'failed', 'failed', 'failed'])
  assert.match(base[4].reason!, /^插件组 team 已停用：-team-core\.tgz 未通过/)
  assert.deepEqual(await selected(), [])
  await writeFile(core.source.path + '.sig.json', goodCore)

  // A business package that failed to load pauses its business plugin only, for one launch.
  await run(all)
  await suspendRequired(home, { '@team/exec': 'failed to load' })
  const paused = await run(all)
  assert.deepEqual(paused.map(item => item.status), ['ready', 'ready', 'suspended', 'suspended', 'ready'])

  // The organization leaves 任务协作 off: not loaded, not a failure, and not reported as a blocked required plugin.
  const off = await run(all, { tasks: false, audit: true })
  assert.deepEqual(off.map(item => item.status), ['ready', 'ready', 'disabled', 'disabled', 'ready'])
  assert.match(off[2].reason!, /^组织未启用业务插件 任务协作 \/ Your organization has not enabled the business plugin 任务协作$/)
  assert.deepEqual(blockedRequired({ plugins: off }), [])
  assert.deepEqual(await selected(), ['@team/audit', '@team/core', '@team/team'])
  assert.deepEqual(off[2].unavailable, { active: false, off: 'tenant' })
  assert.deepEqual((await run(all, {})).map(item => item.status), ['ready', 'ready', 'ready', 'ready', 'ready'], 'A missing switch is on')

  // Not subscribed, or paused by the platform: not loaded either, each saying why.
  const unsubscribed = await run(all, { tasks: { active: false, off: 'unsubscribed' } })
  assert.deepEqual(unsubscribed.map(item => item.status), ['ready', 'ready', 'disabled', 'disabled', 'ready'])
  assert.match(unsubscribed[2].reason!, /^未订阅业务插件 任务协作，请租户管理员订阅 \//)
  const platformPaused = await run(all, { tasks: { active: false, off: 'platform', platformOff: { kind: 'security', reason: '依赖漏洞排查', at: '2026-11-24T08:00:00Z' } } })
  assert.deepEqual(platformPaused.map(item => item.status), ['ready', 'ready', 'disabled', 'disabled', 'ready'])
  assert.match(platformPaused[3].reason!, /^平台因安全问题暂停了业务插件 任务协作：依赖漏洞排查 \/ The platform paused the business plugin 任务协作 for a security issue: 依赖漏洞排查$/)
  assert.equal(platformPaused[2].unavailable?.platformOff?.kind, 'security')
  assert.deepEqual(blockedRequired({ plugins: platformPaused }), [])
  assert.deepEqual((await run(all, { tasks: { active: true } })).map(item => item.status), ['ready', 'ready', 'ready', 'ready', 'ready'], 'Back on at the next start')

  // A verified business package that fails a later check names its plugin from its manifest, though the descriptor does not.
  const engines = await signed('@team/engines', { engines: { dsh: '^9.9.9' }, figCowork: { group: 'team', ...tasks } })
  const late = await run([core, team, engines, exec])
  assert.deepEqual(late.map(item => [item.status, item.plugin ?? null]), [['ready', null], ['ready', null], ['failed', 'tasks'], ['failed', 'tasks']])
  assert.match(late[3].reason!, /^业务插件 任务协作 已停用：@team\/engines 未通过（engines\.dsh/)
  // Naming a plugin without a layer is the business layer, for a failed package as for one that passes.
  const { layer: _layer, ...implicit } = tasks
  const implied = await signed('@team/implied', { engines: { dsh: '^9.9.9' }, figCowork: { group: 'team', ...implicit } })
  assert.deepEqual((await run([core, team, implied, exec])).map(item => item.status), ['ready', 'ready', 'failed', 'failed'])

  // A business package must name its plugin; a base one must not; the descriptor and the package must agree.
  const nameless = await signed('@team/nameless', { figCowork: { group: 'team', layer: 'business' } })
  assert.match((await run([core, nameless]))[1].reason!, /业务插件的包缺少有效的 plugin 名/)
  const mismatch = await signed('@team/other', { figCowork: { group: 'team', layer: 'business', plugin: 'audit' } }, 'tasks')
  const refused = await run([core, mismatch])
  assert.match(refused[1].reason!, /包声明的业务插件 audit 与描述文件的 tasks 不一致/)
  assert.equal(refused[0].status, 'ready', 'and only its business plugin stops')
})

test('a package whose dependency is removed for its own unmet requirement is removed too, whatever the order', async t => {
  const home = await tempDir(t, 'fig-chain-home-'), root = await tempDir(t, 'fig-chain-src-')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const trustedKeys = [{ id: 'k', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }]
  async function signed(name: string, requires: Record<string, string>) {
    const dir = join(root, name.replace(/\W/g, '-'))
    await pluginPackage(join(dir, 'package'), { name, version: '0.1.0', fig: { requires } })
    const archivePath = join(root, `${name.replace(/\W/g, '-')}.tgz`)
    execFileSync('tar', ['-czf', archivePath, '-C', dir, 'package'])
    const archive = await readFile(archivePath)
    await writeFile(archivePath + '.sig.json', JSON.stringify({ keyId: 'k', algorithm: 'ed25519', sha256: createHash('sha256').update(archive).digest('hex'), signature: sign(null, archive, privateKey).toString('base64') }))
    return { source: { kind: 'package' as const, path: archivePath }, required: false }
  }
  // A needs B, listed first; B needs C, which is not installed.
  const a = await signed('@x/a', { '@x/b': '^0.1.0' })
  const b = await signed('@x/b', { '@x/c': '^0.1.0' })
  const states = await ensureExternalPlugins({ entries: [a, b], trustedKeys, dshHome: home, dshRelease: release, plugin: pluginRunner(home) })
  assert.deepEqual(states.map(item => [item.name, item.status]), [['@x/a', 'failed'], ['@x/b', 'failed']])
  assert.match(states[0].reason!, /需要 @x\/b \^0\.1\.0，但它没有装入/)
})

test('a Profile descriptor: personal by default, one shell default for both editions, development overrides and a persisted DSH generation', async t => {
  const home = await tempDir(t, 'fig-profile-')
  const personal = await loadProfile(home)
  assert.equal(personal.edition, 'personal')
  const allOn = { views: true, figures: true, usage: true, filter: true, sessionGroups: true }
  assert.deepEqual(personal.shell, { pluginMenuActions: false, pinnedPanels: undefined, activity: allOn })
  assert.deepEqual(parseDescriptor({ edition: 'team' }, 'id').shell, personal.shell, 'A team Profile starts from the same look')
  assert.deepEqual(parseDescriptor({ shell: { pluginMenuActions: true } }, 'id').shell, { pluginMenuActions: true, pinnedPanels: undefined, activity: allOn }, 'A descriptor can turn DSH\'s rows back on')
  assert.equal((await loadProfile(home)).id, personal.id, 'The id is created once')
  const team = parseDescriptor({ edition: 'team', shell: { pinnedPanels: [taskActivityPanel, 'team-market'] }, coworkOrigin: 'https://cowork.example/x', plugins: ['relative/path'] }, 'id')
  assert.deepEqual(team.shell, { pluginMenuActions: false, pinnedPanels: [taskActivityPanel, 'team-market'], activity: allOn })
  // Task activity's parts (Fig Cowork §1): each off only when the descriptor says false; anything else stays on.
  assert.deepEqual(parseDescriptor({ edition: 'team', shell: { activity: { views: false, figures: false, usage: 'no', filter: false } } }, 'id').shell.activity,
    { views: false, figures: false, usage: true, filter: false, sessionGroups: true })
  assert.equal(team.coworkOrigin, 'https://cowork.example')
  assert.deepEqual(team.plugins, [], 'Only absolute sources')
  assert.equal(parseDescriptor({ coworkOrigin: 'http://cowork.example' }, 'id').coworkOrigin, undefined, 'https only, but loopback')
  const overrides = devOverrides({ FIG_DESKTOP_DEV_PLUGINS: '/a:/b:relative', FIG_DESKTOP_DEV_EDITION: 'team' }, ':')
  assert.deepEqual(overrides, { edition: 'team', directories: ['/a', '/b'] })
  const dev = await loadProfile(home, overrides)
  assert.deepEqual(dev.plugins.map(item => [item.source.path, item.required]), [['/a', true], ['/b', true]], 'A team Profile requires its plugins')
  assert.equal(await nextGeneration(home), 1)
  assert.equal(await nextGeneration(home), 2)
})

test('the Profile reaches the packages as config, and turns DSH\'s plugin rows off', () => {
  const profile = { id: 'p', edition: 'team' as const, dshGeneration: 3, shell: { pluginMenuActions: false }, plugins: [], coworkOrigin: 'https://c.example' }
  const rows = webConfigRows({ startupDirectory: '/w', profile })
  assert.deepEqual(rows.find(row => row.id === 'entry-customization'), { id: 'entry-customization', disabled: true })
  assert.deepEqual((rows.find(row => row.id === 'fig-shell-bridge') as any).config.profile, { id: 'p', edition: 'team', dshGeneration: 3 })
  assert.equal((rows.find(row => row.id === 'fig-desktop-skin') as any).config.profile, profile)
  const shown = { ...profile, shell: { pluginMenuActions: true } }
  assert.ok(!webConfigRows({ startupDirectory: '/w', profile: shown }).some(row => row.id === 'entry-customization'), 'A descriptor that keeps DSH\'s rows')
})

test('a malformed profile.json is kept as written and leaves the Profile plugins alone for the launch', async t => {
  const home = await tempDir(t, 'fig-profile-broken-')
  const path = join(home, 'fig', 'profile.json')
  await mkdir(join(home, 'fig'), { recursive: true })
  const broken = '{ "edition": "team", "plugins": [], }\n'
  await writeFile(path, broken)
  const descriptor = await loadProfile(home)
  assert.equal(descriptor.unreadable, true)
  assert.equal(descriptor.edition, 'personal')
  assert.equal(await readFile(path, 'utf8'), broken, 'The file is not overwritten')
})
