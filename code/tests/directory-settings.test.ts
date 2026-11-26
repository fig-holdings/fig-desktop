import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFileSync} from 'node:child_process'
import {chmod, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {DirectoryNonce, DirectorySettings, copyDirectoryContents, directoryAction, directoryDigest, setDefaultWorkspace} from '../app/main/directory-settings'
import {configureDirectory} from '../app/main/directory-dialogs'
import {writeRecord} from '../harness/shared/atomic-json'
import {launchDsh, verifiedDsh} from '../harness/dsh-versions'
import { tempDir } from './helpers/temp-dir.mjs'

async function fixture(t: any) {
  const base = await realpath(await tempDir(t, 'fig-directory-test-'))
  const home = join(base, 'home'), target = join(base, 'target'), userData = join(base, 'desktop'), startup = join(base, 'workspace')
  for (const path of [home, target, userData, startup]) await mkdir(path)
  await mkdir(join(home, 'sessions/empty'), {recursive: true})
  await writeFile(join(home, '.credentials.yaml'), 'SYNTHETIC-GRANT-ONLY', {mode: 0o600})
  await writeFile(join(home, 'sessions/session.jsonl'), '{"event":"synthetic-session"}\n')
  await chmod(home, 0o700)
  return {base, home, target, userData, startup, settings: new DirectorySettings(userData), current: {startup, dshHome: home}}
}

test('migration verifies hidden credentials, session bytes, permissions and empty folders before selection; the original remains intact', async t => {
  const f = await fixture(t), before = await directoryDigest(f.home)
  const settings = new DirectorySettings(f.userData, async (source, dest, options) => {
    assert.equal((await f.settings.read()).dshHome, undefined)
    assert.equal((await stat(dest)).mode & 0o777, 0o700, 'The destination is private before any credential/session bytes are copied')
    await copyDirectoryContents(source, dest, options)
    assert.equal((await f.settings.read()).dshHome, undefined)
  })
  await settings.commit('dshHome', f.target, f.current, launchDsh)
  assert.deepEqual(await settings.read(), {schema: 1, dshHome: f.target, previousDshHome: f.home})
  assert.equal(await directoryDigest(f.home), before)
  assert.equal(await directoryDigest(f.target), before)
  assert.equal((await stat(join(f.target, '.credentials.yaml'))).mode & 0o777, 0o600)
  assert.equal(await settings.recoverNotice(), false)
  assert.equal((await settings.load(f.current)).dshHome, f.target)
})

test('partial-copy failures never select partial data; recovery retains the journal and both folders', async t => {
  const f = await fixture(t), before = await directoryDigest(f.home)
  const settings = new DirectorySettings(f.userData, async (_source, dest) => {await writeFile(join(String(dest), 'partial'), 'PARTIAL'); throw Error('synthetic disk full')})
  await assert.rejects(settings.commit('dshHome', f.target, f.current, launchDsh))
  assert.equal((await settings.load(f.current)).dshHome, f.home)
  assert.equal(await directoryDigest(f.home), before)
  assert.equal(await settings.recoverNotice(), true)
  assert.ok((await readdir(f.userData)).some(name => name.startsWith('directory-migration-interrupted-')))
  assert.equal(await readFile(join(f.target, 'partial'), 'utf8'), 'PARTIAL')
  assert.equal(await settings.recoverNotice(), false)
})

test('copy corruption and changes in the source prevent selection', async t => {
  for (const corruptSource of [false, true]) {
    const f = await fixture(t)
    const settings = new DirectorySettings(f.userData, async (source, dest, options) => {
      await copyDirectoryContents(source, dest, options)
      await writeFile(join(corruptSource ? String(source) : String(dest), '.credentials.yaml'), 'SYNTHETIC-CHANGED')
    })
    await assert.rejects(settings.commit('dshHome', f.target, f.current, launchDsh), /COPY_VERIFICATION_FAILED/)
    assert.equal((await settings.load(f.current)).dshHome, f.home)
  }
})

test('failure of the final preferences write leaves the original active after a verified copy', async t => {
  const f = await fixture(t)
  await writeRecord(f.settings.path, {schema: 1, dshHome: f.home})
  const settings = new DirectorySettings(f.userData, copyDirectoryContents, async (path, value) => {
    if (path === f.settings.path) throw Error('synthetic preferences disk full')
    await writeRecord(path, value)
  })
  await assert.rejects(settings.commit('dshHome', f.target, f.current, launchDsh))
  assert.equal((await f.settings.load(f.current)).dshHome, f.home)
  assert.equal(await directoryDigest(f.home), await directoryDigest(f.target))
  assert.equal(await f.settings.recoverNotice(), true)
})

test('a crash after atomic selection is committed; restoration keeps post-migration data in the newer folder', async t => {
  const f = await fixture(t)
  await f.settings.commit('dshHome', f.target, f.current, launchDsh)
  const journal = JSON.parse(await readFile(f.settings.journal, 'utf8'))
  await writeRecord(f.settings.journal, {...journal, status: 'verified'})
  assert.equal(await f.settings.recoverNotice(), false)
  await writeFile(join(f.target, 'new-session'), 'SYNTHETIC-POST-MIGRATION')
  await f.settings.commit('restoreDshHome', f.home, {...f.current, dshHome: f.target}, launchDsh)
  assert.equal((await f.settings.load(f.current)).dshHome, f.home)
  assert.equal((await f.settings.read()).previousDshHome, f.target)
  assert.equal(await readFile(join(f.target, 'new-session'), 'utf8'), 'SYNTHETIC-POST-MIGRATION')
})

test('missing configured volumes never create empty homes, and the retained snapshot can be restored', async t => {
  const f = await fixture(t)
  await f.settings.commit('dshHome', f.target, f.current, launchDsh)
  await rename(f.target, f.target + '-disconnected')
  await assert.rejects(f.settings.load(f.current), /DIRECTORY_UNAVAILABLE/)
  await f.settings.commit('restoreDshHome', f.home, {...f.current, dshHome: f.target}, launchDsh)
  assert.equal((await f.settings.load(f.current)).dshHome, f.home)
})

test('nonempty, overlapping and aliased targets reject without overwriting; special files fail closed', async t => {
  const f = await fixture(t), before = await directoryDigest(f.home)
  await writeFile(join(f.target, 'KEEP'), 'existing data')
  await assert.rejects(f.settings.commit('dshHome', f.target, f.current, launchDsh), /TARGET_NOT_EMPTY/)
  const nested = join(f.home, 'nested'); await mkdir(nested)
  await assert.rejects(f.settings.validateMigration(f.home, nested), /OVERLAPPING/)
  const alias = join(f.base, 'alias'); await symlink(f.home, alias)
  await assert.rejects(f.settings.validateMigration(f.home, alias), /OVERLAPPING/)
  await rm(nested, {recursive: true}); assert.equal(await directoryDigest(f.home), before)
  const empty = join(f.base, 'empty'); await mkdir(empty)
  execFileSync('/usr/bin/mkfifo', [join(f.home, 'pipe')])
  await assert.rejects(f.settings.commit('dshHome', empty, f.current, launchDsh), /UNSUPPORTED_DATA_FILE/)
  assert.deepEqual(await readdir(empty), [])
})

test('internal, cyclic and dangling links stay inside the new home; external relative links keep their shared asset destination', async t => {
  const f = await fixture(t), shared = join(f.base, 'shared.txt')
  await writeFile(shared, 'KEEP-SHARED-ASSET')
  await symlink(join(f.home, 'sessions'), join(f.home, 'internal-absolute'))
  await symlink('.credentials.yaml', join(f.home, 'internal-relative'))
  await symlink('../shared.txt', join(f.home, 'external-relative'))
  await symlink('missing', join(f.home, 'dangling-internal'))
  await symlink('.', join(f.home, 'cycle'))
  const before = await directoryDigest(f.home)
  await f.settings.commit('dshHome', f.target, f.current, launchDsh)
  assert.equal(await realpath(join(f.target, 'internal-absolute')), join(f.target, 'sessions'))
  assert.equal(await realpath(join(f.target, 'internal-relative')), join(f.target, '.credentials.yaml'))
  assert.equal(await realpath(join(f.target, 'cycle')), f.target)
  assert.equal(await readlink(join(f.target, 'dangling-internal')), 'missing')
  assert.equal(await realpath(join(f.target, 'external-relative')), shared)
  assert.equal(await readlink(join(f.home, 'internal-absolute')), join(f.home, 'sessions'))
  assert.equal(await readFile(shared, 'utf8'), 'KEEP-SHARED-ASSET')
  assert.equal(await directoryDigest(f.target), before)
})

async function workspaceFixture(home: string, startup: string) {
  const registry = {unit: {name: 'workspace', version: 2}, global: {initialized: true, defaultWorkspaceId: 'original', workspaceIds: ['original'], archivedSessionIds: ['archived'], pinnedSessionIds: ['pinned']},
    tables: {workspaces: {original: {path: startup, title: 'Synthetic original', sessionIds: ['session'], createdAt: 'original-created', updatedAt: 'original-updated'}}}}
  await writeRecord(join(home, 'storages/workspace.json'), registry)
  return registry
}

test('default changes preserve old workspace/session records and byte-exact backups; reselecting reuses identity', async t => {
  const f = await fixture(t), original = await workspaceFixture(f.home, f.startup)
  const path = join(f.home, 'storages/workspace.json'), raw = await readFile(path)
  await setDefaultWorkspace(f.home, f.target, launchDsh)
  const result = JSON.parse(await readFile(path, 'utf8')), id = result.global.defaultWorkspaceId
  assert.deepEqual(result.tables.workspaces.original, original.tables.workspaces.original)
  assert.deepEqual(result.global.archivedSessionIds, ['archived']); assert.deepEqual(result.global.pinnedSessionIds, ['pinned'])
  assert.equal(result.tables.workspaces[id].path, f.target)
  assert.equal(await readFile(join(f.home, 'sessions/session.jsonl'), 'utf8'), '{"event":"synthetic-session"}\n')
  const backup = (await readdir(join(f.home, 'fig/directory-backups')))[0]
  assert.deepEqual(await readFile(join(f.home, 'fig/directory-backups', backup)), raw)
  await setDefaultWorkspace(f.home, f.target, launchDsh)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).global.defaultWorkspaceId, id)
  await setDefaultWorkspace(f.home, f.startup, launchDsh)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).global.defaultWorkspaceId, 'original')
})

