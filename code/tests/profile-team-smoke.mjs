import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'

// A team Profile in an isolated instance: the sample external plugin
// (fixtures/external-plugin-sample) is linked from its folder as a required plugin, the shell keeps the look both editions share,
// and Task activity shows what the plugin registers through figActivity and figUi. A second start pauses the
// required plugin and checks that the sidebar says why. No model request, no real account.

const evidence = fileURLToPath(new URL('../../work/verification/profile-team/', import.meta.url))
await mkdir(evidence, { recursive: true })
const sample = fileURLToPath(new URL('./fixtures/external-plugin-sample', import.meta.url))
const state = await isolatedProfile('profile-team', { extraEnv: profile => ({ GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: join(profile, 'grok/auth.json'), CODEX_HOME: join(profile, 'codex'),
  FIG_DESKTOP_DEV_PLUGINS: sample, FIG_DESKTOP_DEV_EDITION: 'team' }) })
await mkdir(join(state.dshHome, 'fig'), { recursive: true })
await writeFile(join(state.dshHome, 'fig/profile.json'), JSON.stringify({ schema: 1, coworkOrigin: 'https://cowork.example' }))
const checks = []
let app, page, passed = false
const shot = async name => page.screenshot({ path: join(evidence, name + '.png') })
const sidebar = () => page.locator('[data-slot="sidebar"]').first()
const openMore = async () => sidebar().getByRole('button', { name: /^(更多|More)$/ }).first().click()

