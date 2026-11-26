import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { prepareDevRuntime } from './dev-runtime.mjs'
import { appProcesses, exited, servicePid } from './verification-lifecycle.mjs'

// Isolated development instances of Fig Desktop for the smoke tests.
// Each runs this checkout's build with its own window state, DSH data and Documents folder.

const code = fileURLToPath(new URL('..', import.meta.url))

/**
 * A throwaway profile under the system temp folder. DSH's Documents folder points inside it, and
 * DeepSeek gets a catalog-only placeholder, so no model request leaves the machine unless a test
 * signs in itself. The Grok and Codex CLI state also moves inside it, so the settings pages never show
 * the user's own accounts; a test that needs them passes `extraEnv: realCliHomes` (or its own paths).
 *
 * `profile` builds the same isolation on a folder the caller owns (a verification-lifecycle profile).
 * With `real`, a real-login run, the DSH home, the DeepSeek
 * settings and the Grok CLI state are left as they are; the startup Workspace and DSH agents home
 * are still isolated.
 *
 * @param {string} name
 * @param {{ base?: NodeJS.ProcessEnv, extraEnv?: (profile: string) => Record<string, string | undefined>,
 *   attention?: boolean, profile?: string, real?: boolean }} [options]
 */
export async function isolatedProfile(name, { base = process.env, extraEnv = () => ({}), attention = false, profile: owned, real = false } = {}) {
  const profile = owned ?? await mkdtemp(join(tmpdir(), `fig-${name}-`))
  const documents = join(profile, 'workspace')
  const dshHome = join(profile, 'dsh')
  await mkdir(documents, { recursive: Boolean(owned) })
  if (!real) {
    await mkdir(join(dshHome, 'profiles/web'), { recursive: true })
    await mkdir(join(dshHome, 'fig/attention'), {recursive: true})
    await writeFile(join(dshHome, 'fig/attention/preferences.json'), JSON.stringify({schema: 1, notifications: attention, dock: attention}))
    await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
      { id: 'workspace-controller', config: { documentsDirectory: documents } }
    ]))
  }
  // `documents` is the startup directory, so Fig's first-use Workspace is `<documents>/default-workspace`; the
  // documentsDirectory override above only keeps DSH's own fallback inside the profile should Fig's claim fail.
  // The shared Workspace root also points inside the profile, so no real skills or instruction files are registered.
  const env = { ...base, ...(real ? {} : { DEEPSEEK_API_KEY: 'fig-smoke-catalog-only', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1' }), FIG_DESKTOP_DATA_DIR: profile,
    FIG_DESKTOP_WORKSPACE_DIR: documents, DSH_AGENTS_HOME: join(profile, 'agents') }
  for (const key of ['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'DSH_BUNDLED_SKILL_DIR']) delete env[key]
  if (!real) Object.assign(env, { GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: join(profile, 'grok/auth.json'), CODEX_HOME: join(profile, 'codex') })
  Object.assign(env, extraEnv(profile))
  return { profile, documents, dshHome, workspace: join(documents, 'default-workspace'), env }
}

/** The user's own Grok and Codex CLI state, for a test that signs in with them (pass as `extraEnv`). */
export const realCliHomes = () => ({ GROK_HOME: process.env.GROK_HOME ?? join(homedir(), '.grok'),
  GROK_AUTH_PATH: process.env.GROK_AUTH_PATH ?? join(homedir(), '.grok/auth.json'), CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), '.codex') })

/** Command shared by windowed tests and the capture tool. */
export async function figCommand() {
  return { executable: await prepareDevRuntime(), args: [code] }
}

// Every app this process launched, with its pid and, once the workbench is up, the DSH service pid.
// cleanUp removes a profile only after all of them have exited.
const launched = new Map()
const track = app => {
  launched.set(app, { pid: app.process().pid })
  return app
}

/**
 * Starts this checkout's build in the Fig development host; `appPath` runs another app payload.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ args?: string[], timeout?: number, language?: string, appPath?: string }} [options]
 */
export async function launchFig(env, { args = [], timeout, language = 'zh-CN', appPath } = {}) {
  const command = await figCommand()
  return track(await electron.launch({
    executablePath: command.executable,
    args: [...(appPath ? [appPath] : command.args), ...(language ? ['--lang=' + language] : []), ...args],
    env: /** @type {Record<string, string>} */ (env), timeout
  }))
}

/** The executable inside a packaged Fig Desktop.app. */
export const bundleExecutable = bundle => join(bundle, 'Contents/MacOS/Fig Desktop')

/** Starts a packaged Fig Desktop.app with the profile's environment. */
export async function launchBundle(bundle, env, { timeout = 30_000 } = {}) {
  return track(await electron.launch({ executablePath: bundleExecutable(bundle), env, timeout }))
}

/** Polls `check` every `interval` ms until it returns something truthy, which is returned; throws `message` after `timeout`. */
export async function until(check, { timeout = 10_000, interval = 100, message = 'Timed out' } = {}) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; await delay(interval)) {
    const value = await check()
    if (value) return value
  }
  throw new Error(message)
}