test('unknown versions and unfinished native registry mutations are never rewritten', async t => {
  const f = await fixture(t), original = await workspaceFixture(f.home, f.startup), path = join(f.home, 'storages/workspace.json')
  for (const [release, registry] of [['9.0.0', original], [launchDsh, {...original, unit: {name: 'workspace', version: 99}}], [launchDsh, {...original, global: {...original.global, pendingMutation: {operation: 'create', workspaceId: 'interrupted'}}}]] as const) {
    await writeRecord(path, registry); const before = await readFile(path)
    await assert.rejects(setDefaultWorkspace(f.home, f.target, release), /WORKSPACE_FORMAT_UNSUPPORTED/)
    assert.deepEqual(await readFile(path), before)
  }
})

test('startup persists outside DSH; corrupt preferences do not silently open a fresh profile', async t => {
  const f = await fixture(t)
  await f.settings.commit('startup', f.target, f.current, launchDsh)
  assert.equal((await f.settings.load(f.current)).startup, f.target)
  await writeFile(f.settings.path, '{broken')
  await assert.rejects(f.settings.load(f.current), /PREFERENCES_UNREADABLE/)
  assert.equal(await readFile(f.settings.path, 'utf8'), '{broken')
})

test('an unavailable startup directory falls back for this launch and keeps the saved choice; reset keeps the bad file', async t => {
  const f = await fixture(t)
  await f.settings.commit('startup', f.target, f.current, launchDsh)
  await rename(f.target, f.target + '-unmounted')
  const loaded = await f.settings.load(f.current)
  assert.equal(loaded.startup, f.startup); assert.equal(loaded.unavailableStartup, f.target); assert.equal(loaded.dshHome, f.home)
  assert.equal((await f.settings.read()).startup, f.target, 'the saved choice is not overwritten')
  await rename(f.target + '-unmounted', f.target)
  assert.deepEqual(await f.settings.load(f.current), {startup: f.target, dshHome: f.home})
  await writeFile(f.settings.path, '{broken')
  const kept = await f.settings.reset(new Date('2026-11-07T01:02:03.004Z'))
  assert.equal(kept, f.settings.path + '.corrupt-2026-11-07T01-02-03-004Z')
  assert.equal(await readFile(kept, 'utf8'), '{broken')
  assert.deepEqual(await f.settings.load(f.current), {startup: f.startup, dshHome: f.home})
})

