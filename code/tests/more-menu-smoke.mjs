import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parse } from 'yaml'
import { cleanUp, isolatedProfile, launchFig, workbenchPage, until } from '../scripts/isolated-fig.mjs'

// The sidebar footer has one hover surface. Its gear opens settings and the rest opens the account menu.

const { profile, dshHome, env } = await isolatedProfile('more-menu')
let app
let passed = false

async function waitForSavedAppearance(scheme) {
  const patch = join(dshHome, 'profiles/web/cordis.patch.yml')
  await until(async () => parse(await readFile(patch, 'utf8')).find(entry => entry.id === 'ui-theme')?.config.preference === scheme,
    { interval: 50, message: `DSH did not save the ${scheme} preference` })
}

try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 60_000 })
  const sidebar = page.locator('[data-slot="sidebar"]')
  const login = sidebar.getByRole('button', { name: '登录', exact: true })
  const gear = sidebar.getByRole('button', { name: '设置', exact: true })
  await login.waitFor()
  await gear.waitFor()
  await page.locator('[aria-label="预览版说明"]').waitFor({ state: 'hidden' })
  const loginBox = await login.boundingBox()
  const gearBox = await gear.boundingBox()
  assert.ok(Math.abs(loginBox.x + loginBox.width - gearBox.x) < 1
    && Math.abs(loginBox.y - gearBox.y) < 1 && Math.abs(loginBox.height - gearBox.height) < 1)
  assert.equal(await login.evaluate(button => getComputedStyle(button, '::after').content), '"登录"')
  const signInIcon = await login.locator('svg use').getAttribute('href')
  assert.equal(signInIcon, '#dsw-icon-user-outline-medium')
  const hoverColors = () => login.evaluate(button => {
    const footer = button.closest('[class*="_footArea"]')
    return [footer, button, footer.querySelector('[data-fig-sidebar-settings]')]
      .map(element => getComputedStyle(element).backgroundColor)
  })
  await login.hover()
  const hover = await hoverColors()
  assert.notEqual(hover[0], 'rgba(0, 0, 0, 0)')
  assert.deepEqual(hover.slice(1), ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
  await gear.hover()
  assert.deepEqual(await hoverColors(), hover)

  // The empty space next to the gear still opens the account menu, including near the top edge.
  await page.mouse.click(gearBox.x - 2, gearBox.y + 2)
  const signIn = page.getByRole('menuitem', { name: '登录', exact: true })
  await signIn.waitFor()
  assert.equal(await signIn.locator('svg use').getAttribute('href'), signInIcon)
  await page.keyboard.press('Escape')
  await signIn.waitFor({ state: 'hidden' })

  await login.focus()
  await page.keyboard.press('Tab')
  assert.ok(await gear.evaluate(button => document.activeElement === button),
    await page.evaluate(() => `Tab focused ${document.activeElement?.tagName} ${document.activeElement?.getAttribute('aria-label')}`))
  await page.mouse.click(gearBox.x + 2, gearBox.y + 2)
  await page.getByRole('heading', { name: '工作区' }).waitFor()
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('[data-shortcut-modal="settings"]').waitFor({ state: 'hidden' })
  console.log('PASS: one hover surface; menu and gear have adjacent hit areas; login reuses the menu icon')

  await sidebar.getByRole('button', { name: '收起左侧栏' }).click()
  await login.and(page.locator('[data-collapsed="true"]')).waitFor()
  await gear.waitFor({ state: 'hidden' })
  assert.equal(await sidebar.locator('[class*="_footArea"] button:visible').count(), 1)
  assert.equal(await login.evaluate(button => getComputedStyle(button, '::after').content), 'none')
  await login.click()
  await page.getByRole('menuitem', { name: /^设置/ }).click()
  await page.locator('[data-shortcut-modal="settings"]').waitFor()
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('[data-shortcut-modal="settings"]').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '展开左侧栏' }).click()
  await gear.waitFor()
  console.log('PASS: collapsed rail shows one account button; its menu can open settings')

  const openMore = async (workbench = page) => {
    await workbench.locator('[data-slot="sidebar"]').getByRole('button', { name: /^(登录|Sign in)$/ }).click()
    await workbench.getByRole('menuitem').first().waitFor()
  }

  await openMore()
  const labels = (await page.getByRole('menuitem').allInnerTexts()).map(text => text.split('\n')[0])
  assert.deepEqual(labels.slice(0, 3), ['设置', '主题外观', '界面语言'])
  assert.ok(labels.includes('意见反馈'), labels.join(', '))
  assert.ok(labels.includes('登录'), labels.join(', '))

  await page.getByRole('menuitem', { name: '主题外观' }).hover()
  assert.deepEqual(await page.getByRole('menuitemradio').allInnerTexts(), ['浅色', '深色', '跟随系统'])
  await page.getByRole('menuitemradio', { name: '深色' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === 'dark' || getComputedStyle(document.body).colorScheme.includes('dark') || matchMedia('(prefers-color-scheme: dark)').matches)
  assert.equal(await page.locator('[role="menu"]').count(), 0, 'a choice closes the menu')
  await openMore()
  await page.getByRole('menuitem', { name: '主题外观' }).hover()
  assert.equal(await page.getByRole('menuitemradio', { name: '深色' }).getAttribute('aria-checked'), 'true')
  console.log('PASS: 主题外观 switches DSH to dark and marks the choice')

  await page.getByRole('menuitem', { name: '界面语言' }).hover()
  const flyout = await page.locator('[role="menu"][data-fig-more="locale"]').boundingBox()
  const height = await page.evaluate(() => innerHeight)
  assert.ok(flyout && flyout.y >= 0 && flyout.y + flyout.height <= height, 'flyout inside the window ' + JSON.stringify(flyout))
  const languageRows = page.getByRole('menuitemradio')
  assert.deepEqual(await languageRows.allInnerTexts(), ['简体中文', 'English'])
  const glyphs = await languageRows.evaluateAll(rows => rows.map(row => row.querySelector('span:first-child svg path')?.getAttribute('d')))
  assert.ok(glyphs.every(Boolean) && new Set(glyphs).size === 2)
  const evidence = fileURLToPath(new URL('../../work/verification/cowork-account-menu/', import.meta.url))
  await mkdir(evidence, { recursive: true })
  await page.screenshot({ path: join(evidence, 'personal-language.png') })
  await page.getByRole('menuitemradio', { name: 'English' }).click()
  await page.waitForFunction(() => document.documentElement.lang.startsWith('en'))
  await sidebar.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  await openMore()
  await page.getByRole('menuitem', { name: 'Language' }).hover()
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.lang.startsWith('zh'))
  console.log('PASS: 界面语言 switches to English and back, within the window')

  await openMore()
  await page.getByRole('menuitem', { name: /^设置/ }).click()
  await page.locator('[data-shortcut-modal="settings"]').waitFor()
  console.log('PASS: 设置 in the same menu still opens settings')
  await page.keyboard.press('Escape')
  await page.locator('[data-shortcut-modal="settings"]').waitFor({ state: 'detached' })

  // The personal edition marks subscription and API models too (user 2026-11-24): DeepSeek's API is 我的 API, a key.
  await page.locator('[data-slot="sidebar"] button[class*="_newSession"]').first().click()
  const modelTrigger = page.locator('button[aria-haspopup="menu"][class*="_trigger"]').filter({ hasText: /请选择模型|DeepSeek|Select model/ }).first()
  await modelTrigger.click()
  const modelCell = page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^模型/ }).first()
  if (await modelCell.isVisible().catch(() => false)) await modelCell.click()
  const apiGroup = page.locator('[role="menu"] [role="group"][data-fig-model-source="personal-api"]').first()
  await apiGroup.waitFor({ timeout: 15000 })
  assert.doesNotMatch(await apiGroup.locator('[data-fig-model-heading]').textContent(), /组织/, 'No organization naming in the personal edition')
  await apiGroup.getByRole('menuitemradio').first().click()
  const seat = modelTrigger.locator('[data-fig-model-trigger]')
  await seat.waitFor({ timeout: 10000 })
  assert.equal(await seat.getAttribute('title'), '我的 API')
  assert.match(await seat.evaluate(node => getComputedStyle(node, '::before').backgroundColor), /^rgb\((65, 118, 230|122, 170, 255)\)$/)
  console.log('PASS: the personal model trigger shows the API key icon')

  // The startup page keeps DSH's base colours; in the workbench Fig's skin sets light bg-base to #f5f6f7.
  for (const [scheme, systemScheme, color, pageColor] of [
    ['dark', 'light', 'rgb(21, 21, 23)', 'rgb(21, 21, 23)'],
    ['light', 'dark', 'rgb(255, 255, 255)', 'rgb(245, 246, 247)']
  ]) {
    await waitForSavedAppearance(scheme)
    await app.close()
    app = await launchFig(env, { args: systemScheme === 'dark' ? ['--force-dark-mode'] : [] })
    const startup = await app.firstWindow()
    await startup.emulateMedia({ colorScheme: systemScheme })
    await startup.waitForFunction(({ scheme, color }) => {
      const mark = document.querySelector('.wordmark img')
      return document.documentElement.dataset.appearance === scheme
        && getComputedStyle(document.documentElement).backgroundColor === color
        && mark?.naturalWidth > 0
        && mark.currentSrc.includes('wordmark-reverse-') === (scheme === 'dark')
    }, { scheme, color }, { polling: 100, timeout: 10000 })

    const workbench = await workbenchPage(app)
    await workbench.waitForFunction(scheme => document.documentElement.style.colorScheme === scheme, scheme)
    await workbench.waitForFunction(color => {
      const sample = document.createElement('span')
      sample.style.color = 'var(--dsw-alias-bg-base)'
      document.body.append(sample)
      const matches = getComputedStyle(sample).color === color
      sample.remove()
      return matches
    }, pageColor)
    console.log(`PASS: restart preserves ${scheme} in startup and workbench with the opposite system scheme`)
    for (const width of [1440, 390]) {
      await workbench.setViewportSize({ width, height: 900 })
      if (width === 390) await workbench.locator('[data-sidebar-opener]:visible, [data-fig-rail-toggle]:visible').first().click()
      await openMore(workbench)
      await workbench.getByRole('menuitem', { name: /^(界面语言|Language)$/ }).hover()
      const languageMenu = workbench.locator('[role="menu"][data-fig-more="locale"]')
      await languageMenu.waitFor()
      const box = await languageMenu.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, JSON.stringify(box))
      assert.equal(await workbench.evaluate(() => document.documentElement.scrollWidth), width)
      await workbench.screenshot({ path: join(evidence, `personal-${scheme}-${width}-language.png`) })
      await workbench.keyboard.press('Escape')
      await languageMenu.waitFor({ state: 'hidden' })
    }
    await workbench.setViewportSize({ width: 1440, height: 900 })

    if (scheme === 'dark') {
      await openMore(workbench)
      await workbench.getByRole('menuitem', { name: /^(主题外观|Appearance)$/ }).hover()
      await workbench.getByRole('menuitemradio', { name: /^(浅色|Light)$/ }).click()
      await workbench.waitForFunction(() => document.documentElement.style.colorScheme === 'light')
    }
  }
  passed = true
} finally {
  await app?.close()
  await cleanUp(profile, passed)
}
