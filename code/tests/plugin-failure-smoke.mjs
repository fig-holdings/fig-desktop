import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'
import { dshLauncher, testedDsh } from './helpers/dsh-launcher.mjs'

// A user plugin whose page part fails no longer blocks DSH's workbench (from 0.2.2-rc.2): it opens with the plugin still
// selected and Fig's startup page stays hidden. The 0.2.2-rc.1 recovery path (Fig's page turning the plugin off) is
// tested at tag dsh-compat/0.2.2-rc.1.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/plugin-failure/', import.meta.url))
await mkdir(evidence, { recursive: true })
const launcher = await dshLauncher(await testedDsh())
assert.ok(launcher, 'Build Fig once to cache the DSH under test')
const { profile, dshHome, env } = await isolatedProfile('plugin-failure')
const fixture = join(profile, 'broken-plugin')
await cp(fileURLToPath(new URL('./fixtures/broken-plugin', import.meta.url)), fixture, { recursive: true })
await promisify(execFile)(process.execPath, [launcher, 'plugin', '--profile', 'web', 'add', 'file:' + fixture], { env: { ...env, DSH_HOME: dshHome }, cwd: profile })
const manifest = () => readFile(join(dshHome, 'profiles/web/package.json'), 'utf8').then(JSON.parse)
assert.ok((await manifest()).dsh.profile.bundles.includes('fig-broken-probe'))
let app, passed = false
try {
  app = await launchFig(env)
  const startup = await app.firstWindow()
  const page = await workbenchPage(app, 180_000)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 20000 }).catch(() => {})
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 120_000 })
  await page.screenshot({ path: join(evidence, 'unblocked.png') })
  assert.ok((await manifest()).dsh.profile.bundles.includes('fig-broken-probe'), 'Left selected: nothing needed turning off')
  assert.equal(await startup.evaluate(() => document.querySelector('main')?.hidden), true, 'Fig\'s startup page stays hidden')
  console.log('PASS: an optional plugin\'s page failure does not block the workbench')
  passed = true
} finally {
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