test('desktop directory URLs accept only fixed pathless actions with a nonce', () => {
  const nonce = 'a'.repeat(32)
  assert.deepEqual(directoryAction('fig-settings://directory/dshHome/' + nonce), {kind: 'dshHome', nonce})
  for (const value of ['fig-settings://directory/dshHome', 'fig-settings://directory/dshHome/', 'fig-settings://directory/dshHome/' + 'A'.repeat(32),
    'fig-settings://directory/dshHome/' + nonce + '/x', 'fig-settings://directory/dshHome/' + nonce + '?path=/tmp', 'fig-settings://directory/startup/' + nonce + '#x',
    'fig-settings://directory/%73tartup/' + nonce, 'https://directory/startup/' + nonce, 'fig-settings://directory/../../tmp/' + nonce]) assert.equal(directoryAction(value), undefined, value)
})

test('a directory action nonce is accepted once, and only the one last issued', () => {
  const nonce = new DirectoryNonce()
  assert.equal(nonce.consume('a'.repeat(32)), false, 'nothing issued yet')
  const first = nonce.issue(), second = nonce.issue()
  assert.match(second, /^[a-f0-9]{32}$/)
  assert.equal(nonce.consume(first), false, 'a superseded nonce')
  for (const value of [undefined, '', second.slice(1), second.toUpperCase(), 'b'.repeat(32)]) assert.equal(nonce.consume(value), false)
  assert.equal(nonce.consume(second), true)
  assert.equal(nonce.consume(second), false, 'a reused nonce')
})

