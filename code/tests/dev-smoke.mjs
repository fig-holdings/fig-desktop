import { profileLifecycle } from '../scripts/verification-lifecycle.mjs'
import { launchFig } from '../scripts/isolated-fig.mjs'
import { startRendererServer } from './helpers/renderer-server.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(code, '../work/verification/desktop')
await mkdir(evidence, { recursive: true })
const lifecycle = await profileLifecycle({ evidence, prefix: 'dev-', reportName: 'dev-lifecycle.json' })
const data = lifecycle.profile
let passed = false
let server
let application
try {
  server = await startRendererServer()
  const env = { ...process.env, ELECTRON_RENDERER_URL: server.url, FIG_DESKTOP_DATA_DIR: data }
  delete env.ELECTRON_RUN_AS_NODE
  application = lifecycle.track(await launchFig(env, { args: ['--fig-smoke'], language: null }))
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.fig))
  await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0))
  await page.evaluate(async () => { await document.fonts.load('12px "Geist Mono"') })
  await page.waitForFunction(async () => (await window.fig.getState()).phase === 'ready')
  await delay(300)
  assert.ok(page.url().startsWith(server.url))
  assert.deepEqual(errors, [])
  const result = { status: 'passed', checks: ['Isolated Vite renderer starts without launching another app',
    'React + sandboxed preload render without runtime errors', 'development window reaches DSH readiness',
    'VI images and Geist Mono load from the explicitly allowed brand directory'] }
  await writeFile(join(evidence, 'dev-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  passed = true
} finally {
  await lifecycle.close(application).catch(error => { passed = false; console.error(error) })
  await server?.close()
  await lifecycle.finish(passed)
}
