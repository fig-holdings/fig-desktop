import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedDevEnvironment } from '../scripts/dev-isolation.mjs'
import { cleanUp, isolatedProfile, launchFig } from '../scripts/isolated-fig.mjs'
import { licenseDirectory, stageApplicationPayload } from '../scripts/third-party-licenses.mjs'

const code = fileURLToPath(new URL('..', import.meta.url))
const build = join(code, '../work/build')
const evidence = join(code, '../work/verification/t3-licenses')
const profile = await mkdtemp(join(tmpdir(), 'fig-license-smoke-'))
const appPath = join(profile, 'Contents/Resources/app')
const state = await isolatedProfile('third-party-licenses', {
  base: isolatedDevEnvironment(), profile,
  extraEnv: folder => ({ CODEX_HOME: join(folder, 'codex') })
})
const report = { status: 'fail' }
let application
try {
  const pkg = JSON.parse(await readFile(join(code, 'package.json'), 'utf8'))
  await stageApplicationPayload(build, appPath, pkg)
  const fixture = 'tests/fixtures/dsh-server.mjs'
  await mkdir(join(appPath, 'tests/fixtures'), { recursive: true })
  await cp(join(code, fixture), join(appPath, fixture))
  const manifest = JSON.parse(await readFile(join(appPath, licenseDirectory, 'manifest.json'), 'utf8'))
  assert.deepEqual(await readFile(join(appPath, licenseDirectory, 'manifest.json')), await readFile(join(build, licenseDirectory, 'manifest.json')))
  Object.assign(report, { platform: manifest.platform, dsh: manifest.dsh, entries: manifest.entries.length,
    electron: manifest.entries.filter(entry => entry.category === 'electron').map(({ name, version }) => ({ name, version })) })

  application = await launchFig(state.env, { appPath, args: ['--fig-smoke'], language: 'zh-CN' })
  const startup = await application.firstWindow()
  await startup.waitForFunction(() => Boolean(window.fig))
  const viewerReady = application.waitForEvent('window', { predicate: page => page !== startup, timeout: 15_000 })
  // Playwright drives the actual application menu callback. Supply the OS dialog's response
  // to avoid driving the foreground user's macOS keyboard while this isolated instance runs.
  const about = await application.evaluate(async ({ dialog, Menu }) => {
    const item = Menu.getApplicationMenu().getMenuItemById('fig-about')
    const original = dialog.showMessageBox
    try {
      const options = await new Promise(resolve => {
        dialog.showMessageBox = async (...args) => {
          resolve(args.at(-1))
          return { response: 1, checkboxChecked: false }
        }
        item.click()
      })
      return { label: item.label, options }
    } finally {
      dialog.showMessageBox = original
    }
  })
  assert.match(about.label, /^(关于|About) Fig Desktop$/)
  assert.ok(about.options.detail.includes(pkg.version))
  assert.match(about.options.buttons[1], /第三方许可证|Third-Party Licenses/)

  const viewer = await viewerReady
  await viewer.getByRole('heading', { name: /Third-Party Licenses/ }).waitFor()
  assert.match(viewer.url(), /\/Contents\/Resources\/app\/main\/third-party-licenses\/index\.html$/)
  assert.equal(await viewer.getByRole('heading', { level: 2 }).count(), 6)
  const chromium = viewer.getByRole('link', { name: 'LICENSES.chromium.html' })
  await chromium.click()
  await viewer.waitForURL(/\/third-party-licenses\/texts\/[a-f0-9]+\.html$/)
  assert.match(await viewer.title(), /Credits/i)
  Object.assign(report, { status: 'pass', about: about.label, dialogButton: about.options.buttons[1],
    licenseWindow: true, chromiumCredits: true, nativeButtonResponse: 'injected' })
} finally {
  await application?.close()
  await cleanUp(profile, report.status === 'pass')
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'isolated-payload.json'), JSON.stringify(report, null, 2) + '\n')
}
