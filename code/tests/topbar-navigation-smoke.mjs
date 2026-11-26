import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isolatedProfile, launchFig, workbenchPage, cleanUp } from '../scripts/isolated-fig.mjs'
const evidence = resolve('../work/verification/topbar-navigation')
await mkdir(evidence, { recursive: true })
const { profile, env } = await isolatedProfile('topbar-navigation')
let app, passed = false
try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30000 })
  await page.locator('[data-lexical-editor="true"]').first().waitFor()
  const back = page.locator('[data-fig-page-navigation] button').nth(0)
  const forward = page.locator('[data-fig-page-navigation] button').nth(1)
  await page.getByRole('button', { name: '任务动态', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[data-fig-page-navigation] button').disabled)
  await back.click()
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ state: 'visible' })
  assert.equal(await forward.isEnabled(), true)
  await forward.click()
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ state: 'hidden' })
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    const boxes = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
      return { title: box('[data-fig-product-title]'), nav: box('[data-fig-page-navigation]'), toggle: box('[data-sidebar-toggle]') }
    })
    assert.ok(boxes.title.left >= 96 && boxes.title.right + 6 <= boxes.nav.left && boxes.nav.right + 6 <= boxes.toggle.left, JSON.stringify(boxes))
    await page.screenshot({ path: `${evidence}/${theme}.png` })
    await writeFile(`${evidence}/${theme}.html`, await page.content())
  }
  passed = true
  console.log('PASS: native panel Back/Forward navigation; title/nav/toggle spacing; light/dark captures')
} finally { await app?.close(); await cleanUp(profile, passed) }
