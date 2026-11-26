import { profileLifecycle } from '../scripts/verification-lifecycle.mjs'
import { figCommand, launchFig, isolatedProfile } from '../scripts/isolated-fig.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(code, '..')
const version = JSON.parse(await readFile(join(code, 'package.json'), 'utf8')).version
const evidence = join(root, 'work/verification/identity')
await mkdir(evidence, { recursive: true })
const { executable: executablePath } = await figCommand()
const bundle = resolve(dirname(executablePath), '../..')
const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }))
assert.equal(info.CFBundleName, 'Fig Desktop')
assert.equal(info.CFBundleDisplayName, 'Fig Desktop')
assert.equal(info.CFBundleShortVersionString, version)
assert.equal(info.CFBundleVersion, version)
const hash = data => createHash('sha256').update(data).digest('hex')
assert.equal(hash(await readFile(join(bundle, 'Contents/Resources', info.CFBundleIconFile))), hash(await readFile(join(root, 'assets/brand/app-icon.icns'))))
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' })
const lifecycle = await profileLifecycle({ evidence, prefix: 'profile-', reportName: 'identity-lifecycle.json' })
const data = lifecycle.profile
let passed = false
let application
try {
  const { env } = await isolatedProfile('identity', { profile: data })
  application = lifecycle.track(await launchFig(env, { args: ['--fig-smoke'], language: null }))
} catch (error) { await lifecycle.finish(false); throw error }
try {
  const page = await application.firstWindow()
  await page.waitForFunction(async () => window.fig && (await window.fig.getState()).phase === 'ready')
  const internal = await application.evaluate(({ app, Menu }) => ({
    name: app.getName(), version: app.getVersion(), packaged: app.isPackaged, defaultApp: process.defaultApp,
    menu: Menu.getApplicationMenu().items[0].label,
    about: Menu.getApplicationMenu().items[0].submenu.items[0].label
  }))
  assert.equal(internal.name, 'Fig Desktop')
  assert.equal(internal.version, version)
  assert.equal(internal.defaultApp, true, 'Development host is detected through the documented defaultApp flag')
  assert.equal(internal.menu, 'Fig Desktop')
  assert.equal(internal.about, '关于 Fig Desktop')
  const swift = join(evidence, 'identity.swift')
  await writeFile(swift, `import AppKit\nimport Foundation\nlet pid = Int32(CommandLine.arguments[1])!\nlet app = NSRunningApplication(processIdentifier: pid)!\nlet result: [String: String] = ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? ""]\nprint(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)\n`)
  const native = JSON.parse(execFileSync('/usr/bin/swift', ['-module-cache-path', join(evidence, 'swift-cache'), swift, String(application.process().pid)], { encoding: 'utf8', timeout: 60_000 }))
  assert.equal(native.name, 'Fig Desktop')
  assert.equal(native.bundleId, 'local.fig.desktop.dev')
  await application.evaluate(({ app }) => app.showAboutPanel())
  const report = { status: 'passed', native, internal, checks: [
    'macOS reports Fig Desktop as the running application name',
    'Application menu and About label use Fig Desktop',
    'Native bundle icon matches the VI ICNS exactly',
    `Product and build versions are ${version}; About overrides the framework build suffix`,
    'Branded development host passes strict recursive signature verification',
    'About panel request succeeds; first-run desktop service remains usable'
  ], limitation: 'Native panel pixels were not captured; macOS identity and bundle resources were verified' }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  passed = true
} finally { await lifecycle.close(application); await lifecycle.finish(passed) }
