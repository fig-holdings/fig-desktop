import { profileLifecycle } from '../scripts/verification-lifecycle.mjs'
import { launchFig, until } from '../scripts/isolated-fig.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(code, '../work/verification/desktop')
await mkdir(evidence, { recursive: true })
const lifecycle = await profileLifecycle({ evidence, prefix: 'error-', reportName: 'error-lifecycle.json' })
const data = lifecycle.profile
let passed = false
const env = { ...process.env, FIG_DESKTOP_DATA_DIR: data, FIG_FIXTURE_MODE: 'fail' }
delete env.ELECTRON_RUN_AS_NODE
let app
try { app = lifecycle.track(await launchFig(env, { args: ['--fig-smoke'], language: null })) } catch (error) { await lifecycle.finish(false); throw error }
const waitForDshPage = () => until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length === 1),
  { timeout: 8000, interval: 50, message: 'DSH view did not attach' })
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '重新尝试' }).waitFor()
  assert.equal((await page.evaluate(() => window.fig.getState())).phase, 'failed')
  await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0))
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.locator('.wordmark img').getAttribute('alt'), 'Fig Desktop')
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()), [440, 340])
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.locator('.diagnostics summary').click()
  await page.locator('.diagnostics pre').waitFor({ state: 'visible' })
  await page.locator('.diagnostics summary').click()
  await page.screenshot({ path: join(evidence, 'error-light.png') })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.waitForFunction(() => document.querySelector('.wordmark img').currentSrc.includes('wordmark-reverse'))
  await page.screenshot({ path: join(evidence, 'error-dark.png') })
  await page.setViewportSize({ width: 375, height: 700 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(evidence, 'error-narrow.png') })
  await app.evaluate(() => { delete process.env.FIG_FIXTURE_MODE })
  await page.getByRole('button', { name: '重新尝试' }).click()
  await page.waitForFunction(async () => (await window.fig.getState()).phase === 'ready')
  await waitForDshPage()
  await app.evaluate(() => { process.env.FIG_FIXTURE_MODE = 'bad-page' })
  await page.evaluate(() => window.fig.retry())
  try { await page.getByText('工作台未能打开', { exact: true }).waitFor({ timeout: 8000 }) } catch (error) {
    console.log('Page failure diagnostic:', await page.evaluate(() => window.fig.getState()))
    console.log('View diagnostic:', await app.evaluate(({ webContents, BrowserWindow }) => ({ count: BrowserWindow.getAllWindows()[0].contentView.children.length, pages: webContents.getAllWebContents().map(w => ({ type: w.getType(), url: w.getURL().split('?')[0], title: w.getTitle() })) })))
    throw error
  }
  await app.evaluate(() => { delete process.env.FIG_FIXTURE_MODE })
  await page.getByRole('button', { name: '重新尝试' }).click()
  await page.waitForFunction(async () => (await window.fig.getState()).phase === 'ready')
  await waitForDshPage()
  assert.ok(!(await page.evaluate(() => JSON.stringify(window.fig.getState()))).includes('fixture-token'))
  await lifecycle.close(app)
  const checks = ['failed startup fits the compact window', 'light/dark and reduced-motion states render', '375px layout has no horizontal overflow', 'retry starts a fresh service', 'page-load failure is recoverable', 'renderer state excludes launch token']
  await writeFile(join(evidence, 'error-result.json'), JSON.stringify({ status: 'passed', checks }, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2))
  passed = true
} finally { await lifecycle.close(app).catch(error => { passed = false; console.error(error) }); await lifecycle.finish(passed) }
