import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from './helpers/temp-dir.mjs'

test('settings open only the three fixed folders', async t => {
  const home = await tempDir(t, 'fig-settings-home-')
  const workspace = await tempDir(t, 'fig-settings-ws-')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(home, 'storages'))
  const record = { path: workspace, title: 'w', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 }, global: { initialized: true, defaultWorkspaceId: 'w', workspaceIds: ['w'] }, tables: { workspaces: { w: record } }
  }))
  const opened = []
  const { settingsService } = await import('../harness/desktop-skin/settings.js')
  const { verifiedDsh } = await import('../harness/dsh-versions.ts')
  const version = async () => verifiedDsh[0]
  const settings = settingsService({ home, startup: tmpdir(), open: async path => { opened.push(path) }, version })
  const { dsh, ...info } = await settings.info()
  assert.deepEqual(info, { startup: tmpdir(), defaultWorkspace: workspace, dshHome: home, nodeVersion: process.version })
  assert.equal(dsh.latest, undefined, 'no npm latest noted yet')
  await mkdir(join(home, 'fig'))
  await writeFile(join(home, 'fig/dsh-latest.json'), JSON.stringify({ latest: '9.9.9-rc.1' }))
  assert.deepEqual((({ latest, latestVerified }) => ({ latest, latestVerified }))((await settings.info()).dsh), { latest: '9.9.9-rc.1', latestVerified: false })
  for (const kind of ['startup', 'defaultWorkspace', 'dshHome']) await settings.open(kind)
  assert.deepEqual(opened, [tmpdir(), workspace, home])
  await assert.rejects(settings.open('/tmp'))
  await assert.rejects(settings.open(undefined))
  // The registry is read only on a release Fig verified, as the native default-workspace change does.
  const unverified = settingsService({ home, startup: tmpdir(), open: async () => {}, version: async () => '9.0.0' })
  assert.equal((await unverified.info()).defaultWorkspace, undefined)
  const empty = settingsService({ home: workspace, startup: tmpdir(), open: async () => {}, version })
  assert.equal((await empty.info()).defaultWorkspace, undefined)
  await assert.rejects(empty.open('defaultWorkspace'))
  // The extra skill folder shows and opens only when one is set.
  await assert.rejects(settings.open('skillDirectory'))
  const skills = settingsService({ home, startup: tmpdir(), skillDirectory: workspace, open: async path => { opened.push(path) }, version })
  assert.equal((await skills.info()).skillDirectory, workspace)
  await skills.open('skillDirectory')
  assert.equal(opened.at(-1), workspace)
})

test('the first-use workspace is claimed under the startup directory, and only for a start by Fig', async () => {
  const { claimDefaultWorkspace } = await import('../harness/desktop-skin/index.js')
  const asked = []
  const registry = { initializeDefault: async resolve => { asked.push(await resolve()); return { id: 'w' } } }
  assert.deepEqual(await claimDefaultWorkspace(registry, '/Users/x/Fig'), { id: 'w' })
  assert.deepEqual(asked, ['/Users/x/Fig/default-workspace'])
  assert.equal(await claimDefaultWorkspace(registry, undefined), undefined, 'no startup directory, nothing claimed')
  assert.equal(await claimDefaultWorkspace({}, '/Users/x/Fig'), undefined, 'a DSH without the method')
  assert.equal(asked.length, 1)
  const warnings = []
  assert.equal(await claimDefaultWorkspace({ initializeDefault: async () => { throw new Error('EACCES') } }, '/Users/x/Fig', { warn: line => warnings.push(line) }), undefined)
  assert.match(warnings[0], /EACCES/)
})
