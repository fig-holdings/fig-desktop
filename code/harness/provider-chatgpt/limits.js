import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { executableDirectories, findExecutable, resolveLaunchProxy } from '../environment'
import { ttlCache } from '../shared/cache.js'
import { tail } from '../shared/file-tail.js'
import { uiText } from '../shared/ui-text'

// ChatGPT plan usage limits for the settings section, read from the local Codex sign-in: live from
// its app server (`account/rateLimits/read`, the numbers Codex itself shows), and, so the page never
// waits on that 2–4 s round trip, from the newest limits Codex wrote into its session files. Fig sends
// ChatGPT requests on the same plan; which account Codex is signed in to is shown with the live read,
// since Fig's own sign-in carries no identifier to compare.

const lifetime = 60_000
const timeout = 20_000
const logTail = 256 * 1024
// Codex ships inside the ChatGPT desktop app; a standalone install is found on PATH.
const bundled = ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS']

export async function codexCommand() {
  const paths = executableDirectories(process.env, { before: [join(homedir(), '.local/bin')], after: [...bundled, '/usr/bin', '/bin'] })
  const executable = await findExecutable('codex', paths)
  if (!executable) return undefined
  const env = await resolveLaunchProxy({ ...process.env, PATH: paths.join(delimiter) })
  // An API key would switch Codex to key auth, which has no plan limits.
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]
  return { executable, env }
}

// The app server answers in camelCase, the session files in snake_case.
const pick = (value, camel, snake) => value?.[camel] ?? value?.[snake]

function windowFrom(window) {
  const percent = pick(window, 'usedPercent', 'used_percent')
  const minutes = pick(window, 'windowDurationMins', 'window_minutes')
  const resets = pick(window, 'resetsAt', 'resets_at')
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined
  return {
    usedPercent: Math.min(100, Math.max(0, percent)),
    ...(Number.isInteger(minutes) && minutes > 0 ? { minutes } : {}),
    ...(Number.isFinite(resets) ? { resetsAt: new Date(resets * 1000).toISOString() } : {})
  }
}

/** One Codex rate-limit snapshot as `{ windows, plan }`, longest window first; undefined if unrecognized. */
export function snapshotLimits(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return undefined
  const windows = [windowFrom(snapshot.primary), windowFrom(snapshot.secondary)].flatMap(window => window ? [window] : [])
    .sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))
  if (!windows.length) return undefined
  const plan = pick(snapshot, 'planType', 'plan_type')
  return { windows, ...(typeof plan === 'string' && plan ? { plan } : {}) }
}

/** The `codex` bucket of an `account/rateLimits/read` reply. */
export const limitsFrom = result => snapshotLimits(result?.rateLimitsByLimitId?.codex ?? result?.rateLimits)

/** The newest `codex` rate limits in a session file's text, with the time Codex recorded them. */
export function limitsFromLog(text) {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].includes('"rate_limits"')) continue
    try {
      const record = JSON.parse(lines[index])
      const snapshot = record.payload?.rate_limits
      if (snapshot?.limit_id && snapshot.limit_id !== 'codex') continue
      const limits = snapshotLimits(snapshot)
      if (limits && !Number.isNaN(Date.parse(record.timestamp))) return { ...limits, source: 'log', fetchedAt: record.timestamp }
    } catch { /* The first line of the tail is partial. */ }
  }
  return undefined
}

/** The newest limits in Codex's session files: the most recently written files of the latest days. */
export async function logLimits(codexHome) {
  const root = join(codexHome, 'sessions')
  const newest = async path => (await readdir(path).catch(() => [])).filter(name => /^\d+$/.test(name)).sort().reverse()
  const files = []
  for (const year of (await newest(root)).slice(0, 1)) {
    for (const month of (await newest(join(root, year))).slice(0, 2)) {
      for (const day of (await newest(join(root, year, month))).slice(0, 2)) {
        const directory = join(root, year, month, day)
        for (const name of await readdir(directory).catch(() => [])) {
          if (!name.endsWith('.jsonl')) continue
          const info = await stat(join(directory, name)).catch(() => undefined)
          if (info) files.push({ path: join(directory, name), time: info.mtimeMs })
        }
      }
      if (files.length) break
    }
  }
  let latest
  for (const { path } of files.sort((a, b) => b.time - a.time).slice(0, 5)) {
    const limits = limitsFromLog(await tail(path, logTail).then(read => read.text, () => ''))
    if (limits && (!latest || limits.fetchedAt > latest.fetchedAt)) latest = limits
  }
  return latest
}

/** `account/rateLimits/read` and `account/read` through a short-lived `codex app-server`. */
export async function readCodexLimits(command) {
  const { executable, env } = command
  const child = spawn(executable, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] })
  try {
    return await new Promise((resolve, reject) => {
      const replies = {}
      const timer = setTimeout(() => reject(new Error(uiText('Codex 未在规定时间内返回额度。', 'Codex did not return usage in time.'))), timeout)
      const send = message => child.stdin.write(JSON.stringify(message) + '\n')
      child.on('error', () => { clearTimeout(timer); reject(new Error(uiText('无法启动 Codex。', 'Could not start Codex.'))) })
      child.stdin.on('error', () => {}) // a Codex that already exited answers through 'exit'
      child.on('exit', () => { clearTimeout(timer); reject(new Error(uiText('Codex 未返回额度。', 'Codex returned no usage.'))) })
      createInterface({ input: child.stdout }).on('line', line => {
        let message
        try { message = JSON.parse(line) } catch { return }
        if (message.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
          send({ id: 3, method: 'account/read', params: {} })
          return
        }
        if (message.id !== 2 && message.id !== 3) return
        replies[message.id] = message
        if (!replies[2] || !replies[3]) return
        clearTimeout(timer)
        // Upstream error text is not passed on.
        if (replies[2].error) return reject(new Error(uiText('Codex 未登录或无法读取额度。', 'Codex is not signed in or could not read usage.')))
        resolve({ limits: replies[2].result, account: replies[3].result?.account })
      })
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fig_desktop', title: 'Fig Desktop', version: '0' }, capabilities: null } })
    })
  } finally {
    // Codex is not waited on to exit; the page has its numbers.
    child.kill()
  }
}

/**
 * `cached()` answers at once with the limits at hand (the last live read, else Codex's session
 * files) and never starts Codex; `live({ refresh })` reads them from Codex (kept for a minute).
 */
export function codexLimits({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), find = codexCommand, read = readCodexLimits } = {}) {
  const cache = ttlCache(lifetime)
  const fromLog = () => logLimits(codexHome).catch(() => undefined)

  async function readLive() {
    const command = await find()
    if (!command) return { unavailable: 'missing' }
    const { limits, account } = await read(command)
    const value = limitsFrom(limits)
    if (!value) return { unavailable: 'unknown' }
    const email = account?.type === 'chatgpt' && typeof account.email === 'string' ? account.email : undefined
    return { ...value, source: 'live', fetchedAt: new Date().toISOString(), ...(email ? { email } : {}) }
  }

  return {
    async cached() {
      const last = cache.last
      return last?.windows ? last : await fromLog() ?? {}
    },
    /** @param {{ refresh?: boolean }} [options] */
    async live({ refresh = false } = {}) {
      if (refresh) cache.clear()
      const value = await cache.get(readLive).catch(() => { cache.clear(); return { unavailable: 'failed' } })
      return value.windows ? value : await fromLog() ?? value
    }
  }
}
