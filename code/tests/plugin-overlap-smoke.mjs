import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'
import { dshLauncher, testedDsh } from './helpers/dsh-launcher.mjs'

// Threshold ③ e: a plugin that duplicates a Fig feature is pointed out before install (添加插件) and after (the Plugins
// page), and nothing is blocked. Installs @michengai/dsh-btw from the npm registry into an isolated profile.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/plugin-overlap/', import.meta.url))
await mkdir(evidence, { recursive: true })
const launcher = await dshLauncher(await testedDsh())
assert.ok(launcher, 'Build Fig once to cache the DSH under test')
const { profile, dshHome, env } = await isolatedProfile('plugin-overlap')
await promisify(execFile)(process.execPath, [launcher, 'plugin', '--profile', 'web', 'add', '@michengai/dsh-btw'], { env: { ...env, DSH_HOME: dshHome }, cwd: profile, timeout: 300_000 })
// Turning DSH's experimental Forge on from the Plugins page adds its bundle to the profile; do the same here.
const manifestPath = join(dshHome, 'profiles/web/package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-experimental-forge-bundle')
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
let app, passed = false
try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 20000 }).catch(() => {})
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: '插件', exact: true }).first().click()
  const banner = page.locator('[data-fig-overlap-banner]')
  await banner.and(page.locator(':visible')).waitFor({ timeout: 20000 })
  assert.match(await banner.innerText(), /@michengai\/dsh-btw（侧边聊天）/)
  assert.match(await banner.innerText(), /@deepseek-ai\/dsh-experimental-forge-bundle（研发工作台，部分重复）/)
  await page.screenshot({ path: join(evidence, 'plugins-banner.png') })
  await page.getByRole('button', { name: /添加插件/ }).first().click()
  const dialog = page.locator('[role="dialog"]').last()
  const field = dialog.locator('input').first()
  const hint = dialog.locator('[data-fig-overlap-hint]')
  await field.fill('dsh-keep-awake@1.0.0')
  await hint.and(page.locator(':visible')).waitFor({ timeout: 5000 })
  assert.equal(await hint.innerText(), 'Fig 已内置运行时防止休眠，不建议再装 dsh-keep-awake，两者功能重复。')
  assert.ok(await dialog.getByRole('button', { name: '安装', exact: true }).isEnabled(), 'Only a reminder: installing stays possible')
  await page.screenshot({ path: join(evidence, 'add-hint.png') })
  await field.fill('dsh-everforest')
  assert.equal(await hint.isVisible(), false, 'No reminder for a plugin Fig does not duplicate')
  passed = true
} finally {
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
console.log('PASS: plugin overlap reminders')
