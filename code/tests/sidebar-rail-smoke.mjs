import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { cleanUp, isolatedProfile, launchFig } from '../scripts/isolated-fig.mjs'
import { evidenceDir, openWorkbench } from './helpers/fig-smoke.mjs'

// Like Codex: a top bar in the sidebar colour holds the conversation header and the right sidebar's
// tab strip, above rounded content cards; collapsed, the open-sidebar button leads the bar right
// after the lights and the rail starts with New session. Behind the workbench, the startup page must not
// keep its drag strip, which would swallow clicks on DSH buttons near the top of the window.
const evidence = await evidenceDir('sidebar-rail')
const { profile, env } = await isolatedProfile('rail')
let app, passed = false
try {
  app = await launchFig(env)
  const startup = await app.firstWindow()
  const page = await openWorkbench(app)
  await page.locator('[aria-label="预览版说明"]').waitFor({ state: 'hidden' })
  assert.equal(await startup.evaluate(() => getComputedStyle(document.body, '::before').content), 'none', 'The hidden startup page still has its drag strip')

  // The welcome is text-only: copy centred above the composer card, no mark.
  const welcome = await page.locator('[data-fig-welcome]').evaluate(copy => {
    const card = copy.closest('[data-composer-seat]').querySelector('[data-composer-card]').getBoundingClientRect()
    const box = copy.getBoundingClientRect()
    return { gap: card.top - box.bottom, offset: box.left + box.width / 2 - (card.left + card.width / 2) }
  })
  assert.ok(welcome.gap > 0 && Math.abs(welcome.offset) < 1, 'Welcome copy must sit above and centred on the composer card: ' + JSON.stringify(welcome))
  assert.equal(await page.locator('[data-fig-brand="hero-mark"]').isVisible(), false, 'The welcome mark stays hidden')

  const workspace = page.getByRole('button', { name: '选择工作区', exact: true })
  const mode = page.getByRole('button', { name: '标准模式', exact: true })
  const card = page.locator('[data-composer-card]')
  const cardBox = await card.boundingBox()
  const workspaceBox = await workspace.boundingBox()
  const modeBox = await mode.boundingBox()
  assert.ok(workspaceBox.y >= cardBox.y + cardBox.height && modeBox.y >= cardBox.y + cardBox.height
    && Math.abs(workspaceBox.y - modeBox.y) < 1 && workspaceBox.x < modeBox.x,
    'Workspace and mode must share a row below the composer card')
  await workspace.focus()
  await page.keyboard.press('Shift+Tab')
  assert.ok(await card.evaluate(element => element.contains(document.activeElement)), 'Keyboard order must enter the composer before the workspace selector')
  await workspace.click()
  await page.getByRole('menu').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'hidden' })
  await mode.click()
  await page.getByRole('menuitem', { name: /创造模式/ }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'hidden' })

  const editor = page.locator('[data-lexical-editor="true"]').first()
  await editor.click(); await editor.fill('Fig top bar check'); await editor.press('Enter')
  await page.getByText('Fig top bar check').first().waitFor({ timeout: 30000 })
  await delay(1000)
  const box = selector => page.locator(selector).first().evaluate(node => {
    const r = node.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), radius: getComputedStyle(node).borderTopLeftRadius }
  })
  const colors = await page.evaluate(() => ({
    frame: getComputedStyle(document.querySelector('[data-rightbar-col]').parentElement).backgroundColor,
    sidebar: getComputedStyle(document.querySelector('[data-slot="sidebar"] > div')).backgroundColor
  }))
  assert.equal(colors.frame, colors.sidebar, 'The top bar must use the sidebar colour')
  assert.deepEqual(await box('[data-slot="main.conversation"] header[data-window-drag]'), { top: 0, height: 44, radius: '0px' }, 'The conversation header must be the top bar row')
  const content = await box('[data-conversation-content]')
  assert.ok(content.top === 44 && content.radius === '12px', 'The transcript must be a rounded card below the bar: ' + JSON.stringify(content))
  assert.equal(await page.locator('[data-conversation-tabs]').isVisible(), false, 'The Conversation tab hides while Conversation is open')
  const gap = await page.locator('[data-conversation-header-corner] button').first().evaluate(node => Math.round(innerWidth - node.getBoundingClientRect().right))
  assert.ok(gap >= 8, 'The right-sidebar button must stay inside the bar: ' + gap)
  // The sidebar's More menu in a personal Profile (same defaults as a team one, user decision 2026-11-18):
  // every panel is in the sidebar, so More holds 「自定义侧栏…」 alone, without DSH's plugin browse/create rows.
  await page.locator('[data-slot="sidebar"]').first().getByRole('button', { name: '更多', exact: true }).first().click()
  await page.locator('[data-fig-customize-sidebar]').waitFor()
  assert.equal(await page.locator('[data-fig-panel-open]').count(), 0, 'No panel is folded by default')
  assert.equal(await page.getByText(/浏览更多插件|创建你的插件/).count(), 0, 'DSH\'s plugin rows are off')
  await page.locator('[data-fig-customize-sidebar]').click()
  assert.ok(await page.locator('[data-fig-panel-pin][data-pinned="true"]').count() >= 2, 'Each panel has a check, all on')
  await page.screenshot({ path: join(evidence, 'personal-more.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '更多会话视图' }).click()
  // From DSH 0.2.2-rc.5 the session rows resolve through the context-menu service, a moment after the menu opens.
  await page.getByRole('menuitem', { name: '下载 Session 日志' }).waitFor({ timeout: 5000 }).catch(() => {})
  const menu = await page.getByRole('menu').innerText()
  await page.screenshot({ path: join(evidence, 'session-menu.png'), animations: 'disabled' })
  assert.ok(/轨迹/.test(menu) && /下载 Session 日志/.test(menu), 'One … menu holds the views and the Session log actions: ' + JSON.stringify(menu))
  assert.equal(await page.locator('button[aria-label="更多操作"]').first().isVisible(), false, 'The Session log export keeps no second … button')
  assert.equal(await page.locator('header[data-window-drag] button[data-context-menu-trigger]').evaluateAll(buttons => buttons.filter(b => b.checkVisibility()).length), 0,
    'DSH\'s session header … (0.2.2-rc.5) is folded into the views …')
  await page.getByRole('menuitem', { name: /轨迹/ }).click()
  await page.getByRole('tab', { name: '对话' }).click({ timeout: 5000 })
  await delay(500)
  assert.equal(await page.locator('[data-conversation-tabs]').isVisible(), false, 'Conversation tab returns from another view, then hides again')
  const rightExpand = page.locator('[data-sidebar-right-expand]')
  assert.equal(await rightExpand.getAttribute('title'), null)
  assert.equal(await rightExpand.getAttribute('aria-label'), '展开右侧栏')
  assert.equal(await rightExpand.locator('[data-fig-sidebar-icon]').getAttribute('data-fig-sidebar-icon'), 'right-left')
  await rightExpand.click()
  await delay(1000)
  assert.deepEqual(await box('[data-rightbar-col] [data-dockkit-pane] > :first-child'), { top: 0, height: 44, radius: '0px' }, 'The right sidebar tab strip must sit in the top bar')
  const pane = await box('[data-rightbar-col] [data-dockkit-pane] > :last-child')
  assert.ok(pane.top === 44 && pane.radius === '12px', 'The right sidebar body must be a rounded card: ' + JSON.stringify(pane))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(evidence, 'right-open.png'), animations: 'disabled' })
  const rightCollapse = page.locator('[data-sidebar-right-toggle]')
  assert.equal(await rightCollapse.getAttribute('title'), null)
  assert.equal(await rightCollapse.getAttribute('aria-label'), '收起右侧栏')
  assert.equal(await rightCollapse.locator('[data-fig-sidebar-icon]').getAttribute('data-fig-sidebar-icon'), 'right-right')
  await rightCollapse.click()
  await rightExpand.waitFor({ state: 'visible' })
  const leftCollapse = page.locator('[data-slot="sidebar"] [data-sidebar-toggle]').first()
  assert.equal(await leftCollapse.getAttribute('title'), null)
  assert.equal(await leftCollapse.getAttribute('aria-label'), '收起左侧栏')
  assert.equal(await leftCollapse.locator('[data-fig-sidebar-icon]').getAttribute('data-fig-sidebar-icon'), 'left-left')
  const collapsed = () => page.evaluate(() => document.querySelector('[data-sidebar-collapsed]') !== null)
  const toggle = page.locator('[data-fig-rail-toggle]').first()
  assert.equal(await toggle.isVisible(), false, 'The header button shows only while the sidebar is collapsed')
  await page.locator('[data-slot="sidebar"] [data-window-drag] button[class*="_toggle"]').click()
  await delay(800)
  assert.equal(await collapsed(), true)
  assert.equal(await toggle.getAttribute('title'), null)
  assert.equal(await toggle.getAttribute('aria-label'), '展开左侧栏')
  assert.equal(await toggle.locator('[data-fig-sidebar-icon]').getAttribute('data-fig-sidebar-icon'), 'left-right')
  const button = await toggle.boundingBox()
  assert.equal(await page.locator('[data-fig-product-title]').isVisible(), false, 'Collapsed chrome must not duplicate the product title')
  const projectPrefix = await page.locator('.fig-header-project').first().boundingBox()
  if (projectPrefix) assert.ok(projectPrefix.x >= button.x + button.width, 'Project and session title must follow the restore button')
  assert.equal(await page.locator('[data-fig-brand="name"]').count(), 0, 'Sidebar must not render the old logo')
  assert.ok(button.x >= 80 && button.y + button.height / 2 > 16 && button.y + button.height / 2 < 32, 'The button must sit right of the traffic lights, on their row: ' + JSON.stringify(button))
  assert.equal(await page.locator('[data-sidebar-collapsed] [data-slot="sidebar"] [data-window-drag]').first().isVisible(), false, 'The rail keeps its logo row')
  const first = await page.locator('[data-slot="sidebar"] button[aria-label="新建会话"]').first().boundingBox()
  assert.ok(first.y >= 40, 'New session must start below the traffic lights')
  await page.screenshot({ path: join(evidence, 'collapsed.png'), animations: 'disabled' })
  await toggle.click()
  await delay(800)
  assert.equal(await collapsed(), false, 'The header button must open the sidebar')
  console.log('PASS: header and right tab strip in the sidebar-coloured top bar, rounded cards below; one … menu, Conversation tab only as the way back; collapsed top-bar button opens the sidebar; startup drag strip removed')
  passed = true
} finally {
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
