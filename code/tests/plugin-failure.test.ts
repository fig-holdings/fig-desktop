import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { bundlesFor, describeFailure, failedPlugins, inactiveEntries } from '../app/main/plugin-failure'
import { deselectBundles, selectBundles } from '../app/main/web-profile'
import { tempDir } from './helpers/temp-dir.mjs'

// The lines DSH's boot card shows under "Failed to load plugins".
const card = ['fig-broken-probe', '@scope/theme/client', 'web boot: 2 entries did not activate', 'fig-broken-probe: import failed (see console for the import error)']

test('failed entries are the package-shaped lines of the boot card, not its error text', () => {
  assert.deepEqual(failedPlugins(card), ['fig-broken-probe', '@scope/theme/client'])
})

test('only the user\'s bundles that own a failed entry may be turned off, never DSH\'s own', () => {
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'fig-broken-probe', '@scope/theme', 'dshmarket']
  assert.deepEqual(bundlesFor(['fig-broken-probe', '@scope/theme/client', '@deepseek-ai/dsh-web-app'], bundles), ['fig-broken-probe', '@scope/theme'])
  assert.deepEqual(bundlesFor(['@scope/theme-extra'], bundles), [], 'A name that only starts like a bundle is not that bundle')
})

test('turning off deselects the bundles and keeps them installed', async t => {
  const home = await tempDir(t, 'fig-plugin-failure-')
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  const manifest = { name: 'dsh-profile-web', private: true, dependencies: { 'fig-broken-probe': 'file:/x', dshmarket: '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', 'fig-broken-probe'] } } }
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify(manifest))
  assert.deepEqual(await describeFailure(home, card), { plugins: ['fig-broken-probe', '@scope/theme/client'], disablable: ['fig-broken-probe'], required: [] })
  assert.deepEqual(await describeFailure(home, card, new Set(['fig-broken-probe'])), { plugins: ['fig-broken-probe', '@scope/theme/client'], disablable: [], required: ['fig-broken-probe'] },
    'A required plugin is never offered for turning off')
  assert.deepEqual(await deselectBundles(home, ['fig-broken-probe', '@deepseek-ai/dsh-base']), ['fig-broken-probe'])
  const written = await readFile(join(home, 'profiles/web/package.json'), 'utf8')
  const after = JSON.parse(written)
  assert.equal(written, JSON.stringify(after, null, 2) + '\n', 'Written as DSH writes it: two-space JSON')
  assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])
  assert.deepEqual(after.dependencies, manifest.dependencies, 'The packages stay installed')
  assert.deepEqual(await deselectBundles(home, ['fig-broken-probe']), [], 'Nothing left to turn off')
  assert.deepEqual(await selectBundles(home, ['fig-broken-probe', 'not-installed']), ['fig-broken-probe'], 'Only an installed bundle is selected again')
  assert.deepEqual(await selectBundles(home, ['fig-broken-probe']), [])
  assert.deepEqual(await describeFailure(join(home, 'missing'), card), { plugins: ['fig-broken-probe', '@scope/theme/client'], disablable: [], required: [] })
})

test('a DSH 0.2.2-rc.2+ boot warning names the entries that did not activate', () => {
  assert.deepEqual(inactiveEntries('web boot: warning: 1 entry did not activate\nfig-broken-probe: import failed (see console for the import error)'), ['fig-broken-probe'])
  assert.deepEqual(inactiveEntries('web boot: warning: 2 entries did not activate\n@local/dsh-side-chat: import failed\n@local/dsh-side-chat/client: apply failed'),
    ['@local/dsh-side-chat', '@local/dsh-side-chat/client'])
  assert.deepEqual(inactiveEntries('Uncaught Error: fig-broken-probe: deliberate page failure'), [])
  assert.deepEqual(inactiveEntries('web boot: ready'), [])
})
