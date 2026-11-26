import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedDevEnvironment } from '../scripts/dev-isolation.mjs'
import { cleanUp, closeFig, isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'
import { openWorkbench } from './helpers/fig-smoke.mjs'

// A real Fig desktop and loopback authorization/login service. Only synthetic grants and devices.
const state = await isolatedProfile('cowork-edition', { base: isolatedDevEnvironment() })
let origin, opened, authorization, invited = false, revoked = false, device, registrations = 0, adminConsolePath, pluginRenewals = 0, pluginToken
const fixture = file => fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url))
const evidence = fileURLToPath(new URL('../../work/verification/cowork-account-menu/', import.meta.url))
await mkdir(evidence, { recursive: true })
const models = {
  // §4.9 (2026-11-24): each organization provider says whether the platform or the tenant supplies it.
  organizationProviders: [{ id: 'organization-proxy', source: 'platform' }], allowPersonal: false,
  defaultModel: { provider: 'organization-proxy', model: 'organization-demo' }
}
const server = createServer(async (req, res) => {
  const json = (body, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.url === '/.well-known/openid-configuration') return json({
      issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token'
    })
    if (req.url === '/token') {
      assert.ok(authorization)
      const form = new URLSearchParams(body)
      assert.equal(form.get('grant_type'), 'authorization_code')
      assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'))
      assert.equal(form.get('client_id'), 'fig-fixture')
      assert.equal(form.get('code'), 'synthetic-code')
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'))
      return json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 })
    }
    const checkProof = (path, content) => {
      const digest = createHash('sha256').update(content).digest('base64url')
      const proof = [req.method, path, device.id, req.headers['x-cowork-time'], req.headers['x-cowork-nonce'], digest].join('\n')
      assert.equal(req.headers['x-cowork-device'], device.id)
      assert.equal(verify(null, Buffer.from(proof), device.key, Buffer.from(req.headers['x-cowork-proof'], 'base64url')), true)
    }
    if (req.url === '/api/team/fig-smoke?proof=1') {
      assert.equal(req.headers.authorization, `Bearer ${pluginToken}`)
      checkProof('/api/team/fig-smoke', '')
      return json({ ok: true })
    }
    assert.equal(req.headers.authorization, 'Bearer fixture-access')
    if (req.url === '/api/desktop/session') return json({ member: 'member-one', name: '唐溪',
      organization: invited ? { id: 'test-org', name: '测试组织', adminConsolePath } : null, models })
    if (req.url === '/api/desktop/devices') {
      const request = JSON.parse(body)
      const key = createPublicKey({ key: Buffer.from(request.publicKey, 'base64url'), format: 'der', type: 'spki' })
      assert.equal(key.asymmetricKeyType, 'ed25519')
      registrations++
      device = { id: 'device-one', profile: request.profile, key }
      const home = join(state.profile, 'cowork', 'profiles', device.profile)
      await mkdir(join(home, 'profiles/web'), {recursive:true})
      await mkdir(join(home, 'fig'), {recursive:true})
      await writeFile(join(home, 'fig/profile.json'), JSON.stringify({ schema: 1, plugins: [fixture('external-plugin-sample')] }))
      const model = id => ({ api: 'openai-responses', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'COWORK_TEST_KEY', models: [{ id }] })
      await writeFile(join(home, 'profiles/web/cordis.patch.yml'), JSON.stringify([
        { id: 'workspace-controller', config: { documentsDirectory: state.documents } },
        { id: 'llm-pi-ai', config: { providers: { 'organization-proxy': model('organization-demo'), 'personal-demo': model('personal-demo') } } },
        { insert: ['handoff-probe', 'workbench-outputs-probe', 'cowork-team-probe'].map(id => ({ id, name: fixture(`${id}.mjs`) })) }
      ]))
      pluginToken = 'fixture-plugin-initial'
      return json({ id: device.id, pluginCredential: pluginToken, pluginCredentialExpiresAt: new Date(Date.now() + 20_000).toISOString() })
    }
    if (req.url === '/api/desktop/devices/device-one/plugin-credential') {
      assert.equal(body, '{}')
      checkProof(req.url, body)
      pluginToken = 'fixture-plugin-renewed'
      pluginRenewals++
      return json({ pluginCredential: pluginToken, pluginCredentialExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (req.url === '/api/desktop/devices/device-one') return revoked ? json({ error: { code: 'device_revoked', message: 'Fixture revoked' } }, 403)
      : json({ id: device.id, profile: device.profile, status: 'active', registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
    json({}, 404)
  } catch (error) { console.error(error.message); json({}, 500) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
origin = 'http://127.0.0.1:' + server.address().port
await writeFile(join(state.profile, 'cowork-connection.json'), JSON.stringify({ issuer: origin, origin, clientId: 'fig-fixture' }))
state.env.COWORK_TEST_KEY = 'isolated-catalog-only'

let app, passed = false
try {
  app = await launchFig(state.env, { args: ['--use-mock-keychain'] })
  await app.evaluate(({ shell }) => {
    shell.openExternal = async target => { globalThis.coworkBrowser = target }
  })
  const startup = await app.firstWindow()
  let page = await openWorkbench(app)
  const clickAndLeave = async locator => {
    const previous = page
    await locator.click().catch(error => {
      if (!previous.isClosed()) throw error // a successful click can stop DSH before Playwright returns
    })
    await until(() => previous.isClosed(), { timeout: 25_000, message: 'The previous edition workbench did not close' })
  }
  async function signIn() {
    const previousOrigin = new URL(page.url()).origin
    await page.getByRole('button', { name: '切换版本', exact: true }).click()
    await clickAndLeave(page.getByRole('menuitem', { name: '协作版', exact: true }))
    const previous = opened
    opened = await until(async () => {
      const target = await app.evaluate(() => globalThis.coworkBrowser)
      return typeof target === 'string' && target !== previous && new URL(target).pathname === '/authorize' && target
    },
      { timeout: 25_000, message: 'No authorization opened' })
    await assert.rejects(fetch(previousOrigin), 'the personal DSH must stop before the Team edition runs')
    authorization = new URL(opened)
    assert.equal(authorization.origin, origin)
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    const callback = new URL(authorization.searchParams.get('redirect_uri'))
    assert.equal(callback.hostname, '127.0.0.1')
    callback.searchParams.set('code', 'synthetic-code')
    callback.searchParams.set('state', 'wrong')
    assert.equal((await fetch(callback)).status, 404)
    callback.searchParams.set('state', authorization.searchParams.get('state'))
    assert.equal((await fetch(callback)).status, 200)
    await assert.rejects(fetch(callback))
  }
  await signIn()
  await startup.getByRole('heading', { name: '等待邀请' }).waitFor()
  assert.equal(registrations, 0)
  assert.deepEqual(await readdir(join(state.profile, 'cowork/profiles')).catch(() => []), [])

  invited = true
  await startup.getByRole('button', { name: '重新检查' }).click()
  page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click()
  const account = page.getByRole('button', { name: 'Cowork 账号' })
  await account.waitFor()
  assert.match(await account.innerText(), /唐溪.*测试组织/s)
  assert.equal(registrations, 1)
  const post = (prefix, endpoint, payload = {}) => page.evaluate(async ({ prefix, endpoint, payload }) => {
    const response = await fetch(`/${prefix}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    if (!response.ok) throw new Error(`${prefix}/${endpoint}: HTTP ${response.status}`)
    const value = await response.json()
    if (value.error) throw new Error(JSON.stringify(value))
    return value.value
  }, { prefix, endpoint, payload })
  assert.equal(await post('cowork-team-probe', 'roundTrip'), true)
  assert.equal(pluginRenewals, 1)
  assert.equal(await page.evaluate(() => ['__FIG_EDITION__', '__FIG_TEAM_FILES__'].some(key => /authorize|credential/i.test(Object.keys(window[key] ?? {}).join(',')))), false)
  console.log('PASS: private Host bridge, device proof, plugin credential renewal and signed team request')
  page.setDefaultTimeout(8_000)
  const item = name => page.getByRole('menuitem', { name, exact: true })
  const gear = page.locator('[data-fig-sidebar-settings]')
  const settings = page.locator('[data-shortcut-modal="settings"]')
  const accountBox = await account.boundingBox()
  const gearBox = await gear.boundingBox()
  assert.ok(accountBox && gearBox && Math.abs(accountBox.x + accountBox.width - gearBox.x) < 1
    && Math.abs(accountBox.y - gearBox.y) < 1 && Math.abs(accountBox.height - gearBox.height) < 1,
    JSON.stringify({ accountBox, gearBox }))
  const hoverColors = () => account.evaluate(button => {
    const footer = button.closest('[class*="_footArea"]')
    return [footer, button, footer.querySelector('[data-fig-sidebar-settings]')].map(node => getComputedStyle(node).backgroundColor)
  })
  await account.hover()
  const hover = await hoverColors()
  assert.notEqual(hover[0], 'rgba(0, 0, 0, 0)')
  assert.deepEqual(hover.slice(1), ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
  await gear.hover()
  assert.deepEqual(await hoverColors(), hover)
  await page.mouse.click(gearBox.x - 2, gearBox.y + 2)
  await item('设置').waitFor()
  await page.keyboard.press('Escape')
  await item('设置').waitFor({ state: 'hidden' })
  await page.mouse.click(gearBox.x + 2, gearBox.y + 2)
  await settings.waitFor()
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })

  await account.click()
  const rootItems = page.locator('.fig-cowork-menu [role="menuitem"]:visible')
  await rootItems.first().waitFor()
  assert.deepEqual(await rootItems.evaluateAll(rows => rows.map(row => row.textContent.trim().replace(/\s+/g, ' '))),
    ['设置⌥⌘,', '主题外观', '界面语言', '版本', '意见反馈', '退出 Cowork 账号'])
  assert.equal(await page.locator('.fig-cowork-menu [aria-haspopup="menu"]').count(), 3)
  assert.ok(await item('设置').getAttribute('aria-keyshortcuts'))
  assert.ok(await rootItems.evaluateAll(rows => rows.every(row => row.querySelector('svg'))))
  await item('设置').click()
  await settings.waitFor()
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })

  await account.click()
  await item('意见反馈').click()
  await until(() => app.evaluate(() => typeof globalThis.coworkBrowser === 'string' && globalThis.coworkBrowser.startsWith('https:')),
    { message: 'Feedback did not open its form in the browser' })
  const accountFocus = () => account.evaluate(element => element === document.activeElement)
  await account.click()
  await item('主题外观').focus()
  await page.keyboard.press('ArrowRight')
  await item('深色').waitFor()
  await page.keyboard.press('ArrowLeft')
  await item('主题外观').waitFor()
  await page.keyboard.press('Escape')
  await until(accountFocus)

  const checkTheme = async (label, scheme) => {
    await account.click()
    await item('主题外观').click()
    await item(label).click()
    await page.waitForFunction(expected => document.documentElement.dataset.dsThemeSource === expected, scheme ?? 'system')
  }
  const boxes = []
  for (const [label, scheme] of [['浅色', 'light'], ['深色', 'dark']]) {
    await checkTheme(label, scheme)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      if (width === 390) {
        const sidebarOpener = page.locator('[data-sidebar-opener]:visible, [data-fig-rail-toggle]:visible').first()
        await sidebarOpener.click()
      }
      await account.click()
      await item('版本').click()
      await item('协作版 · 测试组织').waitFor()
      assert.equal(await item('个人版').locator('svg use[href="#dsw-icon-user-outline-medium"]').count(), 1)
      assert.equal(await item('协作版 · 测试组织').locator('svg use[href="#dsw-icon-users-outline-medium"]').count(), 1)
      const layout = await page.evaluate(() => ({ width: innerWidth, scheme: document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
        scrollWidth: document.documentElement.scrollWidth, menus: [...document.querySelectorAll('[role="menu"]:not([hidden])')]
          .filter(element => element.getClientRects().length).map(element => { const { left, right } = element.getBoundingClientRect(); return { left, right } }) }))
      assert.equal(layout.width, width)
      assert.equal(layout.scheme, scheme)
      assert.ok(layout.scrollWidth <= width, JSON.stringify(layout))
      assert.ok(layout.menus.length && layout.menus.every(({ left, right }) => left >= 0 && right <= width), JSON.stringify(layout))
      boxes.push(layout)
      await page.screenshot({ path: join(evidence, `${scheme}-${width}-version.png`) })
      await account.press('Escape').catch(() => {})
      if (await account.getAttribute('aria-expanded') === 'true') await account.click()
    }
  }
  await writeFile(join(evidence, 'layout.json'), JSON.stringify(boxes, null, 2) + '\n')
  await page.setViewportSize({ width: 1440, height: 900 })
  await checkTheme('跟随系统')
  await account.click()
  await item('界面语言').click()
  const chineseGlyph = await item('简体中文').locator('svg path').first().getAttribute('d')
  const englishGlyph = await item('English').locator('svg path').first().getAttribute('d')
  assert.ok(chineseGlyph && englishGlyph && chineseGlyph !== englishGlyph)
  await page.screenshot({ path: join(evidence, 'team-language.png') })
  await item('English').click()
  const englishAccount = page.getByRole('button', { name: 'Cowork account' })
  await englishAccount.click()
  await item('Language').click()
  await item('简体中文').click()
  await account.waitFor()

  adminConsolePath = '//not-the-cowork-origin.invalid/admin'
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('focus') })
  await account.click()
  assert.equal(await item('租户管理工作台').count(), 0)
  await page.keyboard.press('Escape')
  adminConsolePath = '/admin'
  await until(async () => {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('focus') })
    return await page.evaluate(async () => Boolean((await window.__FIG_EDITION__.read()).adminConsoleUrl))
  })
  await account.click()
  await item('租户管理工作台').click()
  await until(async () => (await app.evaluate(() => globalThis.coworkBrowser)) === `${origin}/admin`)
  console.log('PASS: native account menu, gear, settings, keyboard, themes, language, feedback, administrator capability and narrow layout')
  // DSH's own picker: the organization group first as 「… 组织」 with its default badged 默认;
  // personal groups greyed with the reason while the tenant closes personal models; source icons on the trigger.
  const modelTrigger = page.locator('button[aria-haspopup="menu"][class*="_trigger"]').filter({ has: page.locator('[data-provider-id]') }).first()
  const triggerSource = modelTrigger.locator('[data-fig-model-trigger]')
  await triggerSource.waitFor({ timeout: 30_000 })
  assert.deepEqual([await triggerSource.getAttribute('data-fig-model-source'), await triggerSource.getAttribute('title')], ['organization', '组织提供 · 计入团队额度'])
  const openModels = async () => {
    await modelTrigger.click()
    await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^模型/ }).first().click()
    await page.locator('[role="menu"] [role="group"][data-fig-model-source]').first().waitFor()
  }
  await openModels()
  // In the order shown: DSH puts DeepSeek's API first in the DOM; Fig moves organization groups ahead on screen.
  const groups = () => page.locator('[role="menu"] [role="group"][data-fig-model-source]').evaluateAll(nodes => nodes
    .toSorted((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map(node =>
    [node.getAttribute('data-fig-model-source'), node.querySelector('[data-menu-group-heading]')?.textContent, node.getAttribute('data-fig-model-blocked')]))
  const before = await groups()
  assert.equal(before[0][0], 'organization'); assert.match(before[0][1], / 组织$/)
  assert.deepEqual(before.slice(1).map(group => [group[0], group[2]]), [['personal-api', '组织已停用个人模型'], ['personal-api', '组织已停用个人模型']])
  assert.match(await page.locator('[role="menu"] [role="group"][data-fig-model-source="organization"] [role="menuitemradio"]').first().textContent(), /organization-demo.*默认/)
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  models.allowPersonal = true
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('focus') })
  await until(async () => page.evaluate(async () => (await window.__FIG_EDITION__.read()).allowPersonal === true),
    {timeout:10_000, message:'The tenant policy update did not reach the page'})
  await openModels()
  assert.deepEqual((await groups()).map(group => group[2]), [null, null, null], 'Personal groups open again')
  await page.locator('[role="menu"] [role="group"][data-fig-model-source="personal-api"] [role="menuitemradio"]').first().click()
  await until(async () => await triggerSource.getAttribute('data-fig-model-source') === 'personal-api')
  assert.equal(await triggerSource.getAttribute('title'), '我的 API · 不占团队额度')
  await until(() => page.evaluate(() => window.__figSample?.fileActions === 1))
  const folder = join(state.documents, 'cloud-folder')
  const document = join(state.documents, 'cloud-document.md')
  await mkdir(folder, { recursive: true })
  const session = await post('handoff-probe', 'parent', { workspacePath: state.documents, preset: 'workspace-write', title: 'Cloud file actions' })
  const sessionId = { id: session.id }
  await post('handoff-probe', 'hold', sessionId)
  await post('handoff-probe', 'followup', { ...sessionId, text: 'Offline Cloud Drive file test' })
  await post('handoff-probe', 'call', { ...sessionId, name: 'write', args: { file_path: document, content: '# Cloud file' } })
  await post('outputs-probe', 'declare', { ...sessionId, files: [{ path: document }] })
  await post('handoff-probe', 'stop', sessionId)
  const workspaceRow = page.locator(`[data-row-key="workspace:${session.workspaceId}"]`)
  await workspaceRow.waitFor()
  if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
  await page.locator(`[data-row-key="session:${session.id}"]`).click()

  const uploadFrom = async (trigger, label, paths) => {
    await page.evaluate(() => { window.__figSample.upload = undefined })
    await trigger.click({ button: 'right' })
    await item(label).click()
    const seen = await until(() => page.evaluate(() => window.__figSample?.upload), { message: `No upload callback after ${label}` })
    assert.equal(seen.sessionId, session.id)
    assert.deepEqual(await Promise.all(seen.paths.map(path => realpath(path))), await Promise.all(paths.map(path => realpath(path))))
  }
  const deliveredCard = page.locator('[data-presented-file]').filter({ hasText: 'cloud-document.md' }).getByTitle(document, { exact: true }).last()
  await uploadFrom(deliveredCard, '上传到云盘', [document])
  // The offline turn has no Git diff summary. Exercise rc.5's changed-card markup against the same real file and Session.
  await deliveredCard.evaluate((trigger, path) => {
    const card = document.createElement('div'), button = document.createElement('button'), description = document.createElement('span')
    card.setAttribute('data-changed-files', '')
    card.setAttribute('data-cowork-test-change', '')
    button.textContent = 'cloud-document.md'
    description.id = 'cowork-test-file-description'
    description.textContent = path
    description.hidden = true
    button.setAttribute('aria-describedby', description.id)
    card.append(button, description)
    trigger.closest('[data-presented-file]').after(card)
  }, document)
  const changeCard = page.locator('[data-cowork-test-change] button')
  await uploadFrom(changeCard, '上传到云盘', [document])
  await changeCard.evaluate(trigger => trigger.parentElement.remove())
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.coworkFilePicker = options.properties
      return { canceled: false, filePaths: selected }
    }
  }, [document, folder])
  await uploadFrom(deliveredCard, '选择多个文件或文件夹上传…', [document, folder])
  assert.deepEqual(await app.evaluate(() => globalThis.coworkFilePicker), ['openFile', 'openDirectory', 'multiSelections'])
  await page.keyboard.press('Meta+p')
  const treeFolder = page.locator('[data-files-entry="directory"]').filter({ hasText: 'cloud-folder' }).locator('button').first()
  if (!await treeFolder.waitFor({ timeout: 1500 }).then(() => true, () => false)) await page.keyboard.press('Meta+Alt+p')
  await uploadFrom(treeFolder, '上传到云盘', [folder])
  console.log('PASS: native delivered and changed file menus, file tree folder, Cloud Drive callback, mixed native multi-picker dispatch')

  const teamHome = join(state.profile, 'cowork/profiles', device.profile)
  await writeFile(join(teamHome, 'retained-data'), 'synthetic')
  const sealed = await readFile(join(state.profile, 'cowork/session.json'), 'utf8')
  assert.doesNotMatch(sealed, /fixture-access|fixture-refresh/)
  assert.doesNotMatch(await readFile(join(state.profile, 'cowork/device.json'), 'utf8'), /PRIVATE KEY|fixture-plugin/)
  assert.doesNotMatch(await readFile(join(teamHome, 'fig/profile.json'), 'utf8'), /fixture-access|fixture-refresh|fixture-plugin/)

  await account.click()
  await item('版本').click()
  await clickAndLeave(item('个人版'))
  page = await workbenchPage(app)
  await page.getByRole('button', { name: '切换版本', exact: true }).click()
  await clickAndLeave(item('协作版'))
  page = await workbenchPage(app)
  await page.getByRole('button', { name: 'Cowork 账号' }).waitFor()
  assert.equal(registrations, 1, 'Switching editions does not sign out or enroll again')

  await page.getByRole('button', { name: 'Cowork 账号' }).click()
  await clickAndLeave(page.getByRole('menuitem', { name: '退出 Cowork 账号', exact: true }))
  page = await workbenchPage(app)
  await page.getByRole('button', { name: '切换版本', exact: true }).waitFor()
  await assert.rejects(readFile(join(state.profile, 'cowork/session.json')))
  await signIn()
  page = await workbenchPage(app)
  await page.getByRole('button', { name: 'Cowork 账号' }).waitFor()
  assert.equal(registrations, 1, 'Signing in again with the same device must reuse the Profile')
  assert.equal(await readFile(join(teamHome, 'retained-data'), 'utf8'), 'synthetic')

  // Server-side revocation is reflected in the native screen, while local Profile data remains available.
  revoked = true
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('focus') })
  await startup.getByRole('heading', { name: '重新登录 Cowork' }).waitFor()
  assert.doesNotMatch(await readFile(join(state.profile, 'cowork/device.json'), 'utf8'), /fixture-plugin/)
  await startup.getByRole('button', { name: '回到个人版' }).click()
  page = await workbenchPage(app)
  await page.getByRole('button', { name: '切换版本', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Cowork 账号' }).count(), 0)
  assert.equal(await readFile(join(teamHome, 'retained-data'), 'utf8'), 'synthetic')

  passed = true
  console.log('PASS: native PKCE, state validation, invitation gate, one DSH at a time, organization default, live model policy, sign-out and Profile reuse, revocation and personal return')
} finally {
  if (app) await closeFig(app)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await cleanUp(state.profile, passed)
}
