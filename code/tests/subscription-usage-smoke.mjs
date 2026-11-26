import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedProfile, launchFig, workbenchPage, cleanUp } from '../scripts/isolated-fig.mjs'
const evidence = new URL('../../work/verification/subscription-rings/', import.meta.url).pathname
await mkdir(evidence, {recursive: true})
const state = await isolatedProfile('subscription-rings', {extraEnv: profile => ({GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: join(profile, 'grok/auth.json'), CODEX_HOME: join(profile, 'codex')})})
let app, page, passed = false
const now = new Date().toISOString()
let signedIn = true, grokPercent = 35, chatPercent = 78
try {
  app = await launchFig(state.env)
  page = await workbenchPage(app)
  // Packaged main injects this sheet; Playwright's direct workbench page bypasses that hook.
  await page.addStyleTag({content: await readFile(new URL('../app/main/workbench.css', import.meta.url), 'utf8')})
  await page.route('**/fig-grok/account', route => route.fulfill({json: {ok: true, value: {signedIn, profile: {initials: 'G'}, billing: {usedPercent: grokPercent, period: 'weekly', fetchedAt: now}}}}))
  await page.route('**/fig-grok/billing', route => route.fulfill({json: {ok: true, value: {billing: {usedPercent: grokPercent, period: 'weekly', fetchedAt: now}}}}))
  await page.route('**/fig-chatgpt/account', route => route.fulfill({json: {ok: true, value: {signedIn}}}))
  await page.route('**/fig-chatgpt/limits', route => route.fulfill({json: {ok: true, value: {source: 'live', fetchedAt: now, windows: [{minutes: 300, usedPercent: 20}, {minutes: 10080, usedPercent: chatPercent}]}}}))
  await page.getByRole('button', {name: /^(继续|Continue)$/}).click()
  await page.locator('[aria-label="预览版说明"]').waitFor({state: 'hidden'}).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('fig:subscription-changed')))
  const g = page.locator('[data-fig-subscription-usage="grok"]'), c = page.locator('[data-fig-subscription-usage="chatgpt"]')
  await g.waitFor(); await c.waitFor()
  await page.waitForFunction(() => document.querySelector('[data-fig-subscription-usage="chatgpt"]').getAttribute('aria-label').includes('78%'))
  const boxes = async () => [await g.boundingBox(), await c.boundingBox()]
  let [gb, cb] = await boxes()
  assert.ok(Math.abs(gb.y - cb.y) < 1 && cb.x > gb.x, 'expanded rings horizontal')
  const login = page.locator('[data-slot="settings.launcher"] button[data-signed-out]')
  assert.ok(gb.y + gb.height <= (await login.boundingBox()).y, 'rings above account')
  await g.hover(); await page.getByRole('tooltip').waitFor()
  assert.match(await page.getByRole('tooltip').innerText(), /Grok.*\n.*35%/)
  const gear = page.locator('[data-fig-sidebar-settings]')
  const alignment = []
  for (const width of [1024, 1440, 1920, 2560, 390]) {
    await page.setViewportSize({width, height: 900})
    if (width === 390) await page.locator('[data-sidebar-opener]').click()
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))) })
    const gearRect = await gear.boundingBox()
    const row = await page.locator('[data-slot="sidebar"] [class*="_settingsArea"]').boundingBox()
    const account = await login.boundingBox()
    alignment.push({width, gear: gearRect, row, account})
    assert.ok(Math.abs(gearRect.x + gearRect.width - row.x - row.width) < 1, `gear right edge aligns with account row at ${width}: ${JSON.stringify(alignment.at(-1))}`)
    assert.ok(Math.abs(gearRect.y + gearRect.height / 2 - account.y - account.height / 2) < 1, `gear vertically centered at ${width}: ${JSON.stringify(alignment.at(-1))}`)
  }
  await page.setViewportSize({width: 1440, height: 900})
  await g.hover(); await page.getByRole('tooltip').waitFor()
  const backgrounds = () => page.evaluate(() => {
    const ring = document.querySelector('[data-fig-subscription-usage="grok"]')
    return [ring.closest('[class*="_footArea"]'), ring, document.querySelector('[data-fig-subscription-usage="chatgpt"]'), document.querySelector('[data-fig-sidebar-settings]'), ring.closest('[class*="_footArea"]').querySelector('[class*="_settingsArea"]')].map(el => getComputedStyle(el).backgroundColor)
  })
  let bg = await backgrounds()
  assert.equal(bg[0], 'rgba(0, 0, 0, 0)'); assert.notEqual(bg[1], bg[0]); assert.equal(bg[2], bg[0]); assert.equal(bg[3], bg[0])
  await gear.hover(); bg = await backgrounds()
  assert.equal(bg[0], 'rgba(0, 0, 0, 0)'); assert.equal(bg[1], bg[0]); assert.equal(bg[2], bg[0]); assert.equal(bg[3], bg[0]); assert.notEqual(bg[4], bg[0])
  const sharedHover = bg[4]
  await login.hover(); assert.equal((await backgrounds())[4], sharedHover)
  await login.click(); await page.getByRole('menuitem', {name: '登录', exact: true}).waitFor(); await page.keyboard.press('Escape')
  const gearBox = await gear.boundingBox()
  await page.mouse.click(gearBox.x - 2, gearBox.y + 2)
  await page.getByRole('menuitem', {name: '登录', exact: true}).waitFor(); await page.keyboard.press('Escape')
  await gear.click(); await page.locator('[data-shortcut-modal="settings"]').waitFor()
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', {name: '关闭', exact: true}).click()
  await g.click()
  await page.getByRole('heading', {name: 'Grok 账号', exact: true}).waitFor()
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', {name: '关闭', exact: true}).click()
  await c.focus(); await page.keyboard.press('Enter')
  await page.getByRole('heading', {name: 'ChatGPT 账号', exact: true}).waitFor()
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', {name: '关闭', exact: true}).click()
  await page.mouse.move(350, 200)
  await c.evaluate(el => el.blur())
  await c.focus(); assert.match(await page.getByRole('tooltip').innerText(), /78%/)
  await page.keyboard.press('Escape'); await page.getByRole('tooltip').waitFor({state: 'hidden'})
  await page.locator('[data-slot="sidebar"]').getByRole('button', {name: '收起左侧栏'}).click()
  await page.waitForFunction(() => {const a = document.querySelector('[data-fig-subscription-usage="grok"]').getBoundingClientRect(), b = document.querySelector('[data-fig-subscription-usage="chatgpt"]').getBoundingClientRect(); return b.y > a.y && Math.abs(a.x-b.x)<1})
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({width:1440,height:900})
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))) })
    await login.click()
    await page.getByRole('menuitem', {name: '主题外观'}).hover()
    await page.getByRole('menuitemradio', {name: theme === 'dark' ? '深色' : '浅色', exact: true}).click()
    await page.emulateMedia({colorScheme: theme})
    await page.emulateMedia({reducedMotion: 'reduce'})
    for (const width of [1024, 1440, 1920, 2560, 390]) {
      await page.setViewportSize({width, height: 900})
      if (width === 390) await page.locator('[data-sidebar-opener]').click()
      if (width !== 390 && !await gear.isVisible()) await page.locator('[data-fig-rail-toggle]').click()
      await gear.waitFor({state: 'visible'})
      await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))) })
      const b = await gear.boundingBox(), a = await login.boundingBox()
      assert.ok(Math.abs(b.y + b.height/2 - a.y - a.height/2)<1, `${theme} ${width} gear center`)
      const row = await page.locator('[data-slot="sidebar"] [class*="_settingsArea"]').boundingBox()
      assert.ok(Math.abs(b.x + b.width - row.x - row.width)<1, `${theme} ${width} gear right edge`)
      await c.hover(); await page.getByRole('tooltip').waitFor()
      await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))) })
      const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth-innerWidth))
      assert.equal(overflow, 0)
      await page.waitForFunction(() => [...document.querySelectorAll('[data-fig-subscription-usage]')].every(el => {for(let n=el;n;n=n.parentElement) if (getComputedStyle(n).opacity === '0' || n.className?.includes?.('_fading')) return false; return true}))
      await page.screenshot({path: join(evidence, `${theme}-${width}-collapsed.png`)})
      // Save the actual rendered DOM (including built plugin CSS) for preview diagnostics.
      await writeFile(join(evidence, `${theme}-${width}.html`), await page.evaluate(() => { const clone = document.documentElement.cloneNode(true); clone.querySelectorAll('script,link').forEach(node => node.remove()); const style = document.createElement('style'); style.textContent = [...document.styleSheets, ...document.adoptedStyleSheets].flatMap(sheet => {try {return [...sheet.cssRules].map(rule => rule.cssText)} catch {return []}}).join('\n'); clone.querySelector('head').append(style); return '<!doctype html>' + clone.outerHTML }))
      if (width === 390) await page.keyboard.press('Escape')
    }
  }
  grokPercent = 60; chatPercent = 91
  await page.evaluate(() => window.dispatchEvent(new Event('fig:subscription-changed')))
  await page.waitForFunction(() => document.querySelector('[data-fig-subscription-usage="chatgpt"] circle[pathLength]').getAttribute('stroke') === '#e5484d')
  assert.equal(await g.locator('circle[pathLength]').getAttribute('stroke'), '#d99a16')
  signedIn = false
  await page.evaluate(() => window.dispatchEvent(new Event('fig:subscription-changed')))
  await g.waitFor({state: 'hidden'}); await c.waitFor({state: 'hidden'})
  passed = true
  await writeFile(join(evidence, 'result.json'), JSON.stringify({status: 'pass', widths: [390,1024,1440,1920,2560], alignment, themes: ['light','dark'], interactions: ['expanded horizontal', 'collapsed vertical', 'above account', 'independent hover surfaces', 'click Grok account', 'keyboard Enter ChatGPT account', 'hover', 'keyboard focus/Escape', 'refresh thresholds', 'sign-out hides'], overflow: 0}, null, 2))
  console.log('PASS subscription rings:', evidence)
} catch (error) { await page?.screenshot({path: join(evidence, 'failure.png')}); console.error(await page?.locator('[data-slot="sidebar.footer.action"]').evaluate(el => ({html:el.outerHTML, parent:el.parentElement.outerHTML.slice(0,300), display:getComputedStyle(el).display, direction:getComputedStyle(el).flexDirection, collapsed:document.querySelector('[data-sidebar-collapsed]')?.outerHTML.slice(0,200)}))); throw error } finally { await app?.close(); await cleanUp(state.profile, passed) }