test('an unsupported release or registry format fails before confirmation and before DSH stops', async t => {
  const f = await fixture(t), original = await workspaceFixture(f.home, f.startup), path = join(f.home, 'storages/workspace.json')
  const events: string[] = []
  const deps = {settings: f.settings, current: f.current, release: verifiedDsh[0], valid: () => true, defaultWorkspace: async () => f.startup,
    idle: async () => true, choose: async () => ({canceled: false, filePaths: [f.target]}),
    confirm: async () => {events.push('confirm'); return {response: 0}},
    stop: async () => {events.push('stop')}, resume: async () => {events.push('resume')}, restart: () => {events.push('restart')}}
  await assert.rejects(configureDirectory('defaultWorkspace', {...deps, release: '9.0.0'}), /WORKSPACE_FORMAT_UNSUPPORTED/)
  await writeRecord(path, {...original, unit: {name: 'workspace', version: 99}}); const before = await readFile(path)
  await assert.rejects(configureDirectory('defaultWorkspace', deps), /WORKSPACE_FORMAT_UNSUPPORTED/)
  assert.deepEqual(events, []); assert.deepEqual(await readFile(path), before)
  await writeRecord(path, original)
  await configureDirectory('defaultWorkspace', deps)
  assert.deepEqual(events, ['confirm', 'stop', 'restart'])
})

test('native migration warning defaults to cancel; cancellation and active tasks never stop the service', async t => {
  const f = await fixture(t), events: string[] = []
  const deps = {settings: f.settings, current: f.current, release: launchDsh, valid: () => true, defaultWorkspace: async () => f.startup,
    idle: async () => true, choose: async () => ({canceled: false, filePaths: [f.target]}), confirm: async (options: any) => {
      assert.equal(options.type, 'warning'); assert.equal(options.defaultId, 1); assert.match(options.detail, /旧目录保留/); return {response: 1}
    }, stop: async () => {events.push('stop')}, resume: async () => {events.push('resume')}, restart: () => {events.push('restart')}}
  await configureDirectory('dshHome', deps)
  assert.deepEqual(events, []); assert.equal((await f.settings.read()).dshHome, undefined)
  await assert.rejects(configureDirectory('dshHome', {...deps, idle: async () => false, choose: async () => {throw Error('must not open chooser')}}), /TASKS_RUNNING/)
  let reads = 0
  await assert.rejects(configureDirectory('dshHome', {...deps, idle: async () => ++reads === 1, confirm: async () => ({response: 0})}), /TASKS_RUNNING/)
  assert.deepEqual(events, [])
})

