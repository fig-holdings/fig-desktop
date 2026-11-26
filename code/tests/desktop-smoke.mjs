import { profileLifecycle } from '../scripts/verification-lifecycle.mjs'
import { isolatedProfile, launchFig, until as waitUntil } from '../scripts/isolated-fig.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(code, '../work/verification/desktop')
await mkdir(evidence, { recursive: true })
const real = process.argv.includes('--real')
let prior
if (real && process.argv.includes('--reuse')) {
  try { prior = JSON.parse(await readFile(join(evidence, 'real-result.json'), 'utf8')).dataDirectory } catch { /* First real run has no previous cache. */ }
}
if (prior && !prior.startsWith(evidence + '/real-')) throw new Error('Invalid previous verification directory')
const lifecycle = await profileLifecycle({ evidence, prefix: real ? 'real-' : 'smoke-', reuse: prior, retainForReuse: real, reportName: real ? 'real-lifecycle.json' : 'smoke-lifecycle.json' })
const data = lifecycle.profile
let passed = false
let app
try {
  // --real keeps the (reused) DSH home with its sign-in and the Grok CLI state; see README's verification notes.
  const { env } = await isolatedProfile('desktop', { profile: data, real })
  if (!real) env.FIG_FIXTURE_MODE = 'slow'
  app = lifecycle.track(await launchFig(env, { args: real ? [] : ['--fig-smoke'], timeout: 30_000, language: null }))
} catch (error) { await lifecycle.finish(false); throw error }
const checks = []
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

const until = (check, ms = 10_000) => waitUntil(check, { timeout: ms, message: 'Desktop verification timed out' })

try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.fig))
  await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0))
  if (!real) {
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()), [440, 340])
    assert.equal(await page.locator('.desktop-chrome, .app-icon, .diagnostics, footer').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true)
    await page.screenshot({ path: join(evidence, 'startup.png') })
    checks.push('Compact startup has no duplicate header and fits without vertical scrolling')
  }
  await until(async () => {
    const state = await page.evaluate(() => window.fig.getState())
    if (state.phase === 'failed') throw new Error(JSON.stringify(state))
    return state.phase === 'ready'
  }, real ? 600_000 : 15_000)
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length === 1))
  checks.push('DSH service ready; authenticated page loaded in an isolated WebContentsView')
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()), [1160, 790])
  async function checkLayout() {
    const layout = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { bounds: window.contentView.children[0].getBounds(), content: window.getContentSize() }
    })
    assert.equal(layout.bounds.y, 0)
    assert.equal(layout.bounds.width, layout.content[0])
    assert.equal(layout.bounds.height, layout.content[1])
  }
  await checkLayout()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 720))
  await delay(150)
  await checkLayout()
  assert.equal(await page.locator('.panel').isVisible(), false)
  checks.push('DSH fills the window content area and follows native resize')
  const status = await page.evaluate(() => window.fig.getState())
  await delay(750)
  const inspected = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:'))
    return {
      origin: new URL(wc.getURL()).origin,
      title: wc.getTitle(),
      bridge: await wc.executeJavaScript('typeof window.fig'),
      node: await wc.executeJavaScript('typeof process'),
      image: (await wc.capturePage()).toPNG().toString('base64')
    }
  })
  assert.equal(inspected.bridge, 'undefined')
  assert.equal(inspected.node, 'undefined')
  await writeFile(join(evidence, real ? 'dsh-real.png' : 'fixture.png'), Buffer.from(inspected.image, 'base64'))
  checks.push('DSH page has neither the Fig IPC bridge nor Node.js globals')
  if (!real) {
    const popupCheck = app.evaluate(async ({ BrowserWindow, shell }) => {
      const workbench = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents
      const opened = []
      const original = shell.openExternal
      shell.openExternal = async url => { opened.push(url) }
      async function openBlank() {
        const created = new Promise(resolve => workbench.once('did-create-window', resolve))
        const hasHandle = await workbench.executeJavaScript(`(() => {
          const popup = window.open('about:blank', '_blank')
          if (!popup) return false
          popup.opener = null
          window.fixturePopup = popup
          return true
        })()`, true)
        if (!hasHandle) throw new Error('The DSH renderer did not receive the pending popup')
        return created
      }
      try {
        const popup = await openBlank()
        const hidden = !popup.isVisible()
        const closed = new Promise(resolve => popup.once('closed', resolve))
        await workbench.executeJavaScript(`window.fixturePopup.location.replace('https://example.test/authorize?state=fixture')`)
        await closed
        const cancelled = await openBlank()
        const cancelledClosed = new Promise(resolve => cancelled.once('closed', resolve))
        await workbench.executeJavaScript('window.fixturePopup.close()')
        await cancelledClosed
        const rejected = await openBlank()
        const rejectedClosed = new Promise(resolve => rejected.once('closed', resolve))
        await workbench.executeJavaScript(`window.fixturePopup.location.replace('http://example.test/insecure')`)
        await rejectedClosed
        await workbench.executeJavaScript(`void window.open('https://example.test/docs', '_blank')`, true)
        // The Browser sidebar's "Open in system browser" for a loopback dev server; other schemes stay closed.
        await workbench.executeJavaScript(`void window.open('http://localhost:5173/app', '_blank', 'noopener,noreferrer')`, true)
        await workbench.executeJavaScript(`void window.open('file:///etc/hosts', '_blank')`, true)
        return { hidden, opened, windowCount: BrowserWindow.getAllWindows().length }
      } finally { shell.openExternal = original }
    })
    const timeout = new Promise((_, reject) => {
      AbortSignal.timeout(8000).addEventListener('abort', () => reject(new Error('Login popup handoff timed out')), { once: true })
    })
    const handoff = await Promise.race([popupCheck, timeout])
    assert.deepEqual(handoff, {
      hidden: true,
      opened: ['https://example.test/authorize?state=fixture', 'https://example.test/docs', 'http://localhost:5173/app'],
      windowCount: 1
    })
    checks.push('Deferred HTTPS authorization opens externally; cancel and non-HTTPS navigation close the hidden popup; ordinary HTTP(S) links open externally, file: does not')
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  assert.ok(alive(status.pid))
  checks.push('Closing the window keeps the same DSH process alive')
  await app.evaluate(({ app }) => app.emit('activate'))
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
  assert.equal((await page.evaluate(() => window.fig.getState())).pid, status.pid)
  checks.push('Dock activation restores the window without starting another service')
  let descendants
  if (!real) descendants = JSON.parse(await readFile(join(data, 'fixture.json'), 'utf8'))
  await lifecycle.close(app)
  await until(() => !alive(status.pid))
  if (descendants) await until(() => !alive(descendants.workerPid))
  let groupAlive = true
  try { process.kill(-status.pid, 0) } catch { groupAlive = false }
  assert.equal(groupAlive, false)
  await until(async () => {
    try { await fetch(inspected.origin, { signal: AbortSignal.timeout(300) }); return false } catch { return true }
  })
  checks.push('Full application quit removes the owned process group and closes its listener')
  const result = { mode: real ? 'official-latest' : 'fixture', checks, title: inspected.title, dataDirectory: data, status: 'passed' }
  await writeFile(join(evidence, real ? 'real-result.json' : 'smoke-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  passed = true
} catch (error) {
  try {
    const page = await app.firstWindow()
    await page.screenshot({ path: join(evidence, real ? 'real-failure.png' : 'smoke-failure.png') })
  } catch { /* The failing Electron window might already be closed. */ }
  await lifecycle.close(app).catch(() => {})
  throw error
}

finally { await lifecycle.finish(passed) }
