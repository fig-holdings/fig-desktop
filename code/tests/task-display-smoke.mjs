import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedProfile, launchFig, workbenchPage, cleanUp } from '../scripts/isolated-fig.mjs'
const evidence = fileURLToPath(new URL('../../work/verification/task-display/', import.meta.url)); await mkdir(evidence, { recursive: true })
const state = await isolatedProfile('task-display')
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([{ id: 'workspace-controller', config: { documentsDirectory: state.documents } }, { insert: [{ id: 'handoff-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url)) }, { id: 'task-process-probe', name: fileURLToPath(new URL('./fixtures/task-process-probe.mjs', import.meta.url)) }] }]))
let app, page, passed = false
const checks = [], errors = []
async function probe(endpoint, payload) { return page.evaluate(async ({ endpoint, payload }) => { const r = await (await fetch('/handoff-probe/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json(); if (r.error) throw new Error(JSON.stringify(r)); return r.value }, { endpoint, payload }) }
async function capture(name) {
  await page.screenshot({ path: join(evidence, name + '.png') })
  const shell = await readFile(new URL('../app/main/workbench.css', import.meta.url), 'utf8')
  await writeFile(join(evidence, name + '.html'), await page.evaluate(shell => {
    const clone = document.documentElement.cloneNode(true); clone.querySelectorAll('script,link,img').forEach(n => n.remove())
    const style = document.createElement('style'); style.textContent = [...document.styleSheets, ...document.adoptedStyleSheets].flatMap(s => { try { return [...s.cssRules].map(r => r.cssText) } catch { return [] } }).join('\n') + '\n' + shell; clone.querySelector('head').append(style); return '<!doctype html>' + clone.outerHTML
  }, shell))
}
try {
  app = await launchFig(state.env); page = await workbenchPage(app); page.on('pageerror', e => errors.push(e.message))
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click()
  const advance = step => page.evaluate(async step => { const r = await (await fetch('/task-process-probe/advance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(step) })).json(); if (r.error) throw new Error(JSON.stringify(r)); return r.value }, step)
  const item = await probe('parent', { workspacePath: state.documents, preset: 'workspace-write', title: 'Task display regression', route: { provider: 'synthetic-process', model: 'offline' } })
  await probe('followup', { id: item.id, text: 'Offline task display test' })
  const group = page.locator(`[data-row-key="workspace:${item.workspaceId}"]`); await group.waitFor(); if (await group.getAttribute('aria-expanded') !== 'true') await group.click(); await page.locator(`[data-row-key="session:${item.id}"]`).click()
  const todos = [{ content: 'Inspect current implementation', status: 'completed' }, { content: 'Verify task and process display', status: 'in_progress' }, { content: 'Deliver verified result', status: 'pending' }]
  await advance({ name: 'todo_write', args: { todos } })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForTimeout(600)
  if (!await page.locator('[data-fig-workbench]').isVisible()) await page.locator('[data-fig-workbench-button]').click()
  const tasks = page.locator('[data-fig-workbench-tasks] [data-testid="todo-panel"]')
  await tasks.waitFor({ timeout: 10000 })
  console.log('NATIVE TASKS', await tasks.innerText())
  await tasks.locator('button').click()
  assert.equal(await tasks.locator('li').count(), 3)
  const dock = page.locator('[data-slot="conversation.input.dock"] [data-testid="todo-panel"]')
  assert.equal(await dock.locator('button').getAttribute('aria-expanded'), 'false', 'The two disclosures are independent')
  await dock.locator('button').click()
  assert.equal(await dock.locator('li').count(), 3)
  assert.deepEqual(await tasks.locator('li').allTextContents(), await dock.locator('li').allTextContents())
  const process = page.locator('[data-step-process]').last()
  await process.waitFor()
  assert.equal(await process.locator('button[aria-controls]').first().getAttribute('aria-expanded'), 'false')
  const summary = await process.locator('button[aria-controls]').first().innerText()
  await advance({ name: 'bash', args: { description: 'Verify dynamic process summary', command: 'node -e "setTimeout(()=>console.log(123),8000)"' } })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-step-process] button[aria-controls]')].some(n => n.textContent.includes('Verify dynamic process summary') && !n.textContent.includes('准备')))
  console.log('PROCESS', summary, await process.innerText())
  checks.push({ nativeTasks: true, initialSummary: summary, nextSummary: await process.locator('button[aria-controls]').first().innerText() })
  await process.locator('button[aria-controls]').first().click()
  assert.equal(await process.locator('button[aria-controls]').first().getAttribute('aria-expanded'), 'true')
  await advance({ name: 'read', args: { file_path: join(state.documents, 'missing-test-file.txt') } })
  await page.waitForTimeout(8500)
  assert.equal(await process.locator('button[aria-controls]').first().getAttribute('aria-expanded'), 'true')
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('[data-slot="sidebar"]').first().locator('[data-slot="settings.launcher"] button[data-signed-out]').click(); await page.getByRole('menuitem', { name: '主题外观', exact: true }).hover(); await page.getByRole('menuitemradio', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click()
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await page.waitForTimeout(350)
      if (width === 390) await page.locator('[data-fig-workbench-button]').click()
      await tasks.waitFor()
      if (await tasks.locator('button').getAttribute('aria-expanded') === 'false') await tasks.locator('button').click()
      assert.equal(await tasks.locator('li').count(), 3)
      await capture(`${theme}-${width}`)
      const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)); assert.equal(overflow, 0)
      checks.push({ theme, width, overflow })
      if (width === 390) await page.keyboard.press('Escape')
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await advance({ name: 'ask_user_question', args: { questions: [{ id: 'offline-question', question: 'Offline visible question?', options: [{ label: 'Continue offline' }] }] } })
  await page.getByText('Offline visible question?', { exact: true }).waitFor({ state: 'visible' })
  checks.push({ questionVisibleWithoutOpeningNewProcess: true })
  await probe('stop', { id: item.id })
  await page.reload()
  await page.locator('[data-fig-workbench-button]').waitFor()
  assert.equal(JSON.parse(await readFile(join(state.dshHome, 'fig/process-default.json'), 'utf8')).applied, true)
  checks.push({ reloadedPreferenceMarker: true })
  assert.deepEqual(errors, [])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: 'pass', checks, errors }, null, 2)); passed = true; console.log('PASS', evidence)
} catch (e) { if (page) { console.log('TASK DOM', await page.locator('[data-fig-workbench-tasks]').count(), await page.locator('[data-fig-workbench]').innerText().catch(() => 'not open')); await writeFile(join(evidence, 'failure.html'), await page.content()) }; await page?.screenshot({ path: join(evidence, 'failure.png') }); throw e } finally { await app?.close(); await cleanUp(state.profile, passed) }
