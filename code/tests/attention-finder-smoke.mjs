import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { isolatedProfile, cleanUp, until } from '../scripts/isolated-fig.mjs'
import { exited } from '../scripts/verification-lifecycle.mjs'
const bundle = process.argv.find(a => a.startsWith('--bundle='))?.slice(9)
const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11)
assert.ok(bundle && evidence); await mkdir(evidence)
const state = await isolatedProfile('attention-finder', {extraEnv: p => ({GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json')})})
const report = {status: 'fail', startedAt: new Date().toISOString(), mechanism: 'LaunchServices /usr/bin/open, signed verification bundle; isolated profile, no terminal Node/PATH dependency'}
const stderr = join(evidence, 'launch-stderr.log')
let socket, browser, ownedPid
const wait = check => until(check, {timeout: 90000, message: 'LaunchServices startup timeout'})
let sequence = 0
const pending = new Map()
function evaluate(expression) {
  const id = ++sequence
  return new Promise((resolve, reject) => { pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}})) })
}
try {
  await promisify(execFile)('/usr/bin/open', ['-n', bundle, '--stderr', stderr, '--env', 'FIG_DESKTOP_DATA_DIR=' + state.profile, '--args', '--inspect=0', '--remote-debugging-port=0'])
  const addresses = await wait(async () => {
    const log = await readFile(stderr, 'utf8').catch(() => '')
    const node = log.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]
    const chrome = log.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]
    return node && chrome ? {node, chrome} : undefined
  })
  socket = new WebSocket(addresses.node)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true}) })
  socket.addEventListener('message', event => { const value = JSON.parse(String(event.data)); const item = pending.get(value.id); if (item) { pending.delete(value.id); value.error || value.result?.exceptionDetails ? item.reject(new Error('Inspector evaluation failed')) : item.resolve(value.result) } })
  ownedPid = (await evaluate('process.pid')).result.value
  report.ownedPid = ownedPid
  browser = await chromium.connectOverCDP(addresses.chrome)
  const context = browser.contexts()[0]
  const page = await wait(() => context.pages().find(p => p.url().startsWith('http://127.0.0.1:')))
  await page.getByRole('button', {name: /^(Continue|继续)$/}).click()
  await page.locator('[data-slot="sidebar"]').waitFor()
  report.workbenchLoaded = true
  const result = await page.evaluate(async () => (await fetch('/fig-attention/info', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).json())
  assert.ok(result.ok); report.hostGenerationPresent = typeof result.value.generation === 'string'
  await page.screenshot({path: join(evidence, 'launchservices-workbench.png')})
  report.status = 'pass'
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  // Graceful main-process quit, not Browser.close (which merely hides Fig's window).
  if (socket?.readyState === WebSocket.OPEN) { void evaluate("process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit()").catch(() => {}); await delay(200); socket.close() }
  await browser?.close().catch(() => {})
  if (ownedPid) {
    const alive = !await exited([ownedPid], 15000)
    report.mainExitConfirmed = !alive
    if (alive) { report.status = 'fail'; report.cleanup = 'owned app exit unconfirmed'; process.exitCode = 1 }
  }
  report.finishedAt = new Date().toISOString(); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  await cleanUp(state.profile, report.status === 'pass')
}
