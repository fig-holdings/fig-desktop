import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'

// DSH's Plugins page in Fig: 添加插件 installs a market plugin (its lookup used to fail with npm 12, see
// app/main/pnpm-shim.ts), 立即启用 turns it on, the row switch turns it off, and its page removes it.
// Needs the npm registry.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/plugin-install/', import.meta.url))
await mkdir(evidence, { recursive: true })
const plugin = 'dsh-everforest', title = 'Everforest'
const { profile, dshHome, env } = await isolatedProfile('plugin-install')
const manifest = () => readFile(join(dshHome, 'profiles/web/package.json'), 'utf8').then(JSON.parse)
const selected = async () => (await manifest()).dsh.profile.bundles.includes(plugin)
const installed = async () => Object.hasOwn((await manifest()).dependencies ?? {}, plugin)
let app, passed = false
try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 20000 }).catch(() => {})
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: '插件', exact: true }).first().click()
  await page.getByRole('button', { name: /添加插件/ }).first().click()
  const dialog = page.locator('[role="dialog"]').last()
  await dialog.locator('input').first().fill(plugin)
  await dialog.getByRole('button', { name: '安装', exact: true }).click()
  await page.getByRole('button', { name: '立即启用' }).waitFor({ timeout: 240_000 })
  assert.ok(await installed(), 'Installed'); assert.ok(!await selected(), 'Not on until 立即启用')
  await page.getByRole('button', { name: '立即启用' }).click()
  await until(selected, { timeout: 30000, message: '立即启用 did not turn it on' })
  await page.keyboard.press('Escape')
  // Turning a theme on recomposes the page; act once its switch shows the new state.
  const toggle = page.getByRole('switch', { name: `启用 ${title}` })
  await until(async () => await toggle.getAttribute('aria-checked').catch(() => null) === 'true', { timeout: 30000, message: 'The switch never showed it on' })
  await page.waitForTimeout(1500)
  for (let attempt = 0; attempt < 3 && await selected(); attempt++) {
    await toggle.click()
    await until(async () => !await selected(), { timeout: 10000, message: 'not yet' }).catch(() => {})
  }
  assert.ok(!await selected(), 'The switch turns it off')
  assert.ok(await installed(), 'Turning off keeps it installed')
  await page.getByRole('button', { name: `查看 ${title}` }).click()
  await page.getByRole('button', { name: /^(卸载|移除)/ }).first().click()
  const confirm = page.locator('[role="dialog"], [role="alertdialog"]').last().getByRole('button', { name: /^(卸载|移除|确认)/ }).last()
  if (await confirm.isVisible().catch(() => false)) await confirm.click()
  await until(async () => !await installed(), { timeout: 120_000, message: 'Removal did not finish' })
  await page.screenshot({ path: join(evidence, 'removed.png') })
  passed = true
} finally {
  if (!passed) await app?.windows().at(-1)?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
console.log('PASS: plugin install, enable, turn off and remove from the Plugins page')
