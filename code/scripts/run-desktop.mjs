import { spawn } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prepareDevRuntime } from './dev-runtime.mjs'
import { mkdir } from 'node:fs/promises'
import { devProfile, isolatedDevEnvironment } from './dev-isolation.mjs'

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (!['dev', 'preview'].includes(args[0])) throw new Error('Expected dev or preview')
const isolated = args.includes('--isolated')
if (isolated) {
  args.splice(args.indexOf('--isolated'), 1)
  if (args[0] !== 'dev') throw new Error('--isolated is only supported for dev')
  for (const folder of ['', 'workspace', 'agents', 'grok', 'codex']) await mkdir(join(devProfile, folder), { recursive: true })
  console.log(`Isolated development profile: ${devProfile}\nDaily Fig can stay open. No daily credentials are copied; profile is retained.\nThis is data isolation, not an OS/network sandbox. Do not sign out daily accounts here.`)
}
// Profile options for the isolated Profile only (app/main/profile.ts): `--plugin <folder>` links a DSH plugin package
// folder into it (repeatable; edits apply on reload), `--edition team|personal` picks its edition and default look.
const pluginFolders = []
let edition
for (let at = args.findIndex(arg => arg === '--plugin' || arg === '--edition'); at >= 0; at = args.findIndex(arg => arg === '--plugin' || arg === '--edition')) {
  const [flag, value] = args.splice(at, 2)
  if (!isolated) throw new Error(`${flag} is only supported with --isolated`)
  if (!value) throw new Error(`${flag} needs a value`)
  if (flag === '--edition') {
    if (!['team', 'personal'].includes(value)) throw new Error('--edition is team or personal')
    edition = value
  } else {
    const folder = resolve(process.env.INIT_CWD ?? process.cwd(), value)
    if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--plugin ${value}: not a folder`)
    pluginFolders.push(folder)
  }
}
if (pluginFolders.length || edition) console.log(`Isolated Profile: edition ${edition ?? '(from profile.json)'}; plugin folders: ${pluginFolders.join(', ') || 'none'}`)
const runtime = await prepareDevRuntime()
const child = spawn(process.execPath, [join(code, 'node_modules/electron-vite/bin/electron-vite.js'), ...args], {
  cwd: code, stdio: 'inherit', env: { ...(isolated ? isolatedDevEnvironment() : process.env), ELECTRON_EXEC_PATH: runtime,
    ...pluginFolders.length ? { FIG_DESKTOP_DEV_PLUGINS: pluginFolders.join(delimiter) } : {}, ...edition ? { FIG_DESKTOP_DEV_EDITION: edition } : {} }
})
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
