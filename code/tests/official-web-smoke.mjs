import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { figPlugins } from '../harness/plugins.ts'
import { dshLauncher, testedDsh } from './helpers/dsh-launcher.mjs'

// The distribution without Fig's shell: official `dsh web` with every
// package except the ones only Fig Desktop loads (shell-bridge, desktop-skin, desktop-brand), opened in a plain browser.
// It passes when the workbench opens, every package activates, each package's page route answers, and the features
// that need the shell stay off: no task-alert settings (`alerts` false) and no desktop read route. Uses the local
// Google Chrome with a temporary profile, a catalog-only DeepSeek key and a closed model address; no model calls.
const shellOnly = new Set(['shell-bridge', 'desktop-skin', 'desktop-brand'])
const built = fileURLToPath(new URL('../../work/build/main/', import.meta.url))
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/distribution-step2/official-web/', import.meta.url))
await mkdir(evidence, { recursive: true })
const version = await testedDsh()
const launcher = await dshLauncher(version)

const root = await mkdtemp(join(tmpdir(), 'fig-official-web-'))
const home = join(root, 'home'), documents = join(root, 'documents'), work = join(root, 'work')
for (const dir of [join(home, 'profiles/web'), documents, work]) await mkdir(dir, { recursive: true })
await writeFile(join(home, 'profiles/web/cordis.patch.yml'), JSON.stringify([{ id: 'workspace-controller', config: { documentsDirectory: documents } }]))
const config = join(root, 'config.patch.yml')
await writeFile(config, JSON.stringify([
  { id: 'fig-instructions', config: { startupDirectory: work } },
  { id: 'fig-rule-sources', config: { startupDirectory: work } }
]))
const packages = figPlugins.filter(plugin => !shellOnly.has(plugin.name))
const patches = [...packages.map(plugin => join(built, plugin.name, 'cordis.patch.yml')), config]
const env = { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
  DEEPSEEK_API_KEY: 'official-web-catalog-only', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1' }
const dsh = spawn(process.execPath, [launcher, 'web', ...patches.flatMap(path => ['--patch', path]), '--no-open', '--host', '127.0.0.1', '--port', '0'],
  { cwd: work, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let out = '', err = ''
dsh.stdout.on('data', bytes => { out += bytes })
dsh.stderr.on('data', bytes => { err += bytes })
const report = { status: 'fail', version, packages: packages.map(plugin => plugin.name), checks: {} }
let browser
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dsh web did not report its address')), 240_000)
    const look = () => { const match = /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(out + err); if (match) { clearTimeout(timer); resolve(match[1]) } }
    dsh.stdout.on('data', look); dsh.stderr.on('data', look)
    dsh.on('exit', code => { clearTimeout(timer); reject(new Error('dsh web exited ' + code + '\n' + err.slice(-2000))) })
  })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error).slice(0, 400)))
  await page.goto(url)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 }).catch(() => {})
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 120_000 })
  report.checks.workbench = true
  assert.equal(await page.locator('[data-dsh-boot]').count(), 0, 'the boot card is gone, no plugin failure')
  await page.waitForTimeout(3000)
  await page.screenshot({ path: join(evidence, 'workbench.png') })
  const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({ prefix, endpoint, payload }) => {
    const response = await fetch(prefix + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    return { status: response.status, body: await response.json().catch(() => undefined) }
  }, { prefix, endpoint, payload })
  // Each package's page route answers through the browser's DSH session.
  const routes = { side: await rpc('/fig-side-chat', 'list'), composer: await rpc('/fig-composer', 'next-step/settings'),
    instructions: await rpc('/fig-instructions', 'settings'), attention: await rpc('/fig-attention', 'info') }
  for (const [name, result] of Object.entries(routes)) assert.equal(result.body?.ok, true, name + ' ' + JSON.stringify(result))
  report.checks.routes = Object.keys(routes)
  // Without the shell: no alerts, so the 任务提醒 settings stay hidden, and no desktop route or skin route exists.
  assert.equal(routes.attention.body.value.alerts, false)
  report.checks.alertsOff = true
  for (const [prefix, endpoint] of [['/fig-desktop', 'attention/read'], ['/fig-skin', 'settings/info']]) {
    assert.notEqual((await rpc(prefix, endpoint)).body?.ok, true, prefix + ' must not answer without the shell')
  }
  report.checks.noShellRoutes = true
  assert.equal(await page.locator('[data-fig-attention-settings]').count(), 0)
  assert.deepEqual(pageErrors, [], 'no page errors')
  report.checks.noPageErrors = true
  assert.ok(!/did not activate/.test(err), 'every package activates:\n' + err.split('\n').filter(line => !/SOCKS/.test(line)).slice(0, 20).join('\n'))
  report.checks.allActive = true
  report.status = 'pass'
} catch (error) {
  report.error = String(error.stack ?? error)
  report.stderr = err.split('\n').filter(line => !/SOCKS/.test(line)).slice(-30).join('\n')
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  try { process.kill(-dsh.pid, 'SIGTERM') } catch {}
  await new Promise(resolve => setTimeout(resolve, 1500))
  try { process.kill(-dsh.pid, 'SIGKILL') } catch {}
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  await rm(root, { recursive: true, force: true }).catch(() => {})
  console.log(report.status === 'pass' ? 'PASS: the packages run in official dsh web without Fig\'s shell' : 'FAIL\n' + report.error + '\n' + (report.stderr ?? ''))
}
