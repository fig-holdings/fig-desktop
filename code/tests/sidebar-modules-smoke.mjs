import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isolatedProfile, launchFig, workbenchPage, cleanUp } from '../scripts/isolated-fig.mjs'

const evidence = fileURLToPath(new URL('../../work/verification/sidebar-modules/', import.meta.url))
await mkdir(evidence, { recursive: true })
const state = await isolatedProfile('sidebar-modules')
let app, page, passed = false
const checks = [], errors = []
async function capture(name) {
  const shell = await readFile(new URL('../app/main/workbench.css', import.meta.url), 'utf8')
  await page.screenshot({ path: `${evidence}/${name}.png` })
  await writeFile(`${evidence}/${name}.html`, await page.evaluate(shell => {
    const clone = document.documentElement.cloneNode(true)
    clone.querySelectorAll('script,link,img').forEach(n => n.remove())
    const style = document.createElement('style')
    style.textContent = [...document.styleSheets, ...document.adoptedStyleSheets].flatMap(s => {
      try { return [...s.cssRules].map(r => r.cssText) } catch { return [] }
    }).join('\n') + '\n' + shell
    clone.querySelector('head').append(style)
    return '<!doctype html>' + clone.outerHTML
  }, shell))
}
try {
  app = await launchFig(state.env)
  page = await workbenchPage(app)
  page.on('pageerror', e => errors.push(e.message))
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click()
  await page.locator('[data-lexical-editor="true"]').first().waitFor()
  const sidebar = page.locator('[data-slot="sidebar"]').first()
  // All currently pinned modules, including DSH and Fig contributions, not a hand-picked list.
  const modules = await sidebar.locator('button:has([data-slot="sidebar.panellist"])').evaluateAll(nodes => nodes.map(n => ({ label: n.getAttribute('aria-label') })))
  assert.ok(modules.length >= 3, 'Discover all pinned module buttons')
  for (const theme of ['light', 'dark']) {
    await sidebar.locator('[data-slot="settings.launcher"] button[data-signed-out]').click()
    await page.getByRole('menuitem', { name: '主题外观', exact: true }).hover()
    await page.getByRole('menuitemradio', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click()
    for (const module of [{ id: null, label: '新建会话' }, ...modules]) {
      await sidebar.getByRole('button', { name: module.label, exact: true }).filter({ visible: true }).first().click()
      // DSH may collapse automatically when opening a module; never click its hidden native control.
      if (!await page.locator('[data-sidebar-collapsed]').count()) await sidebar.locator('[data-sidebar-toggle]').first().click()
      const toggle = page.locator('[data-fig-rail-toggle]')
      await toggle.waitFor({ state: 'visible' })
      assert.equal(await toggle.count(), 1)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(150)
        const layout = await toggle.evaluate(n => {
          const b = n.getBoundingClientRect()
          return { left: b.left, top: b.top, width: b.width, height: b.height, hit: n.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)), overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth) }
        })
        assert.equal(layout.overflow, 0, JSON.stringify({ module, theme, width, layout }))
        assert.equal(layout.hit, true, JSON.stringify({ module, theme, width, layout }))
        assert.equal(layout.left, 84)
        checks.push({ module: module.label, theme, viewportWidth: width, ...layout })
        if (module === modules[0]) await capture(`${theme}-${width}`)
        // Real click (and keyboard activation at the narrow viewport), not screenshot-only verification.
        if (width === 390) { await toggle.focus(); await page.keyboard.press('Enter') } else await toggle.click()
        await toggle.waitFor({ state: 'hidden' })
        // At phone widths DSH opens a temporary sidebar overlay; restore the desktop viewport
        // before collapsing again, rather than racing its responsive overlay transition.
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.waitForTimeout(400)
        if (!await page.locator('[data-sidebar-collapsed]').count()) await sidebar.locator('[data-sidebar-toggle]').first().click()
        await toggle.waitFor({ state: 'visible' })
      }
      await toggle.click()
      await toggle.waitFor({ state: 'hidden' })
      await page.waitForTimeout(350)
    }
  }
  assert.deepEqual(errors, [])
  await writeFile(`${evidence}/result.json`, JSON.stringify({ status: 'pass', modules, checks, errors, interactions: ['every pinned module opens', 'collapse/restore on every module in both themes and widths', 'Enter restores at 390px'], scope: 'isolated DSH, no real accounts or model calls' }, null, 2))
  passed = true
  console.log('PASS', evidence)
} catch (error) { await page?.screenshot({ path: `${evidence}/failure.png` }); throw error }
finally { await app?.close(); await cleanUp(state.profile, passed) }
