import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evidenceDir } from './fig-smoke.mjs'

export async function chooseSubscriptionMenuModels(page, { id, prefix, account }, dshHome, reopen) {
  const settingsFile = join(dshHome, 'fig', `${account}-model-menu.json`)
  const saveRoute = `**/fig-${account}/models/save`
  const section = page.getByRole('region', { name: '模型菜单', exact: true })
  const summary = section.locator('summary')
  const chosen = section.getByRole('checkbox', { name: id, exact: true })
  const previous = section.getByRole('checkbox', { name: `${prefix}-previous`, exact: true })
  const save = section.getByRole('button', { name: '保存选择', exact: true })
  await summary.getByText('已显示 1 / 2 个', { exact: true }).waitFor()
  assert.equal(await chosen.isVisible(), false, 'the catalog is collapsed by default')
  await summary.press('Enter')
  assert.equal(await previous.isChecked(), true, 'one compatible model is shown initially')
  assert.equal(await chosen.isChecked(), false, 'newly discovered models are not automatically added')
  assert.equal(await section.getByRole('checkbox', { name: `${prefix}-unconfirmed` }).isDisabled(), true)
  await previous.press('Space')
  await chosen.press('Space')
  await section.getByRole('button', { name: '撤销修改', exact: true }).click()
  assert.equal(await chosen.isChecked(), false)
  await previous.uncheck()
  await chosen.check()
  await section.getByText(/^取消勾选不会删除会话。/).waitFor()
  await page.route(saveRoute, route => route.fulfill({ status: 500, json: { ok: false } }))
  await save.click()
  await section.getByRole('alert').waitFor()
  assert.equal(await chosen.isChecked(), true, 'a failed save retains the draft')
  await assert.rejects(readFile(settingsFile), { code: 'ENOENT' })
  await page.unroute(saveRoute)
  await save.click()
  await section.getByText('模型菜单已更新。', { exact: true }).waitFor()
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { ids: [id] })
  await page.keyboard.press('Escape')
  await reopen()
  await summary.click()
  assert.equal(await chosen.isChecked(), true, 'reopening settings keeps the saved selection')
  assert.equal(await previous.isChecked(), false)

  const evidence = await evidenceDir(`${account}-model-menu`)
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate(theme => document.documentElement.setAttribute('data-dsw-theme', theme), theme)
    await summary.scrollIntoViewIfNeeded()
    const layout = await section.evaluate(el => ({
      width: innerWidth, documentOverflow: document.documentElement.scrollWidth - innerWidth,
      sectionOverflow: el.scrollWidth - el.clientWidth,
      sectionLeft: el.getBoundingClientRect().left, sectionRight: el.getBoundingClientRect().right,
      listOverflow: el.querySelector('ul').scrollWidth - el.querySelector('ul').clientWidth,
      card: getComputedStyle(el.querySelector('details')).backgroundColor
    }))
    assert.equal(layout.width, width)
    assert.ok(layout.documentOverflow <= 1 && layout.sectionOverflow <= 1 && layout.listOverflow <= 1
      && layout.sectionLeft >= -1 && layout.sectionRight <= width + 1, JSON.stringify(layout))
    await page.screenshot({ path: join(evidence, `${width}-${theme}.png`), animations: 'disabled' })
    console.log('PASS', account, 'model settings layout', theme, layout)
  }
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.evaluate(() => document.documentElement.setAttribute('data-dsw-theme', 'light'))
}

export async function verifySubscriptionMedium(page, account) {
  const trigger = page.getByRole('button', { name: /^选择模型.*Medium/ }).first()
  await trigger.click()
  await page.getByRole('menuitem', { name: /^推理等级/ }).first().click()
  assert.equal(await page.getByRole('menuitemradio', { name: 'Medium', exact: true }).getAttribute('aria-checked'), 'true')
  assert.equal(await page.getByRole('menuitemradio', { name: 'Default', exact: true }).count(), 0)
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
  await page.getByRole('button', { name: /^选择模型.*High/ }).first().click()
  await page.getByRole('menuitem', { name: /^推理等级/ }).first().click()
  assert.equal(await page.getByRole('menuitemradio', { name: 'High', exact: true }).getAttribute('aria-checked'), 'true')
  await page.getByRole('menuitemradio', { name: 'Medium', exact: true }).click()
  console.log('PASS', account, 'picker defaults to Medium, removes Default, and honors a manual High choice')
}
