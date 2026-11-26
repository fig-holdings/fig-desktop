import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {DirectorySettings} from '../app/main/directory-settings'
import {planStartup, suggestedStartup} from '../app/main/startup-directory'
import { tempDir } from './helpers/temp-dir.mjs'

async function fixture(t: any) {
  const base = await realpath(await tempDir(t, 'fig-startup-test-'))
  const home = join(base, 'home'), userData = join(base, 'desktop')
  await mkdir(home); await mkdir(userData)
  return {home, settings: new DirectorySettings(userData)}
}

test('a new user is asked, with ~/Fig suggested, even when an earlier Workspace folder and a DSH home exist', async t => {
  const f = await fixture(t)
  assert.deepEqual(await planStartup(f.settings, f), {kind: 'choose', suggested: join(f.home, 'Fig')})
  await mkdir(join(f.home, 'Documents/Workspace/resources/skills'), {recursive: true}); await mkdir(join(f.home, '.fig'))
  assert.deepEqual(await planStartup(f.settings, f), {kind: 'choose', suggested: join(f.home, 'Fig')}, 'the pre-0.1.41 layout is no longer adopted')
  assert.equal(suggestedStartup(f.home), join(f.home, 'Fig'))
})

test('a saved startup folder is left to DirectorySettings, even when it is missing', async t => {
  const f = await fixture(t)
  await f.settings.saveStartup('/Volumes/gone/work')
  assert.deepEqual(await planStartup(f.settings, f), {kind: 'saved'})
})