try {
  app = await launchFig(state.env)
  page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click().catch(() => {})
  const profileManifest = JSON.parse(await readFile(join(state.dshHome, 'profiles/web/package.json'), 'utf8'))
  assert.equal(profileManifest.dependencies['@fig-sample/team-console'], 'link:' + sample, 'Linked from its folder')
  assert.ok(profileManifest.dsh.profile.bundles.includes('@fig-sample/team-console'))
  checks.push({ linked: true })

  // Unsigned Team UI must identify Cowork, keep the settings gear, and never offer DeepSeek login.
  const login = page.getByRole('button', { name: '登录 Cowork', exact: true })
  await login.waitFor()
  const gear = sidebar().locator('[data-fig-sidebar-settings]')
  await gear.waitFor()
  assert.equal(await sidebar().getByRole('button', { name: '登录', exact: true }).count(), 0)
  const gearBox = await gear.boundingBox()
  const loginBox = await login.boundingBox()
  assert.ok(gearBox && loginBox && Math.abs(loginBox.x + loginBox.width - gearBox.x) < 1
    && Math.abs(loginBox.y - gearBox.y) < 1 && Math.abs(loginBox.height - gearBox.height) < 1, JSON.stringify({ gearBox, loginBox }))
  await login.click({ position: { x: loginBox.width - 2, y: 2 } })
  const loginItem = page.getByRole('menuitem', { name: '登录 Cowork', exact: true })
  await loginItem.waitFor()
  assert.equal(await page.getByRole('menuitem', { name: '退出 Cowork 账号', exact: true }).count(), 0)
  await shot('cowork-signed-out')
  await loginItem.click()
  await page.getByRole('status').filter({ hasText: 'Cowork 登录服务尚未配置。' }).waitFor()
  checks.push({ signedOutCoworkMenu: true })

  // The plugin's page half found Fig's shared services.
  await until(async () => (await page.evaluate(() => window.__figSample?.figActivity)) === 2, { timeout: 30000 })
  checks.push({ services: await page.evaluate(() => ({ figUi: window.__figSample.figUi, figActivity: window.__figSample.figActivity })) })

  // The look both editions share: every panel shows in the sidebar, and More has no plugin rows and nothing folded.
  await sidebar().getByRole('button', { name: '任务动态', exact: true }).first().waitFor({ timeout: 30000 })
  await sidebar().getByRole('button', { name: 'Sample market', exact: true }).first().waitFor({ timeout: 15000 })
  await openMore()
  await page.locator('[data-fig-customize-sidebar]').waitFor()
  assert.equal(await page.locator('[data-fig-panel-open]').count(), 0, 'Nothing is folded by default')
  assert.equal(await page.getByText(/浏览更多插件|创建你的插件|Browse more plugins|Create your plugin/).count(), 0, 'DSH\'s plugin rows are off')
  await shot('more-menu')
  checks.push({ teamLabel: true, allShown: true, pluginRowsHidden: true })
  // 「自定义侧栏…」 unfolds the checks in place; a choice folds or shows the panel and is kept in this Profile.
  const savedPin = async () => JSON.parse(await readFile(join(state.dshHome, 'fig/panel-pins.json'), 'utf8').catch(() => '{}')).pinned?.['sample-team-market']
  assert.equal(await page.locator('[data-fig-panel-pin]').count(), 0, 'Checks stay folded until asked for')
  await page.locator('[data-fig-customize-sidebar]').click()
  await page.locator('[data-fig-panel-pin="sample-team-market"]').click()
  await page.locator('[data-fig-panel-open="sample-team-market"]').waitFor()
  await until(async () => (await sidebar().getByRole('button', { name: 'Sample market', exact: true }).count()) === 0, { timeout: 5000 })
  await until(async () => await savedPin() === false, { timeout: 5000 })
  await shot('more-menu-customize')
  await page.locator('[data-fig-panel-pin="sample-team-market"]').click()
  await page.keyboard.press('Escape')
  await sidebar().getByRole('button', { name: 'Sample market', exact: true }).first().waitFor()
  await until(async () => await savedPin() === true, { timeout: 5000 })
  checks.push({ pinPersisted: true })
  // DSH keeps its Plugins panel pinned; Fig folds it into More too (user 2026-11-21), kept per Profile, opened from More.
  const pluginsRow = () => sidebar().getByRole('button', { name: '插件', exact: true }).first()
  const savedPlugins = async () => JSON.parse(await readFile(join(state.dshHome, 'fig/panel-pins.json'), 'utf8').catch(() => '{}')).pinned?.plugins
  await openMore()
  await page.locator('[data-fig-customize-sidebar]').click()
  await page.locator('[data-fig-panel-pin="plugins"]').click()
  await page.locator('[data-fig-panel-open="plugins"]').waitFor()
  await until(async () => !(await pluginsRow().isVisible()), { timeout: 5000 })
  await until(async () => await savedPlugins() === false, { timeout: 5000 })
  await shot('more-menu-plugins-folded')
  await page.keyboard.press('Escape')
  await openMore()
  await page.locator('[data-fig-panel-open="plugins"]').click()
  await page.locator('[data-plugin-package]').first().waitFor({ timeout: 15000 })
  await openMore()
  await page.locator('[data-fig-customize-sidebar]').click()
  await page.locator('[data-fig-panel-pin="plugins"]').click()
  await page.keyboard.press('Escape')
  await pluginsRow().waitFor({ state: 'visible', timeout: 5000 })
  await until(async () => await savedPlugins() === true, { timeout: 5000 })
  checks.push({ pluginsFoldable: true })
  await sidebar().locator('button[class*="_newSession"]').first().click()

  // DSH's own model picker: no organization models here, so DeepSeek's API is 我的 API, a blue key
  // before the name on the trigger and before its heading in the model pane; the reasoning effort stays on the trigger.
  const modelTrigger = page.locator('button[aria-haspopup="menu"][class*="_trigger"]').filter({ hasText: /请选择模型|DeepSeek/ }).first()
  await modelTrigger.click()
  // With a model already chosen the root pane comes first: 模型 › opens the list.
  const modelCell = page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^模型/ }).first()
  if (await modelCell.isVisible().catch(() => false)) await modelCell.click()
  const apiGroup = page.locator('[role="menu"] [role="group"][data-fig-model-source="personal-api"]').first()
  await apiGroup.waitFor({ timeout: 15000 }).catch(async error => {
    console.log(await page.evaluate(() => [...document.querySelectorAll('[role="menu"]')].map(m => m.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '').slice(0, 2500))))
    throw error
  })
  const headingIcon = await apiGroup.locator('[data-fig-model-heading]').evaluate(node => getComputedStyle(node, '::before').backgroundColor)
  assert.equal(headingIcon, 'rgb(65, 118, 230)', 'API key blue (light)')
  await apiGroup.getByRole('menuitemradio').first().click()
  const seat = modelTrigger.locator('[data-fig-model-trigger]')
  await seat.waitFor({ timeout: 10000 })
  assert.equal(await seat.getAttribute('data-fig-model-source'), 'personal-api')
  assert.equal(await seat.getAttribute('title'), '我的 API · 不占团队额度')
  assert.equal(await seat.evaluate(node => getComputedStyle(node, '::before').backgroundColor), 'rgb(65, 118, 230)')
  assert.ok((await modelTrigger.locator('[class*="_triggerEffort"]').textContent())?.trim(), 'The reasoning effort stays on the trigger')
  assert.equal(await page.locator('[data-fig-team-model]').count(), 0, 'Fig no longer replaces the picker')
  await shot('model-trigger')
  checks.push({ nativeModelPicker: true })

  // 插件页: 「个人版插件」 and, in a team Profile, 「协作版插件」 to its right.
  await pluginsRow().click()
  const tabs = await page.locator('[data-plugin-header-part="tabs"] [role="tab"]').allTextContents()
  assert.deepEqual(tabs.slice(-2), ['个人版插件', '协作版插件'], JSON.stringify(tabs))
  await page.getByRole('tab', { name: '协作版插件', exact: true }).click()
  await page.getByText('这个 Profile 没有协作版插件。').waitFor({ timeout: 5000 })
  checks.push({ pluginTabs: tabs })
  await sidebar().locator('button[class*="_newSession"]').first().click()

  // The required plugin's switch on the Plugins page is locked.
  assert.match(await page.evaluate(() => document.querySelector('[data-fig-required-plugins]')?.textContent ?? ''), /@fig-sample\/team-console/)
  checks.push({ requiredLocked: true })

  // The team plugin's settings section goes last, under 协作版, though it registered first (order -50).
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  const settingsModal = page.locator('[data-shortcut-modal="settings"]')
  await settingsModal.waitFor()
  await until(async () => (await settingsModal.locator('[data-fig-settings-group-first]').count()) === 1, { timeout: 5000 })
  const settingsGroups = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-shortcut-modal="settings"] > nav button')]
    const last = cells.reduce((a, b) => b.getBoundingClientRect().top > a.getBoundingClientRect().top ? b : a)
    return { last: last.textContent.trim(), label: last.getAttribute('data-fig-settings-group-first'), grouped: cells.filter(cell => cell.hasAttribute('data-fig-settings-group')).length }
  })
  assert.deepEqual(settingsGroups, { last: 'Sample team', label: '协作版', grouped: 1 })
  await shot('settings-team-group')
  await page.keyboard.press('Escape'); await settingsModal.waitFor({ state: 'detached' })
  checks.push({ settingsGroups })

  // A claimed task in the new session's workspace picker: picking it switches the workspace and drafts the task.
  const registry = JSON.parse(await readFile(join(state.dshHome, 'storages/workspace.json'), 'utf8'))
  const workspaceId = registry.global?.defaultWorkspaceId ?? registry.global?.workspaceIds?.[0]
  assert.ok(workspaceId, 'A workspace to bind the task to')
  await page.evaluate(id => window.__figSample.setWorkspace(id), workspaceId)
  await page.locator('button:has-text("默认工作区")').last().click()
  await page.getByText('我认领的任务').waitFor()
  await page.locator('[data-fig-picker-item="item-12"]').waitFor()
  assert.ok(await page.getByRole('menuitem').filter({ hasText: '#15 Cloud task' }).isDisabled(), 'A cloud-only task cannot be picked here')
  await shot('workspace-picker')
  await page.locator('[data-fig-picker-item="item-12"]').click()
  await until(async () => (await page.evaluate(() => window.__figSample.picked))?.workspaceId === workspaceId, { timeout: 10000 })
  await page.getByText('Task #12: Sample task').first().waitFor({ timeout: 10000 })
  await shot('task-drafted')
  checks.push({ workspacePicker: await page.evaluate(() => window.__figSample.picked) })
  assert.equal(await page.locator('[data-sample-selector]').count(), 0, 'No selector above the input')

  // Task activity with the plugin's extensions.
  await sidebar().getByRole('button', { name: '任务动态', exact: true }).first().click()
  const panel = page.locator('[data-fig-activity]')
  await panel.waitFor()
  assert.equal(await panel.locator('h1').first().textContent(), '任务动态', 'The name does not change by edition')
  await panel.locator('[data-fig-activity-summary="sample-items"]').waitFor()
  assert.match(await panel.locator('.fa-attention').textContent(), /2 work items/)
  await panel.locator('[data-fig-activity-section="sample-top"]').waitFor()
  await panel.locator('[data-fig-activity-section="sample-bottom"]').waitFor()
  // The page index and one open block at a time in a team Profile.
  const blockState = () => panel.evaluate(node => ({
    index: [...node.querySelectorAll('[data-fig-activity-index]')].map(item => item.getAttribute('data-fig-activity-index') + (item.getAttribute('aria-current') ? '*' : '')),
    open: [...node.querySelectorAll('.fa-fold[aria-expanded="true"]')].length }))
  assert.deepEqual(await blockState(), { index: ['fig:usage*', 'sample-top', 'fig:attention', 'sample-bottom', 'sample-manage'], open: 1 }, 'The first block is open on arrival')
  await panel.locator('[data-fig-activity-index="sample-bottom"]').click()
  await panel.locator('[data-sample-bottom]').waitFor()
  assert.deepEqual(await blockState(), { index: ['fig:usage', 'sample-top', 'fig:attention', 'sample-bottom*', 'sample-manage'], open: 1 }, 'The index opens its block and folds the rest')
  await panel.locator('[data-fig-activity-section="sample-bottom"] .fa-fold').click()
  assert.equal((await blockState()).open, 0, 'Its open heading folds everything')
  await panel.locator('[data-fig-activity-section="sample-top"] .fa-fold').click()
  await panel.locator('[data-sample-top]').waitFor()
  checks.push({ singleBlock: true })
  assert.equal(await panel.getByRole('option', { name: 'Team project' }).count(), 1)
  await panel.getByLabel('筛选项目').selectOption('team-project-1')
  assert.equal(await panel.locator('[data-sample-top]').getAttribute('data-sample-top'), 'team-project-1', 'Blocks receive the selected project')
  await panel.getByLabel('筛选项目').selectOption('')
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1200, height: 1000 })
    await login.click()
    await page.getByRole('menuitem', { name: '主题外观', exact: true }).click()
    await page.getByRole('menuitem', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click()
    await page.waitForFunction(value => document.documentElement.dataset.dsThemeSource === value, theme)
    // Orange text follows the theme's brand text (figUi accentText): the index's current item and an accent tag.
    const orangeText = await panel.evaluate(node => [node.querySelector('[data-fig-activity-index][aria-current="true"]'), node.querySelector('.fig-ui-tag')]
      .map(element => element && getComputedStyle(element).color))
    assert.deepEqual(orangeText, theme === 'dark' ? ['rgb(255, 138, 76)', 'rgb(255, 138, 76)'] : ['rgb(182, 64, 0)', 'rgb(182, 64, 0)'], theme + ' orange text')
    checks.push({ theme, orangeText })
    // Team dark is OpenLLM's two layers; team light matches the personal edition.
    const surfaces = await panel.evaluate(node => {
      const read = name => getComputedStyle(node).getPropertyValue(name).trim().toLowerCase()
      const card = node.querySelector('.fig-ui-card'), cardStyle = card && getComputedStyle(card)
      return { base: read('--dsw-alias-bg-base'), sidebar: read('--dsw-specific-sidebar-fill'), layer1: read('--dsw-alias-bg-layer-1'),
        input: read('--dsw-specific-input-major'), selector: read('--dsw-specific-selector'), hover: read('--dsw-alias-interactive-bg-hover'),
        pageBackground: getComputedStyle(node).backgroundColor, cardBackground: cardStyle?.backgroundColor, cardBorder: cardStyle?.borderTopColor, cardShadow: cardStyle?.boxShadow }
    })
    checks.push({ theme, surfaces })
    // The team sidebar's current item is one pill: #303035 in dark, the hover grey in light.
    const pill = await page.evaluate(() => {
      const element = document.querySelector('[data-fig-nav-pill]'), active = document.querySelector('[data-fig-nav-pill-host] > [class*="_panelEntryActive"]')
      const a = element?.getBoundingClientRect(), b = active?.getBoundingClientRect()
      return { hidden: element?.hidden, color: element && getComputedStyle(element).backgroundColor, entry: active && getComputedStyle(active).backgroundColor,
        aligned: Boolean(a && b && Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1) }
    })
    assert.deepEqual(pill, { hidden: false, color: theme === 'dark' ? 'rgb(48, 48, 53)' : 'rgba(38, 49, 72, 0.06)', entry: 'rgba(0, 0, 0, 0)', aligned: true }, theme + ' nav pill')
    checks.push({ theme, pill })
    if (theme === 'dark') {
      assert.deepEqual([surfaces.base, surfaces.sidebar, surfaces.input, surfaces.selector], ['#010101', '#09090b', '#18181b', '#2c2c2e'], 'team dark surfaces')
      assert.equal(surfaces.cardBackground, 'rgb(9, 9, 11)', 'Fig cards take the sidebar fill')
      assert.equal(surfaces.cardBorder, 'rgba(0, 0, 0, 0)', 'Fig cards drop their border in team dark')
      assert.match(surfaces.cardShadow ?? '', /rgba\(255, 255, 255, 0\.06[5-7]\) 0px 0px 0px 1px/, 'Fig cards take the 6.5% ring')
    } else {
      assert.equal(surfaces.base, '#f5f6f7', 'team light page')
      assert.equal(surfaces.cardBackground, 'rgb(255, 255, 255)', 'team light cards')
      assert.doesNotMatch(surfaces.cardShadow ?? 'none', /rgba\(255, 255, 255/, 'light cards keep the border only')
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await shot(`activity-${theme}-${width}`)
      const overflow = await panel.evaluate(node => node.scrollWidth - node.clientWidth)
      checks.push({ theme, width, overflow })
      assert.equal(overflow, 0)
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  // Switching entries slides the pill (240ms, transform only) and it ends on the new entry; a conversation hides it.
  const pillState = () => page.evaluate(() => {
    const element = document.querySelector('[data-fig-nav-pill]'), active = document.querySelector('[data-fig-nav-pill-host] > [class*="_panelEntryActive"]')
    const a = element?.getBoundingClientRect(), b = active?.getBoundingClientRect()
    return { hidden: element?.hidden, moving: element?.getAnimations().length ?? 0, aligned: Boolean(a && b && Math.abs(a.top - b.top) < 1 && Math.abs(a.height - b.height) < 1) }
  })
  await sidebar().getByRole('button', { name: '自动化任务', exact: true }).first().click()
  const sliding = await pillState()
  assert.equal(sliding.moving, 1, 'The pill slides')
  await page.waitForTimeout(320)
  assert.deepEqual(await pillState(), { hidden: false, moving: 0, aligned: true }, 'and ends on the new entry')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await sidebar().getByRole('button', { name: '任务动态', exact: true }).first().click()
  assert.equal((await pillState()).moving, 0, 'Reduced motion places it without sliding')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await sidebar().locator('button[class*="_newSession"]').first().click()
  await until(async () => (await pillState()).hidden === true, { timeout: 5000 })
  await sidebar().getByRole('button', { name: '任务动态', exact: true }).first().click()
  const back = await pillState()
  assert.deepEqual([back.hidden, back.moving], [false, 0], 'Coming back from a conversation it appears in place')
  checks.push({ pillSlides: true })
  await panel.locator('[data-fig-activity-view="sample-team"]').click()
  await panel.locator('[data-sample-team-view]').waitFor()
  assert.equal(await panel.locator('.fa-overview').count(), 0, 'Another view replaces the panel\'s own content')
  await panel.locator('[data-fig-activity-view="default"]').click()
  await panel.locator('.fa-overview').waitFor()
  checks.push({ activityExtensions: true, views: true })

  // A role change: the plugin withdraws its admin panel and its manage block.
  await panel.locator('[data-fig-activity-index="sample-manage"]').click()
  await panel.locator('[data-sample-manage]').waitFor()
  await page.evaluate(() => window.__figSample.setManager(false))
  await until(async () => (await panel.locator('[data-fig-activity-index="sample-manage"]').count()) === 0, { timeout: 5000 })
  assert.equal((await blockState()).index[0], 'fig:usage*', 'The withdrawn open block hands over to the first')
  await page.evaluate(() => window.__figSample.setManager(true))
  await panel.locator('[data-fig-activity-index="sample-manage"]').waitFor()
  await sidebar().getByRole('button', { name: 'Team admin', exact: true }).first().click()
  await page.locator('[data-sample-admin]').waitFor()
  await page.evaluate(() => window.__figSample.setManager(false))
  await until(async () => (await sidebar().getByRole('button', { name: 'Team admin', exact: true }).count()) === 0, { timeout: 5000 })
  await until(async () => (await page.locator('[data-sample-admin]').count()) === 0, { timeout: 5000 })
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 5000 })
  await shot('role-withdrawn')
  checks.push({ roleChange: true })
  await app.close(); app = undefined

  // Second start: the required plugin failed last time and is paused for this launch; the sidebar foot says why.
  await writeFile(join(state.dshHome, 'fig/external-plugins.json'), JSON.stringify({ installed: { '@fig-sample/team-console': 'link:' + sample },
    suspended: { '@fig-sample/team-console': '工作台启动时加载失败，本次启动已暂停' } }))
  app = await launchFig(state.env)
  page = await workbenchPage(app)
  await page.locator('[data-fig-required-notice]').click({ timeout: 30000 })
  await page.getByRole('dialog').getByText('@fig-sample/team-console').waitFor()
  await shot('required-notice')
  assert.equal(await page.evaluate(() => window.__figSample), undefined, 'The paused plugin is not loaded')
  checks.push({ suspendedNotice: true })
  const record = JSON.parse(await readFile(join(state.dshHome, 'fig/external-plugins.json'), 'utf8'))
  assert.deepEqual(record.suspended, {}, 'The pause lasts one launch')
  await app.close(); app = undefined

  // Third start, the team layout: Task activity's own parts off, and a pinned panel no
  // plugin registers is skipped. Only the title, the index and the plugin's blocks remain.
  // The descriptor says team itself: an edition chosen on the command line would take that edition's default look.
  const descriptor = JSON.parse(await readFile(join(state.dshHome, 'fig/profile.json'), 'utf8'))
  await writeFile(join(state.dshHome, 'fig/profile.json'), JSON.stringify({ ...descriptor, edition: 'team', shell: {
    pinnedPanels: ['fig-task-activity', 'sample-team-market', 'sample-team-admin', 'sample-ghost'],
    activity: { views: false, figures: false, usage: false, filter: false, sessionGroups: false } } }))
  const { FIG_DESKTOP_DEV_EDITION, ...teamEnv } = state.env
  app = await launchFig(teamEnv)
  page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click({ timeout: 5000 }).catch(() => {})
  await until(async () => (await page.evaluate(() => window.__figSample?.figActivity)) === 2, { timeout: 30000 })
  for (const name of ['任务动态', 'Sample market', 'Team admin']) await sidebar().getByRole('button', { name, exact: true }).first().waitFor({ timeout: 15000 })
  // The descriptor pins no Plugins panel, so it starts in More; the earlier per-Profile choice (shown) wins over that default.
  assert.equal(await sidebar().getByRole('button', { name: '插件', exact: true }).first().isVisible(), true, 'The user\'s own choice outlasts the descriptor\'s default')
  await sidebar().getByRole('button', { name: '任务动态', exact: true }).first().click()
  const teamPanel = page.locator('[data-fig-activity]')
  await teamPanel.locator('[data-fig-activity-index]').first().waitFor()
  const layout = await teamPanel.evaluate(node => ({
    index: [...node.querySelectorAll('[data-fig-activity-index]')].map(item => item.getAttribute('data-fig-activity-index')),
    own: ['.fa-overview', '.fa-tools', '.fa-views', '[data-fig-activity-block]'].filter(selector => node.querySelector(selector))
  }))
  assert.deepEqual(layout, { index: ['sample-top', 'sample-bottom', 'sample-manage'], own: [] })
  await teamPanel.locator('[data-sample-top]').waitFor()
  await shot('activity-team-layout')
  // A plugin's control at the heading's right end, after the index (§4.7); withdrawn, it leaves; narrow, it wraps.
  const heading = () => teamPanel.evaluate(node => {
    const head = node.querySelector('.fa-page-head'), bell = head.querySelector('[data-fig-activity-tool="sample-bell"]'), nav = head.querySelector('.fa-index')
    return { bell: Boolean(bell), afterIndex: Boolean(bell && nav && bell.getBoundingClientRect().left >= nav.getBoundingClientRect().right - 1),
      rightEdge: bell ? Math.round(head.getBoundingClientRect().right - bell.getBoundingClientRect().right) : null, overflow: node.scrollWidth - node.clientWidth }
  })
  assert.deepEqual(await heading(), { bell: true, afterIndex: true, rightEdge: 0, overflow: 0 })
  await page.setViewportSize({ width: 700, height: 900 })
  const narrowHead = await heading()
  assert.equal(narrowHead.overflow, 0, 'The heading wraps at 700px without overflow')
  await shot('activity-tool-narrow')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await shot('activity-tool')
  await page.evaluate(() => window.__figSample.setBell(false))
  await until(async () => !(await heading()).bell, { timeout: 5000 })
  checks.push({ headingTool: true })
  checks.push({ teamLayout: layout, ghostPinSkipped: true })
  await app.close(); app = undefined

  // Fourth start, two layers: the sample is the group's base layer and a business plugin's package
  // cannot be found, so only that business plugin stops; the sample runs, and the Team plugins tab shows both cards.
  const missing = join(state.profile, 'missing-module-0.1.0.tgz')
  const teamDescriptor = JSON.parse(await readFile(join(state.dshHome, 'fig/profile.json'), 'utf8'))
  await writeFile(join(state.dshHome, 'fig/profile.json'), JSON.stringify({ ...teamDescriptor, plugins: [
    { source: sample, required: true, group: 'sample' }, { source: { kind: 'package', path: missing }, required: true, group: 'sample', plugin: 'tasks' }] }))
  {
    const { FIG_DESKTOP_DEV_PLUGINS, ...layerEnv } = teamEnv
    app = await launchFig(layerEnv)
  }
  page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click({ timeout: 5000 }).catch(() => {})
  await sidebar().getByRole('button', { name: '任务动态', exact: true }).first().click({ timeout: 30000 })
  const businessStopped = page.locator('[data-fig-activity-group-stopped="sample/tasks"]')
  await businessStopped.waitFor({ timeout: 15000 })
  assert.match(await businessStopped.textContent(), /业务插件 tasks 已停用：missing-module-0\.1\.0\.tgz 未通过（找不到插件包文件）/)
  await until(async () => (await page.evaluate(() => window.__figSample?.figActivity)) === 2, { timeout: 30000 })
  await sidebar().getByRole('button', { name: '插件', exact: true }).first().click()
  await page.getByRole('tab', { name: '协作版插件', exact: true }).click()
  await page.locator('[data-fig-team-bundle="base"][data-fig-team-bundle-on="true"]').waitFor({ timeout: 10000 })
  const tasksCard = page.locator('[data-fig-team-bundle="tasks"][data-fig-team-bundle-on="false"]')
  await tasksCard.waitFor()
  assert.match(await tasksCard.textContent(), /业务插件.*组织下发.*业务插件 tasks 已停用：missing-module-0\.1\.0\.tgz 未通过（找不到插件包文件）$/)
  assert.equal(await page.locator('[data-fig-team-bundle] [role="switch"]:not([disabled])').count(), 0, 'Members switch nothing here')
  await shot('team-plugins-tab')
  await tasksCard.getByRole('button').first().click()
  await page.locator('[data-fig-team-detail="tasks"]').getByText('包含的组件 共 1 个 · 0 已启用').waitFor()
  await page.locator('[data-fig-team-component="missing-module-0.1.0.tgz"] .fig-team-dot[data-status="failed"]').waitFor()
  await shot('team-plugins-detail')
  checks.push({ businessStopped: true, teamPluginsTab: true })
  await app.close(); app = undefined

  // Fifth start, the platform paused the business plugin: a copy of the sample declared as the business
  // plugin 任务协作 is not loaded, the Team plugins tab tags it 平台已暂停 with the category and reason, and Task activity says so.
  const businessSample = join(state.profile, 'sample-business')
  await cp(sample, businessSample, { recursive: true })
  const businessManifest = JSON.parse(await readFile(join(businessSample, 'package.json'), 'utf8'))
  await writeFile(join(businessSample, 'package.json'), JSON.stringify({ ...businessManifest, figCowork: { group: 'sample', layer: 'business', plugin: 'tasks', pluginTitle: '任务协作' } }))
  await writeFile(join(state.dshHome, 'fig/profile.json'), JSON.stringify({ ...teamDescriptor, plugins: [{ source: businessSample, required: true, group: 'sample', plugin: 'tasks' }],
    teamPlugins: { tasks: { active: false, off: 'platform', platformOff: { kind: 'security', reason: '依赖漏洞排查中', at: '2026-11-24T08:00:00Z' } } } }))
  {
    const { FIG_DESKTOP_DEV_PLUGINS, ...pausedEnv } = teamEnv
    app = await launchFig(pausedEnv)
  }
  page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click({ timeout: 5000 }).catch(() => {})
  await sidebar().getByRole('button', { name: '任务动态', exact: true }).first().click({ timeout: 30000 })
  const pausedLine = page.locator('[data-fig-activity-group-stopped="sample/tasks"]')
  await pausedLine.waitFor({ timeout: 15000 })
  assert.equal(await pausedLine.textContent(), '平台因安全问题暂停了业务插件 任务协作：依赖漏洞排查中')
  assert.equal(await page.evaluate(() => window.__figSample), undefined, 'A paused business plugin is not loaded')
  assert.equal(await page.locator('[data-fig-required-notice]').count(), 0, 'and it is not a failed required plugin')
  await sidebar().getByRole('button', { name: '插件', exact: true }).first().click()
  await page.getByRole('tab', { name: '协作版插件', exact: true }).click()
  const pausedCard = page.locator('[data-fig-team-bundle="tasks"][data-fig-team-bundle-on="false"]')
  await pausedCard.waitFor({ timeout: 10000 })
  assert.match(await pausedCard.textContent(), /^任务协作业务插件组织下发平台已暂停.*平台因安全问题暂停了业务插件 任务协作：依赖漏洞排查中$/)
  await shot('team-plugins-platform-paused')
  checks.push({ platformPaused: true })
  await app.close(); app = undefined

  // Sixth start, the base layer fails: the sample and a package that cannot be found share the group's base layer, so the
  // whole group is off and Task activity and the sidebar foot name the missing package.
  await writeFile(join(state.dshHome, 'fig/profile.json'), JSON.stringify({ ...teamDescriptor, plugins: [
    { source: sample, required: true, group: 'sample' }, { source: { kind: 'package', path: missing }, required: true, group: 'sample' }] }))
  const { FIG_DESKTOP_DEV_PLUGINS, ...groupEnv } = teamEnv
  app = await launchFig(groupEnv)
  page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click({ timeout: 5000 }).catch(() => {})
  await sidebar().getByRole('button', { name: '任务动态', exact: true }).first().click({ timeout: 30000 })
  const stopped = page.locator('[data-fig-activity-group-stopped="sample"]')
  await stopped.waitFor({ timeout: 15000 })
  assert.match(await stopped.textContent(), /插件组 sample 已停用：missing-module-0\.1\.0\.tgz 未通过（找不到插件包文件）/)
  assert.equal(await page.evaluate(() => window.__figSample), undefined, 'No package of the stopped group runs')
  await page.locator('[data-fig-required-notice]').click()
  await page.getByRole('dialog').getByText(/插件组 sample 已停用/).first().waitFor()
  await shot('group-stopped')
  checks.push({ groupStopped: true })

  passed = true
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: 'pass', checks }, null, 2))
  console.log('PASS', evidence)
} finally {
  await app?.close()
  await cleanUp(state.profile, passed)
}
