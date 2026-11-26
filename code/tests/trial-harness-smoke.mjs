import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleExecutable, cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'

// Validate the exact shipped JS payload in an isolated host, then the signed trial binary's capture
// entry. Production ignores FIG_DESKTOP_DATA_DIR, so this avoids touching the everyday ~/.fig store.
const bundle = fileURLToPath(new URL('../../outputs/Fig Desktop.app/', import.meta.url))
const payload = join(bundle, 'Contents/Resources/app')
// --evidence=<dir> keeps each package's acceptance record apart from earlier ones.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/harness-audit/', import.meta.url))
await mkdir(evidence, { recursive: true })
const state = await isolatedProfile('trial-harness')
let app, passed = false
try {
  for (const file of ['instructions/index.js', 'handoff/index.js', 'preview/index.js']) {
    assert.ok((await readFile(join(payload, 'main', file))).length > 0, file + ' packaged')
  }
  app = await launchFig(state.env, { appPath: payload })
  const expected = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), expected)
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), state.profile)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  const editor = page.locator('[contenteditable="true"]').first()
  await page.getByRole('button', { name: /^选择模型/ }).first().waitFor()
  await editor.click()
  await editor.fill('Trial browser probe')
  await editor.press('Enter')
  await page.getByText('Trial browser probe', { exact: true }).first().waitFor().catch(async error => {
    await writeFile(join(evidence, 'trial-failure.txt'), await page.locator('body').innerText())
    throw error
  })
  await page.keyboard.press('Meta+Alt+t')
  await page.getByRole('textbox', { name: /网址|地址|URL|address/i }).first().waitFor()
  await page.screenshot({ path: join(evidence, 'trial-browser.png') })
  await app.close()
  app = undefined
  const output = join(state.profile, 'capture')
  await mkdir(output)
  const job = join(state.profile, 'job.json')
  await writeFile(job, JSON.stringify({ url: new URL('./fixtures/preview-page.html', import.meta.url).href, widths: [390], theme: 'light', selectors: [], output }))
  await new Promise((resolve, reject) => {
    const child = spawn(bundleExecutable(bundle), ['--fig-capture=' + job], { env: state.env, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Trial capture timed out')) }, 30_000)
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Trial capture exit ' + code)) })
  })
  const captured = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'))
  assert.ok(captured.views[0].overflowX > 0, 'Signed binary captures the fixture and returns diagnostics')
  console.log('PASS:', expected, 'shipped payload starts with new plugins and Browser; signed binary preview works')
  passed = true
} finally {
  await app?.close()
  await cleanUp(state.profile, passed)
}
