import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'
import { dshLauncher, testedDsh } from './helpers/dsh-launcher.mjs'

// Threshold ③ c: the market sample (harness/plugin-samples.json) on the DSH release under test, all installed at
// once into an isolated profile. Per plugin: installed, listed on the Plugins page. Overall: the workbench opens
// without a plugin failure, and Fig's settings and side chat entry still work. Runs third-party code; needs the npm
// registry; no credentials and no model calls. scripts/dsh-verify.mjs runs it for every release Fig verifies and
// copies report.md into its report.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/plugin-compat/sample/', import.meta.url))
await mkdir(evidence, { recursive: true })
const { plugins } = JSON.parse(await readFile(new URL('../harness/plugin-samples.json', import.meta.url), 'utf8'))
const version = await testedDsh()
const launcher = await dshLauncher(version)
if (!launcher) throw new Error(`DSH ${version} is not in Fig's npx cache; build Fig with it first`)
const { profile, dshHome, env } = await isolatedProfile('plugin-compat')
const run = promisify(execFile)
const rows = plugins.map(plugin => ({ ...plugin, installed: false, listed: false, note: '' }))
const overall = { workbench: false, pluginFailure: '', settings: false, sideChat: false }
let app, passed = false
try {
  for (const row of rows) {
    try {
      await run(process.execPath, [launcher, 'plugin', '--profile', 'web', 'add', row.name], { env: { ...env, DSH_HOME: dshHome }, cwd: profile, timeout: 300_000 })
      const manifest = JSON.parse(await readFile(join(dshHome, 'profiles/web/package.json'), 'utf8'))
      row.installed = Object.hasOwn(manifest.dependencies ?? {}, row.name) && manifest.dsh.profile.bundles.includes(row.name)
      if (!row.installed) row.note = 'not selected after install'
    } catch (error) { row.note = 'install failed: ' + String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ').slice(0, 200) }
  }
  app = await launchFig(env)
  const startup = await app.firstWindow()
  const page = await Promise.race([
    workbenchPage(app, 240_000),
    startup.getByRole('heading', { name: '插件启动失败，工作台没有打开' }).waitFor({ timeout: 240_000 }).then(() => undefined)
  ])
  if (!page) {
    overall.pluginFailure = (await startup.locator('.plugin-list').innerText().catch(() => '')).replace(/\n/g, ', ')
    await startup.screenshot({ path: join(evidence, 'plugin-failure.png') })
  } else {
    await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 20000 }).catch(() => {})
    const editor = page.locator('[data-lexical-editor="true"]').first()
    overall.workbench = await editor.waitFor({ timeout: 120_000 }).then(() => true, () => false)
    await page.screenshot({ path: join(evidence, 'workbench.png') })
    // Fig's side chat from the right sidebar's 开始 page, beside the plugins' tools.
    await editor.click(); await page.keyboard.type('plugin sample probe'); await page.keyboard.press('Enter')
    await page.getByText('plugin sample probe').first().waitFor({ timeout: 20000 }).catch(() => {})
    await page.getByRole('button', { name: '展开右侧栏', exact: true }).first().click().catch(() => {})
    const card = page.getByRole('button', { name: /侧边聊天/ }).first()
    if (await card.waitFor({ timeout: 15000 }).then(() => true, () => false)) {
      await card.click()
      overall.sideChat = await page.locator('[data-fig-side-chat] [data-lexical-editor="true"]').first().waitFor({ timeout: 30000 }).then(() => true, () => false)
    }
    await page.screenshot({ path: join(evidence, 'side-chat.png') })
  }
    // Listed on the Plugins page.
    await page.getByRole('button', { name: '插件', exact: true }).first().click()
    await page.waitForTimeout(4000)
    const listing = await page.locator('main, [data-slot="main"]').first().innerText().catch(() => '')
    // From DSH 0.2.2-rc.2 a card shows the plugin's own title rather than its package name; each card carries its package.
    const cards = new Set(await page.locator('[data-plugin-package]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-plugin-package'))))
    for (const row of rows) row.listed = cards.has(row.name) || listing.includes(row.title) || listing.includes(row.name)
    await page.screenshot({ path: join(evidence, 'plugins.png'), fullPage: true })
    // Fig's settings: a dialog, its own sections next to the plugins' pages.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
    overall.settings = await page.getByRole('heading', { name: '运行环境', exact: true }).waitFor({ timeout: 15000 }).then(() => true, () => false)
      && await page.evaluate(() => { const box = document.querySelector('[data-shortcut-modal="settings"]')?.getBoundingClientRect(); return Boolean(box && box.width === Math.min(960, innerWidth - 64) && box.height === Math.min(720, innerHeight - 80)) })
    await page.screenshot({ path: join(evidence, 'settings.png') })
    await page.keyboard.press('Escape')
  passed = rows.every(row => row.installed && row.listed) && overall.workbench && overall.settings && overall.sideChat
} finally {
  await app?.close().catch(() => {})
  const yes = value => value ? '是' : '否'
  const report = [
    `### 插件样本兼容（DSH ${version}）`, '',
    `结果：${passed ? '通过' : '未通过'}。工作台打开：${yes(overall.workbench)}${overall.pluginFailure ? `（插件启动失败：${overall.pluginFailure}）` : ''}；Fig 设置弹窗：${yes(overall.settings)}；侧边聊天入口：${yes(overall.sideChat)}。`, '',
    '| 插件 | 类型 | 装上并启用 | 插件页列出 | 说明 |', '| --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.name} | ${row.kind} | ${yes(row.installed)} | ${yes(row.listed)} | ${row.note} |`), ''
  ].join('\n')
  await writeFile(join(evidence, 'report.md'), report)
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ version, passed, overall, plugins: rows }, null, 2))
  console.log(report)
  await cleanUp(profile, passed)
}
if (!passed) process.exit(1)
console.log('PASS: plugin sample')