/**
 * On an unhandled rejection or uncaught exception, mark `report` failed, let `prepare(error)` add
 * details, write it to `path` synchronously, then close `app()` and exit 1 (at most 10 s later).
 * @param {string} path
 * @param {Record<string, any>} report
 * @param {{ app?: () => { close(): Promise<void> } | undefined, prepare?: (error: any) => void }} [options]
 */
export function emergencyReport(path, report, { app = () => undefined, prepare = () => {} } = {}) {
  let started = false
  const emergency = error => {
    if (started) return
    started = true
    report.status = 'fail'
    report.error = String(error?.stack ?? error)
    report.finishedAt = new Date().toISOString()
    prepare(error)
    writeFileSync(path, JSON.stringify(report, null, 2))
    setTimeout(() => process.exit(1), 10000).unref()
    void Promise.resolve(app()?.close()).catch(() => {}).finally(() => process.exit(1))
  }
  process.on('unhandledRejection', emergency)
  process.on('uncaughtException', emergency)
}

/** The DSH workbench page, once Fig has opened it beside its startup window. */
export async function workbenchPage(app, timeout = 60_000) {
  const startup = await app.firstWindow()
  const page = await until(() => app.context().pages().find(item => item !== startup && item.url().startsWith('http://127.0.0.1:')),
    { timeout, interval: 150, message: 'The DSH workbench did not open.' })
  const entry = launched.get(app)
  if (entry && entry.service === undefined) entry.service = await servicePid(app).catch(() => undefined)
  return page
}

/**
 * Closes `app` like `app.close()`, which waits without limit when Fig does not quit (for instance when
 * a test has replaced `app.quit`). After `timeout` ms it force-ends only what this file launched for
 * `app` (Fig, its helper processes and its DSH process group) and throws.
 */
export async function closeFig(app, timeout = 30_000) {
  let timer
  const quit = await Promise.race([app.close().then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout) })])
  clearTimeout(timer)
  if (quit) return
  const entry = launched.get(app)
  if (!entry) throw new Error('Fig did not quit and was not launched here')
  let helpers = []
  try { helpers = execFileSync('pgrep', ['-P', String(entry.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number) } catch {}
  for (const pid of [...appProcesses(entry.pid, entry.service), ...helpers]) try { process.kill(pid, 'SIGKILL') } catch {}
  throw new Error(`Fig did not quit within ${timeout / 1000} s; the processes launched for it were force-ended`)
}

/**
 * Removes the profile once every app launched here has exited, or keeps it and says where: after a
 * failure, or when Fig or its DSH service is still running.
 */
export async function cleanUp(profile, passed = true) {
  const processes = [...launched.values()].flatMap(({ pid, service }) => appProcesses(pid, service))
  const stopped = await exited(processes)
  if (stopped) launched.clear()
  if (passed && stopped) await rm(profile, { recursive: true, force: true })
  else console.error(stopped ? 'Isolated failure data:' : 'Fig still running; isolated data kept:', profile)
}
