import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { findNodeRuntime } from '../../harness/environment'
import { dshCandidate, launchDsh } from '../../harness/dsh-versions'
import { lockedRelease, type DshRuntimeLock } from '../../harness/shared/dsh-runtime.js'
import runtimeManifest from '../../dsh-runtime/package.json'
import runtimeLockfile from '../../dsh-runtime/package-lock.json'
import { captureFlag } from './capture'
import { devOverrides } from './profile'
import type { LaunchCommand } from './service'
import { suggestedStartup } from './startup-directory'

// What a development host (`npm run dev`, the smoke tests) or a verification build may change, kept apart from the
// product code. A packaged release reads none of these switches: there `developmentHost` is false and
// __FIG_VERIFICATION_BUILD__ is replaced by false at build time.

declare const __FIG_VERIFICATION_BUILD__: boolean

export const developmentHost = process.defaultApp === true || !app.isPackaged
const smoke = developmentHost && process.argv.includes('--fig-smoke')
/** Leaves the desktop-brand package out, for tests that look at DSH's own sidebar. */
export const sidebarBrandDisabled = developmentHost && process.env.FIG_DESKTOP_DISABLE_SIDEBAR_BRAND === '1'

const verificationData = __FIG_VERIFICATION_BUILD__ ? process.argv.find(arg => arg.startsWith('--fig-verification-data='))?.slice(24) ?? process.env.FIG_DESKTOP_DATA_DIR : undefined
if (__FIG_VERIFICATION_BUILD__ && !verificationData && !process.argv.some(arg => arg.startsWith(captureFlag))) throw new Error('Verification build requires isolated data')
/** An isolated instance's own data folder (FIG_DESKTOP_DATA_DIR); undefined for the user's daily one. */
export const isolatedDataDirectory = __FIG_VERIFICATION_BUILD__ ? verificationData : developmentHost ? process.env.FIG_DESKTOP_DATA_DIR : undefined

// The home whose first-run step applies: the user's, or an isolated instance's own folder
// when a test asks for the first-run step (FIG_DESKTOP_FIRST_RUN=1). Other isolated instances start in their own
// synthetic workspace folder, so no real skills or instruction files are registered.
export const firstRunHome = isolatedDataDirectory ? (developmentHost && process.env.FIG_DESKTOP_FIRST_RUN === '1' ? isolatedDataDirectory : undefined) : homedir()
/** The startup folder before persisted native choices apply; a missing default folder is created at launch. */
export const defaultStartup = firstRunHome ? suggestedStartup(firstRunHome)
  : (!__FIG_VERIFICATION_BUILD__ && process.env.FIG_DESKTOP_WORKSPACE_DIR) || join(isolatedDataDirectory!, 'workspace')
/** The DSH data folder before persisted native choices apply. */
export const defaultDshHome = isolatedDataDirectory ? join(isolatedDataDirectory, 'dsh') : join(homedir(), '.fig')

// A development build can run a DSH release under verification (FIG_DSH_CANDIDATE), installed from the candidate
// lockfile scripts/dsh-verify.mjs writes (FIG_DSH_CANDIDATE_LOCK, a folder with package.json and package-lock.json).
const candidate = developmentHost ? dshCandidate() : undefined
export const dshRelease = candidate ?? launchDsh
/** The manifest and lockfile Fig installs DSH from: the committed one (code/dsh-runtime/), or a candidate's. */
export const dshRuntimeLock: DshRuntimeLock = candidate ? candidateLock(candidate) : { manifest: runtimeManifest, lock: runtimeLockfile }

function candidateLock(version: string): DshRuntimeLock {
  const folder = process.env.FIG_DSH_CANDIDATE_LOCK
  if (!folder) throw new Error(`FIG_DSH_CANDIDATE=${version} needs FIG_DSH_CANDIDATE_LOCK (npm run dsh:verify writes it)`)
  const read = (name: string) => JSON.parse(readFileSync(join(folder, name), 'utf8'))
  const value = { manifest: read('package.json'), lock: read('package-lock.json') }
  if (lockedRelease(value.manifest, value.lock).version !== version) throw new Error(`FIG_DSH_CANDIDATE_LOCK does not install DSH ${version}`)
  return value
}

// `npm run dev:isolated -- --plugin <dir> --edition team` (scripts/run-desktop.mjs) adds plugin folders and picks the
// edition of an isolated Profile; never of the daily one.
export const profileOverrides = isolatedDataDirectory && (developmentHost || __FIG_VERIFICATION_BUILD__) ? devOverrides(process.env, delimiter) : undefined

/** electron-vite's renderer dev server, only on a development host and only on loopback http. */
export function developmentRendererUrl(): URL | undefined {
  const value = developmentHost ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Invalid local development URL')
  return url
}

/** A verification build keeps DSH's agents, skills, Grok state and DeepSeek requests inside its isolated data folder. */
export function verificationEnvironment(): NodeJS.ProcessEnv | undefined {
  if (!__FIG_VERIFICATION_BUILD__ || !isolatedDataDirectory) return undefined
  return { ...process.env, DSH_AGENTS_HOME: join(isolatedDataDirectory, 'agents'), DSH_BUNDLED_SKILL_DIR: '', GROK_HOME: join(isolatedDataDirectory, 'grok'),
    GROK_AUTH_PATH: join(isolatedDataDirectory, 'grok/auth.json'), DEEPSEEK_API_KEY: 'fig-smoke-catalog-only', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1' }
}

/** With --fig-smoke, a fixture server (tests/fixtures/dsh-server.mjs) stands in for DSH. */
export const fixtureCommand = smoke ? async (): Promise<LaunchCommand> => {
  const runtime = await findNodeRuntime()
  return {
    executable: runtime.node,
    args: [join(app.getAppPath(), 'tests/fixtures/dsh-server.mjs')],
    env: { ...runtime.environment, FIG_FIXTURE_RECORD: join(app.getPath('userData'), 'fixture.json'), FIG_FIXTURE_MODE: process.env.FIG_FIXTURE_MODE },
    version: runtime.version
  }
} : undefined
