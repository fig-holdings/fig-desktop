import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { writePluginConfig } from '../app/main/plugin-config'
import { figPlugins } from '../harness/plugins'
import { tempDir } from './helpers/temp-dir.mjs'

test('plugin settings reach the packages as config rows, never as environment variables', async t => {
  const home = await tempDir(t, 'fig-plugin-config-')
  const web = await writePluginConfig(home, { startupDirectory: '/start', skillDirectory: '/skills', previewRenderer: { executable: '/Fig', args: [] } })
  assert.equal(web, join(home, 'fig/launch/web.patch.yml'))
  assert.equal((await stat(web)).mode & 0o777, 0o600)
  const rows = parse(await readFile(web, 'utf8'))
  const config = (id: string) => rows.find((row: any) => row.id === id)?.config
  // Every row names a package Fig loads, so none is a stray entry DSH would warn about.
  const ids = new Set(figPlugins.map(plugin => plugin.id))
  for (const row of rows) assert.ok(ids.has(row.id), row.id)
  assert.deepEqual(config('fig-desktop-skin'), { startupDirectory: '/start', skillDirectory: '/skills' }, 'no previous data folder: none passed')
  assert.deepEqual(config('fig-rule-sources'), { startupDirectory: '/start' })
  assert.deepEqual(config('fig-instructions'), { startupDirectory: '/start' })
  assert.deepEqual(config('fig-skills'), { directory: '/skills' })
  assert.deepEqual(config('fig-shell-bridge'), { renderer: { executable: '/Fig', args: [] } })
  assert.equal(config('fig-session'), undefined, 'handoff takes no settings')
  // Unset settings leave the config empty; the next start rewrites the files.
  await writePluginConfig(home, { startupDirectory: '/start' })
  const again = parse(await readFile(web, 'utf8'))
  assert.deepEqual(again.find((row: any) => row.id === 'fig-skills').config, {})
})

test('the Profile reaches shell-bridge only as its validated public facts', async t => {
  const home = await tempDir(t, 'fig-plugin-config-')
  const profile = { id: 'p1', edition: 'team' as const, dshGeneration: 3, shell: { pluginMenuActions: false }, plugins: [], coworkOrigin: 'https://cowork.test' }
  const rows = parse(await readFile(await writePluginConfig(home, { startupDirectory: '/start', profile }), 'utf8'))
  assert.deepEqual(rows.find((row: any) => row.id === 'fig-shell-bridge').config, { profile: { id: 'p1', edition: 'team', dshGeneration: 3 }, coworkOrigin: 'https://cowork.test' })
})