test('confirmed migration stops before copying; failures resume only a successfully stopped service', async t => {
  const f = await fixture(t), events: string[] = []
  const settings = new DirectorySettings(f.userData, async (source, target, options) => {assert.deepEqual(events, ['stop']); events.push('copy'); await copyDirectoryContents(source, target, options)})
  const deps = {settings, current: f.current, release: launchDsh, valid: () => true, defaultWorkspace: async () => f.startup,
    idle: async () => true, choose: async () => ({canceled: false, filePaths: [f.target]}), confirm: async () => ({response: 0}),
    stop: async () => {events.push('stop')}, resume: async () => {events.push('resume')}, restart: () => {events.push('restart')}}
  await configureDirectory('dshHome', deps)
  assert.deepEqual(events, ['stop', 'copy', 'restart'])
  const other = await fixture(t), failed: string[] = []
  const failing = {...deps, settings: new DirectorySettings(other.userData, async () => {throw Error('copy failure')}), current: other.current,
    choose: async () => ({canceled: false, filePaths: [other.target]}), stop: async () => {failed.push('stop')}, resume: async () => {failed.push('resume')}, restart: () => {failed.push('restart')}}
  await assert.rejects(configureDirectory('dshHome', failing)); assert.deepEqual(failed, ['stop', 'resume'])
  failed.length = 0
  await assert.rejects(configureDirectory('dshHome', {...failing, stop: async () => {throw Error('cannot stop')}}))
  assert.deepEqual(failed, [])
  await assert.rejects(configureDirectory('dshHome', {...failing, settle: async () => {throw Error('writer still in flight')}}))
  assert.deepEqual(failed, ['stop', 'resume'])
})

test('the extra skill folder is set and cleared through confirmed native actions, in a file of its own', async t => {
  const f = await fixture(t), events: string[] = []
  const skills = join(f.base, 'skills'); await mkdir(skills)
  const deps = {settings: f.settings, current: f.current, release: launchDsh, valid: () => true, defaultWorkspace: async () => f.startup,
    idle: async () => true, choose: async () => ({canceled: false, filePaths: [skills]}),
    confirm: async (options: any) => {events.push('confirm:' + options.buttons[0]); assert.equal(options.defaultId, 1); return {response: 0}},
    stop: async () => {events.push('stop')}, resume: async () => {events.push('resume')}, restart: () => {events.push('restart')}}
  assert.equal(await f.settings.readSkillDirectory(), undefined)
  await configureDirectory('clearSkillDirectory', deps)
  assert.deepEqual(events, [], 'nothing to clear asks nothing and stops nothing')
  await configureDirectory('skillDirectory', deps)
  assert.deepEqual(events, ['confirm:保存并重启', 'stop', 'restart'])
  assert.equal(await f.settings.readSkillDirectory(), skills)
  // directory-settings.json keeps the schema earlier releases read, so rolling back still opens.
  assert.deepEqual(await f.settings.read(), {schema: 1})
  events.length = 0
  await configureDirectory('clearSkillDirectory', {...deps, choose: async () => {throw Error('clearing never opens a chooser')}})
  assert.deepEqual(events, ['confirm:清除并重启', 'stop', 'restart'])
  assert.equal(await f.settings.readSkillDirectory(), undefined)
  assert.ok((await stat(skills)).isDirectory(), 'the folder itself is never removed')
  await writeFile(f.settings.skills, '{broken')
  assert.equal(await f.settings.readSkillDirectory(), undefined, 'an unreadable file leaves the feature off')
  assert.deepEqual(directoryAction('fig-settings://directory/clearSkillDirectory/' + 'c'.repeat(32)), {kind: 'clearSkillDirectory', nonce: 'c'.repeat(32)})
})
