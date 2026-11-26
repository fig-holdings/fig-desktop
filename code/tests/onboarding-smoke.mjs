import { profileLifecycle } from '../scripts/verification-lifecycle.mjs'
import { launchFig, until, isolatedProfile } from '../scripts/isolated-fig.mjs'
import { startRendererServer } from './helpers/renderer-server.mjs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(code, '../work/verification/desktop')
await mkdir(evidence, { recursive: true })
// Keep spaces in the durable data path: only the executable npm cache needs the workaround.
const lifecycle = await profileLifecycle({ evidence, prefix: 'onboarding home ', reportName: 'onboarding-lifecycle.json' })
const data = lifecycle.profile
let passed = false
const dev = process.argv.includes('--dev')
let vite
let application
const checks = []
const launches = []

async function startDevelopmentServer() {
  vite = await startRendererServer()
  return vite.url
}

async function open(env, { chooseFolder = false } = {}) {
  application = lifecycle.track(await launchFig(env, { timeout: 30_000, language: null }))
  const startup = await application.firstWindow()
  await startup.waitForFunction(() => Boolean(window.fig))
  let asked = false
  const page = await until(async () => {
    const state = await startup.evaluate(() => window.fig.getState())
    if (state.startupChoice) {
      if (!chooseFolder) throw new Error('The first-run folder step appeared on a launch that has a saved folder')
      if (!asked) {
        asked = true
        assert.equal(state.startupChoice.suggested, join(data, 'Fig'))
        await startup.getByRole('heading', { name: '选择启动目录' }).waitFor()
        await startup.getByText(state.startupChoice.suggested, { exact: true }).waitFor()
        assert.equal(await startup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no horizontal overflow')
        await startup.screenshot({ path: join(evidence, dev ? 'first-run-folder-dev.png' : 'first-run-folder.png') })
        await startup.getByRole('button', { name: '使用此目录' }).click()
      }
      return undefined
    }
    if (state.phase === 'failed') throw new Error(`DSH startup failed: ${state.error}\n${state.logs.join('\n')}`)
    const page = application.context().pages().find(item => item !== startup && item.url().startsWith('http://127.0.0.1:'))
    if (state.phase !== 'ready' || !page) return undefined
    await page.locator('body').waitFor()
    launches.push(state.pid)
    return page
  }, { timeout: 300_000, message: 'Official DSH did not become ready' })
  if (chooseFolder !== asked) throw new Error('The first-run folder step did not appear on a launch without a saved folder')
  return page
}

async function checkWorkbench(page) {
  // The current DSH shows the new-session composer after acknowledgement.
  // Opening its workspace picker also checks that no modal is blocking the page.
  const workspace = page.getByRole('button', { name: /^(选择工作区|Choose workspace)$/ })
  await workspace.click({ timeout: 30_000 })
  const menu = page.getByRole('menu')
  await menu.waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
}

try {
  const rendererUrl = dev ? await startDevelopmentServer() : undefined
  // The startup Workspace, DSH's Documents folder, agents home and Grok CLI state all stay in the profile.
  const { env: isolated } = await isolatedProfile('onboarding', { profile: data })
  // No preset startup folder: this instance behaves like a new user's first launch inside the profile.
  const env = { ...isolated, FIG_DESKTOP_FIRST_RUN: '1', ...(rendererUrl ? { ELECTRON_RENDERER_URL: rendererUrl, NODE_ENV: 'development' } : {}) }
  delete env.FIG_DESKTOP_WORKSPACE_DIR
  let page = await open(env, { chooseFolder: true })
  const chosen = await realpath(join(data, 'Fig'))
  assert.ok((await stat(chosen)).isDirectory())
  assert.deepEqual(JSON.parse(await readFile(join(data, 'directory-settings.json'), 'utf8')), { schema: 1, startup: chosen })
  checks.push('A launch without a saved folder asks first, suggests <home>/Fig, creates it on confirmation and saves it before DSH starts')
  const continueButton = page.getByRole('button', { name: /^(继续|Continue)$/ })
  await continueButton.waitFor({ timeout: 30_000 })
  const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/settings/mutate')
  await continueButton.click()
  const result = await (await response).json()
  assert.equal(result.result?.ok, true, 'Official Host must accept the welcome settings write')
  await continueButton.waitFor({ state: 'hidden', timeout: 15_000 })
  assert.equal(await page.getByText(/暂时无法保存确认状态|The acknowledgement could not be saved/).isVisible(), false)
  checks.push('A fresh official DSH profile accepts Continue through settings.mutate')
  const patch = await readFile(join(data, 'dsh/profiles/web/cordis.patch.yml'), 'utf8')
  assert.match(patch, /welcomeNoticeVersion:/)
  checks.push('Acknowledgement is persisted by DSH in the profile patch')
  await page.reload()
  await checkWorkbench(page)
  assert.equal(await continueButton.isVisible(), false)
  checks.push('Reload reaches the workbench without repeating the welcome notice')
  await lifecycle.close(application)
  application = undefined
  page = await open(env)
  await checkWorkbench(page)
  assert.equal(await page.getByRole('button', { name: /^(继续|Continue)$/ }).isVisible(), false)
  checks.push('A full Fig/DSH restart preserves acknowledgement with a spaced data path, without asking for a folder again')
  assert.notEqual(launches[0], launches[1])
  await page.screenshot({ path: join(evidence, dev ? 'onboarding-dev.png' : 'onboarding.png') })
  const report = { status: 'passed', mode: dev ? 'development' : 'production', dataDirectory: data, checks,
    scope: 'First-run folder choice (suggested folder only; the native folder dialog is not driven) and official first-run confirmation; no account configuration or model calls' }
  await writeFile(join(evidence, dev ? 'onboarding-dev-result.json' : 'onboarding-result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  passed = true
} finally {
  await lifecycle.close(application).catch(error => { passed = false; console.error(error) })
  await vite?.close()
  await lifecycle.finish(passed)
}
