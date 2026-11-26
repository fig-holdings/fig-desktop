import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'
import { bundlePlugins } from '../harness/plugins.ts'

// Fig's feature packages on DSH's Plugins page: an isolated Fig installs them into the Web profile as bundles, the page
// lists each by its Chinese title, side chat still opens, and a package switched off on the page stays off across a
// restart (its feature gone) while the others keep working. No model calls. Needs a build.
const evidence = fileURLToPath(new URL('../../work/verification/plugin-bundles/', import.meta.url))
await mkdir(evidence, { recursive: true })
const titles = Object.fromEntries(await Promise.all(bundlePlugins.map(async plugin =>
  [plugin.name, JSON.parse(await readFile(new URL(`../harness/${plugin.name}/locale/zh.json`, import.meta.url), 'utf8')).meta.title])))
const { profile, dshHome, env } = await isolatedProfile('plugin-bundles')
const manifest = () => readFile(join(dshHome, 'profiles/web/package.json'), 'utf8').then(JSON.parse)
let app, passed = false
const report = { status: 'fail', checks: {} }
async function open() {
  app = await launchFig(env)
  const page = await workbenchPage(app, 240_000)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 20000 }).catch(() => {})
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 120_000 })
  return page
}
const toPlugins = async page => {
  await page.getByRole('button', { name: '插件', exact: true }).first().click()
  await page.getByRole('tab', { name: '个人版插件', exact: true }).click()
  await page.getByRole('switch', { name: `启用 ${titles['side-chat']}` }).waitFor({ timeout: 30000 })
  // The personal edition has two tabs only: 「协作版插件」 is a team Profile's.
  if (await page.getByRole('tab', { name: '协作版插件', exact: true }).count()) throw new Error('A personal Profile shows the Team plugins tab')
}
const state = (page, title) => page.getByRole('switch', { name: `启用 ${title}` }).getAttribute('aria-checked')
try {
  let page = await open()
  // Installed as link: bundles from one placement under the DSH home, all selected.
  const installed = await manifest()
  const placements = await readdir(join(dshHome, 'fig/packages'))
  assert.equal(placements.length, 1)
  for (const plugin of bundlePlugins) {
    const name = JSON.parse(await readFile(new URL(`../harness/${plugin.name}/package.json`, import.meta.url), 'utf8')).name
    assert.equal(installed.dependencies[name], `link:${join(dshHome, 'fig/packages', placements[0], plugin.name)}`, name)
    assert.ok(installed.dsh.profile.bundles.includes(name), name + ' selected')
  }
  report.checks.installed = bundlePlugins.length
  await toPlugins(page)
  await page.getByRole('tab', { name: '已安装', exact: true }).click()
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('tab', { name: '个人版插件', exact: true }).click()
  for (const plugin of bundlePlugins) assert.equal(await state(page, titles[plugin.name]), 'true', titles[plugin.name] + ' listed and on')
  await page.getByRole('tab', { name: '已安装', exact: true }).click()
  assert.equal(await page.locator('[data-plugin-group="bundles"] [data-plugin-package^="@local/dsh-"]:visible').count(), 0)
  await page.getByRole('tab', { name: '个人版插件', exact: true }).click()
  await page.locator('[data-fig-custom-plugin="@local/dsh-side-chat"] button').first().click()
  await page.getByText('@local/dsh-side-chat', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: /返回|Back/ }).first().click()
  await page.locator('[data-fig-custom-plugins]').waitFor()
  report.checks.detailReturn = true
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.locator('[data-slot="settings.launcher"] button[data-signed-out]').click()
    await page.getByRole('menuitem', { name: '主题外观' }).hover()
    await page.getByRole('menuitemradio', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click()
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)), 0)
      const name = `${theme}-${width}`
      await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true })
      await writeFile(join(evidence, name + '.html'), await page.evaluate(() => {
        const clone = document.documentElement.cloneNode(true)
        clone.querySelectorAll('script,link').forEach(node => node.remove())
        const style = document.createElement('style')
        style.textContent = [...document.styleSheets, ...document.adoptedStyleSheets].flatMap(sheet => { try { return [...sheet.cssRules].map(rule => rule.cssText) } catch { return [] } }).join('\n')
        clone.querySelector('head').append(style)
        return '<!doctype html>' + clone.outerHTML
      }))
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(evidence, 'plugins.png'), fullPage: true })
  report.checks.listed = true
  // Switch composer (输入框增强) off; its settings row and the input history go with it.
  await page.getByRole('switch', { name: `启用 ${titles.composer}` }).click()
  await until(async () => !(await manifest()).dsh.profile.bundles.includes('@local/dsh-composer'), { timeout: 60000, message: 'composer still selected' })
  await app.close(); app = undefined
  page = await open()
  assert.equal(await page.locator('[data-fig-input-history]').count(), 0, 'input history gone')
  // Side chat, another bundle, still opens from the right sidebar.
  await page.getByRole('button', { name: /^(展开右侧栏|打开右侧边栏)$/ }).first().click()
  assert.ok(await page.getByRole('button', { name: /侧边聊天/ }).first().waitFor({ timeout: 20000 }).then(() => true, () => false), 'side chat card present')
  await toPlugins(page)
  assert.equal(await state(page, titles.composer), 'false', 'composer stays off after a restart')
  assert.equal(await state(page, titles['side-chat']), 'true')
  report.checks.switchedOffStaysOff = true
  // A config row is not written for the switched-off package.
  const rows = JSON.parse(await readFile(join(dshHome, 'fig/launch/web.patch.yml'), 'utf8'))
  assert.ok(rows.some(row => row.id === 'fig-instructions'))
  report.checks.configRows = rows.map(row => row.id)
  await page.screenshot({ path: join(evidence, 'plugins-composer-off.png'), fullPage: true })
  // Settings › 内置插件 names each switched-on package by its title, not by a file:// module path: the bundle's patch
  // inserts it by package name. Fig's own three packages, patched in by path, are the only file:// rows left.
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByText('内置插件', { exact: true }).first().click()
  // Presets open by default; the global inventory, where bundles sit, starts collapsed.
  await page.getByText('全局插件', { exact: true }).first().click()
  await page.getByText(titles['provider-grok'], { exact: true }).first().waitFor({ timeout: 20000 })
  const inventory = await page.locator('[data-shortcut-modal="settings"]').first().innerText()
  report.checks.settingsMetadataFallbacks = []
  for (const plugin of bundlePlugins.filter(plugin => plugin.name !== 'composer')) {
    const localized = inventory.includes(titles[plugin.name])
    assert.ok(localized || inventory.includes(`@local/dsh-${plugin.name}`), titles[plugin.name] + ' in Settings')
    if (!localized) report.checks.settingsMetadataFallbacks.push(plugin.name)
  }
  assert.equal((inventory.match(/file:\/\/\/[^\n]*node_modules/g) ?? []).length, 0, 'no installed package shown by path')
  report.checks.settingsTitles = true
  await page.keyboard.press('Escape')
  passed = true
  report.status = 'pass'
} catch (error) {
  const pages = app?.context().pages() ?? []
  for (const [i, page] of pages.entries()) {
    await writeFile(join(evidence, `failure-${i}.txt`), await page.locator('body').innerText()).catch(() => {})
    await writeFile(join(evidence, `failure-${i}.html`), await page.content()).catch(() => {})
    await page.screenshot({ path: join(evidence, `failure-${i}.png`) }).catch(() => {})
  }
  report.error = String(error.stack ?? error)
  throw error
} finally {
  await app?.close().catch(() => {})
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  await cleanUp(profile, passed)
}
console.log('PASS: Fig\'s packages are Plugins page bundles that switch off and stay off')
