import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'

// Threshold ③ a: DSH's experimental plugins switch on and off on the Plugins page inside Fig, take effect at once and
// stay that way across a restart. A switch selects or deselects an official bundle in the Web profile's package.json.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/plugin-toggle/', import.meta.url))
await mkdir(evidence, { recursive: true })
// The bundle each switch selects is read from the profile, not assumed.
// AgentTeam (智能体团队) left the experimental list in DSH 0.2.2-rc.2; 自动授权审查 is experimental in rc.1 and rc.5.
const plugins = [{ title: '自定义插件索引', bundle: '' }, { title: '自动授权审查', bundle: '' }]
const { profile, dshHome, env } = await isolatedProfile('plugin-toggle')
const bundles = async () => JSON.parse(await readFile(join(dshHome, 'profiles/web/package.json'), 'utf8')).dsh.profile.bundles
let app, passed = false

/** Starts Fig on the same profile and opens the Plugins page. */
async function openPlugins() {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 20000 }).catch(() => {})
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: '插件', exact: true }).first().click()
  await page.getByRole('switch', { name: `启用 ${plugins[0].title}` }).waitFor({ timeout: 20000 })
  return page
}
const state = (page, title) => page.getByRole('switch', { name: `启用 ${title}` }).getAttribute('aria-checked')
const discover = page => page.getByText('发现', { exact: true }).count()

try {
  let page = await openPlugins()
  for (const { title } of plugins) assert.equal(await state(page, title), 'false', `${title} starts off`)
  assert.equal(await discover(page), 0)
  // On, at once.
  for (const plugin of plugins) {
    const before = await bundles()
    await page.getByRole('switch', { name: `启用 ${plugin.title}` }).click()
    const added = await until(async () => {
      const now = await bundles()
      const extra = now.filter(item => !before.includes(item))
      return extra.length === 1 && extra[0]
    }, { timeout: 60000, message: `${plugin.title} selected no bundle` })
    assert.match(added, /^@deepseek-ai\//, 'An official bundle')
    plugin.bundle = added
  }
  await until(async () => await discover(page) > 0, { timeout: 30000, message: '发现 did not appear' })
  for (const { title } of plugins) await until(async () => await state(page, title) === 'true', { timeout: 20000, message: `${title} switch did not show on` })
  console.log('Bundles:', plugins.map(plugin => `${plugin.title} → ${plugin.bundle}`).join(', '))
  await page.screenshot({ path: join(evidence, 'on.png') })
  await app.close()
  // Still on after a restart.
  page = await openPlugins()
  for (const { title } of plugins) assert.equal(await state(page, title), 'true', `${title} stays on`)
  assert.ok(await discover(page) > 0, '发现 stays')
  // Off, and still off after a restart.
  for (const { title } of plugins) await page.getByRole('switch', { name: `启用 ${title}` }).click()
  for (const { bundle } of plugins) await until(async () => !(await bundles()).includes(bundle), { timeout: 60000, message: `${bundle} still selected` })
  await app.close()
  page = await openPlugins()
  for (const { title } of plugins) assert.equal(await state(page, title), 'false', `${title} stays off`)
  assert.equal(await discover(page), 0, '发现 is gone')
  await page.screenshot({ path: join(evidence, 'off.png') })
  passed = true
} finally {
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
console.log('PASS: experimental plugins switch on and off and keep their state across restarts')
