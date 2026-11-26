import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'

// Fig offers Chinese and English. The Language menu lists only those two; switching in DSH switches Fig's own
// menu at once, and the next start opens the startup page in that language. Fig's page plugins read their text from
// DSH's locale service (shared/page-locale.js): labels from four of them follow both ways without a reload.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/language/', import.meta.url))
await mkdir(evidence, { recursive: true })
const { profile, env, dshHome } = await isolatedProfile('language')
let app, passed = false
const settingsLabel = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').label)
// attention, provider-grok, provider-chatgpt and desktop-skin, in the settings navigation.
const pluginLabels = { zh: ['任务动态', 'Grok 账号', 'ChatGPT 账号', '运行环境'], en: ['Task activity', 'Grok account', 'ChatGPT account', 'Runtime'] }
const navLabels = page => page.locator('nav button, [role="navigation"] button').allTextContents()
const showsLabels = async (page, labels) => { const shown = await navLabels(page); return labels.every(label => shown.includes(label)) }
try {
  app = await launchFig(env)
  let page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30000 }).catch(() => {})
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 30000 })
  assert.equal(await settingsLabel(), '设置…')
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('heading', { name: '运行环境', exact: true }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: '通用设置', exact: true }).click()
  assert.ok(await showsLabels(page, pluginLabels.zh), 'Fig plugins start in Chinese: ' + (await navLabels(page)).join(', '))
  await page.evaluate(() => { window.__figLanguageSmoke = true })
  await page.locator('button[aria-haspopup="menu"]', { hasText: '中文' }).first().click()
  const menu = page.getByRole('menu').last()
  await menu.getByRole('menuitem', { name: 'English' }).waitFor()
  assert.deepEqual(await menu.getByRole('menuitem').evaluateAll(items => items.filter(item => item.checkVisibility()).map(item => item.textContent.trim())),
    ['中文', 'English'], 'Only Chinese and English are offered')
  await page.screenshot({ path: join(evidence, 'language-menu.png') })
  await menu.getByRole('menuitem', { name: 'English' }).click()
  await page.getByRole('button', { name: 'General', exact: true }).waitFor({ timeout: 10000 })
  await until(async () => await settingsLabel() === 'Settings…', { timeout: 10000, message: 'The app menu did not switch to English' })
  await until(() => showsLabels(page, pluginLabels.en), { timeout: 10000, message: 'Fig plugins did not switch to English' })
  await page.screenshot({ path: join(evidence, 'plugins-en.png') })
  // And back, still without a reload.
  await page.locator('button[aria-haspopup="menu"]', { hasText: 'English' }).first().click()
  await page.getByRole('menu').last().getByRole('menuitem', { name: '中文' }).click()
  await until(() => showsLabels(page, pluginLabels.zh), { timeout: 10000, message: 'Fig plugins did not switch back to Chinese' })
  await page.locator('button[aria-haspopup="menu"]', { hasText: '中文' }).first().click()
  await page.getByRole('menu').last().getByRole('menuitem', { name: 'English' }).click()
  await until(() => showsLabels(page, pluginLabels.en), { timeout: 10000, message: 'Fig plugins did not switch to English again' })
  assert.equal(await page.evaluate(() => window.__figLanguageSmoke), true, 'The page switched without a reload')
  // Fig's own settings section follows too.
  await page.getByRole('button', { name: 'Runtime', exact: true }).click()
  await page.getByRole('heading', { name: 'Runtime', exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, 'runtime-en.png') })
  // DSH stores the choice in the Web profile patch a second or more later; quitting before that keeps the old one.
  await until(async () => /preference: en\b/.test(await readFile(join(dshHome, 'profiles/web/cordis.patch.yml'), 'utf8').catch(() => '')),
    { timeout: 15000, message: 'DSH did not store the English preference' })
  await app.close()

  app = await launchFig(env)
  const startup = await app.firstWindow()
  await until(() => startup.evaluate(() => document.documentElement.lang === 'en'), { timeout: 15000, message: 'The startup page did not open in English' })
  assert.equal(await settingsLabel(), 'Settings…', 'The menu starts in the stored language')
  page = await workbenchPage(app)
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 30000 })
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en')
  passed = true
} finally {
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
console.log('PASS: language')
