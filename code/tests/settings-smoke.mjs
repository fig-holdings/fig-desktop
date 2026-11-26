import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanUp, isolatedProfile, launchFig } from '../scripts/isolated-fig.mjs'
import { evidenceDir, openWorkbench } from './helpers/fig-smoke.mjs'

// Runtime keeps directories and versions; General hosts Fig's alerts and composer preferences.
const evidence = await evidenceDir('settings')
const { profile, documents, dshHome, env } = await isolatedProfile('settings', {extraEnv: profile => ({GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: join(profile, 'grok/auth.json')})})
let app, passed = false
try {
  app = await launchFig(env)
  const page = await openWorkbench(app)
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const before = await windows()
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().getMenuItemById('fig-settings')
    if (!item?.accelerator?.endsWith(',')) throw new Error('Missing settings shortcut')
    item.click()
  })
  await page.getByRole('heading', { name: '运行环境', exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await page.getByRole('button', {name: /^(工作区|输入框)$/}).count(), 0, 'Old settings navigation entries are removed')
  for (const name of ['工作区', '运行信息']) await page.getByRole('heading', {name, exact: true}).waitFor()
  for (const name of ['任务提醒', '输入框']) assert.equal(await page.getByRole('heading', {name, exact: true}).count(), 0)
  // General's preferences are not duplicated here; the one switch is the Workspace's parent folder rules.
  const rules = page.getByRole('switch', { name: '上级目录规则' })
  await rules.and(page.locator(':enabled')).waitFor()
  assert.equal(await page.getByRole('switch').count(), 1, 'Runtime has no duplicate preference controls')
  assert.equal(await rules.getAttribute('aria-checked'), 'true', 'Parent folder rules are on by default')
  await page.getByText(/^未设置。DSH 自带的技能目录照常可用。$/).waitFor()
  assert.equal(await page.getByRole('button', { name: '打开额外技能目录' }).isDisabled(), true, 'No extra skill folder to open')
  assert.equal(await page.getByRole('button', { name: '清除额外技能目录' }).count(), 0, 'Nothing to clear')
  await rules.click()
  await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false')
  assert.deepEqual(JSON.parse(await readFile(join(dshHome, 'fig/workspace-instructions.json'), 'utf8')), { schema: 1, enabled: false })
  await rules.click()
  await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true')
  assert.equal(await windows(), before, 'Settings must open inside the workbench, not in a new window')
  // A dialog: 960×720 shrinking with the window, a 56px title row, a 200px list.
  const dialog = await page.evaluate(() => {
    const box = document.querySelector('[data-shortcut-modal="settings"]').getBoundingClientRect()
    const nav = document.querySelector('[data-shortcut-modal="settings"] > nav').getBoundingClientRect()
    const title = document.querySelector('[data-shortcut-modal="settings"] > div:first-child')
    return { width: box.width, height: box.height, left: box.left, top: box.top, navWidth: nav.width, navTop: nav.top - box.top,
      title: title.textContent.trim(), expected: [Math.min(960, innerWidth - 64), Math.min(720, innerHeight - 80)], viewport: [innerWidth, innerHeight] }
  })
  assert.deepEqual([dialog.width, dialog.height], dialog.expected, 'Settings dialog size: ' + JSON.stringify(dialog))
  assert.ok(Math.abs(dialog.left * 2 + dialog.width - dialog.viewport[0]) <= 1, 'Settings dialog is centred')
  assert.equal(dialog.navWidth, 200); assert.equal(dialog.navTop, 56); assert.equal(dialog.title, '设置')
  await page.getByText(documents, { exact: true }).waitFor()
  // macOS reports the temporary folder under /private, so match the end of the path.
  await page.getByText(/fig-settings-\w+\/workspace\/default-workspace$/).waitFor()
  await page.getByRole('button', { name: '打开启动目录' }).and(page.locator(':enabled')).waitFor()
  await page.screenshot({ path: join(evidence, 'workspace.png'), animations: 'disabled' })
  await page.getByText(/fig-settings-\w+\/dsh$/).waitFor()
  await page.getByText(/^v\d+\.\d+\.\d+$/).first().waitFor()
  await page.screenshot({path: join(evidence, 'runtime-light.png'), animations: 'disabled'})
  await page.getByRole('button', {name: '通用设置', exact: true}).click()
  for (const name of ['任务提醒', '输入框']) await page.getByRole('heading', {name, exact: true}).waitFor()
  assert.equal(await page.getByRole('heading', {name: '运行环境', exact: true}).count(), 0)
  assert.equal(await page.getByRole('button', {name: '打开启动目录', exact: true}).count(), 0)
  for (const name of ['外观', '语言']) await page.getByText(name, {exact: true}).first().waitFor()
  const switches = ['后台重要变化通知', 'Dock待处理角标', '下一步提示']
  for (const name of switches) {
    const control = page.getByRole('switch', {name, exact: true})
    await control.and(page.locator(':enabled')).waitFor()
    const checked = await control.isChecked()
    await control.focus()
    await control.press('Space')
    await page.waitForFunction(({name, checked}) => [...document.querySelectorAll('[role="switch"]')].some(el => el.getAttribute('aria-label') === name && el.getAttribute('aria-checked') === String(!checked) && !el.hasAttribute('disabled')), {name, checked})
  }
  const preferences = JSON.parse(await readFile(join(dshHome, 'fig/attention/preferences.json'), 'utf8'))
  assert.equal(preferences.notifications, true)
  assert.equal(preferences.dock, true)
  const hint = page.getByRole('switch', {name: '下一步提示', exact: true})
  const hintChecked = await hint.isChecked()
  await page.route('**/fig-composer/next-step/enable', route => route.fulfill({status: 500, json: {ok: false}}))
  await hint.click()
  await page.getByRole('alert').getByText('无法保存此设置。', {exact: true}).waitFor()
  assert.equal(await hint.isChecked(), hintChecked, 'A failed save preserves the previous setting')
  await page.unroute('**/fig-composer/next-step/enable')
  await hint.click()
  await page.getByRole('alert').waitFor({state: 'detached'})
  const savedHint = !hintChecked
  await hint.and(page.locator(':enabled[aria-checked="' + savedHint + '"]')).waitFor()
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '关闭', exact: true }).click()
  await app.evaluate(({Menu}) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('button', {name: '通用设置', exact: true}).click()
  await hint.and(page.locator(':enabled')).waitFor()
  assert.equal(await hint.isChecked(), savedHint)
  await hint.scrollIntoViewIfNeeded()
  await page.screenshot({path: join(evidence, 'general-preferences-light.png'), animations: 'disabled'})
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => document.documentElement.setAttribute('data-dsw-theme', 'dark'))
  await page.screenshot({ path: join(evidence, 'general-preferences-dark.png'), animations: 'disabled' })
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(760, 540))
  await hint.scrollIntoViewIfNeeded()
  for (const name of switches) {
    const control = page.getByRole('switch', {name, exact: true})
    await control.scrollIntoViewIfNeeded()
    const box = await control.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= 760, 'Switch fits the narrow settings pane')
  }
  await page.screenshot({path: join(evidence, 'general-preferences-narrow.png'), animations: 'disabled'})
  await page.emulateMedia({ colorScheme: 'light' })
  const forbidden = await page.evaluate(async () => (await fetch('/fig-skin/settings/open', {
    method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: 'dshHome' })
  })).status)
  assert.ok([401, 403].includes(forbidden), 'The route must reject a request without the DSH browser session')
  // Esc, the close button and the mask each close it; focus returns to the sidebar's 设置 button.
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
  const modal = page.locator('[data-shortcut-modal="settings"]')
  const opener = page.locator('[data-fig-sidebar-settings]')
  // Opened from the app menu above; the focus check needs it opened from the sidebar.
  await modal.getByRole('button', { name: '关闭', exact: true }).click(); await modal.waitFor({ state: 'detached', timeout: 5000 })
  // Tab and Shift+Tab stay inside the dialog.
  await opener.click(); await modal.waitFor()
  for (const key of [...Array(30).fill('Tab'), ...Array(10).fill('Shift+Tab')]) {
    await page.keyboard.press(key)
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-shortcut-modal="settings"]'))), true, 'Focus stays in settings after ' + key)
  }
  for (const close of ['Escape', 'button', 'mask']) {
    if (!await modal.count()) { await opener.click(); await modal.waitFor() }
    if (close === 'Escape') await page.keyboard.press('Escape')
    else if (close === 'button') await modal.getByRole('button', { name: '关闭', exact: true }).click()
    else await page.mouse.click(8, 400)
    await modal.waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-fig-sidebar-settings')), true, 'Focus returns to 设置 after ' + close)
  }
  // 720px and below: the dialog fills the window and the list is one row.
  await page.setViewportSize({ width: 700, height: 600 })
  await app.evaluate(({Menu}) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click()); await modal.waitFor()
  const narrow = await page.evaluate(() => {
    const box = document.querySelector('[data-shortcut-modal="settings"]').getBoundingClientRect()
    const cells = [...document.querySelectorAll('[data-shortcut-modal="settings"] > nav button')].slice(0, 2).map(cell => cell.getBoundingClientRect().top)
    return { fill: box.width === innerWidth && box.height === innerHeight, row: cells.length === 2 && cells[0] === cells[1], debug: [innerWidth, innerHeight, box.width, box.height, ...cells, matchMedia('(max-width: 720px)').matches, [...document.querySelectorAll('[data-shortcut-modal="settings"] > nav button')].map(c => c.textContent + ':' + c.hasAttribute('data-fig-settings-group'))] }
  })
  assert.deepEqual({ fill: narrow.fill, row: narrow.row }, { fill: true, row: true }, JSON.stringify(narrow.debug) + ' ' + 'Narrow settings fill the window with one row of sections')
  await page.screenshot({ path: join(evidence, 'settings-narrow.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await modal.waitFor({ state: 'detached', timeout: 5000 })
  await page.locator('[data-lexical-editor="true"]').first().waitFor()
  console.log('PASS: Runtime preserved; General retains native preferences and hosts three Fig switches with keyboard operation, saved preferences, failed-save recovery and return navigation')
  passed = true
} finally {
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
