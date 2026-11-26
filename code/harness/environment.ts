import { access, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { uiText } from './shared/ui-text.ts'

const execFileAsync = promisify(execFile)

const proxyVariables = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']

/** Convert enabled macOS HTTP(S) proxies to DSH's launch environment. */
export function withMacProxy(environment: NodeJS.ProcessEnv, settings: string): NodeJS.ProcessEnv {
  if (proxyVariables.some(name => environment[name]?.trim())) return environment
  const fields = new Map([...settings.matchAll(/^ {2}(\w+) *: *([^\r\n]+)$/gm)]
    .map(([, key, value]) => [key, value.trim()]))
  const proxies: NodeJS.ProcessEnv = {}
  for (const scheme of ['HTTP', 'HTTPS']) {
    const host = fields.get(scheme + 'Proxy')
    const port = Number(fields.get(scheme + 'Port'))
    if (fields.get(scheme + 'Enable') !== '1' || !host ||
      !/^(?:[\w.-]+|\[[\da-f:]+\])$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue
    proxies[scheme + '_PROXY'] = `http://${host}:${port}`
  }
  if (!Object.keys(proxies).length) return environment
  const exceptions = settings.match(/^ {2}ExceptionsList *: *<array> *\{([^}]+)\}/m)?.[1] ?? ''
  const bypass = [...exceptions.matchAll(/^ {4}\d+ *: *(\S+) *$/gm)].map(([, entry]) => entry)
  const noProxy = environment.no_proxy ?? environment.NO_PROXY ?? ['localhost', '127.0.0.1', '::1', ...bypass].join(',')
  return { ...environment, ...proxies, NO_PROXY: noProxy }
}

export async function resolveLaunchProxy(environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'darwin' || proxyVariables.some(name => environment[name]?.trim())) return environment
  try {
    const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 2000 })
    return withMacProxy(environment, stdout)
  } catch {
    return environment
  }
}

/**
 * Where Fig looks for the user's command-line tools, without running shell startup files:
 * PATH first, then the usual install locations. `before` and `after` add tool-specific folders.
 */
export function executableDirectories(environment: NodeJS.ProcessEnv, { before = [], after = [] }: { before?: string[], after?: string[] } = {}): string[] {
  const home = homedir()
  return [...new Set([
    ...(environment.PATH ?? '').split(delimiter), ...before,
    join(home, '.local/node/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...after
  ].filter(isAbsolute))]
}

const runnable = async (path: string): Promise<boolean> => (await stat(path)).isFile() && await access(path, constants.X_OK).then(() => true)

/**
 * The first `dirs` entry holding an executable file `name`, as its absolute path; undefined when none does.
 * `canRun` checks one candidate (tests pass their own); a candidate it throws on is skipped.
 */
export async function findExecutable(name: string, dirs: string[], canRun: (path: string) => Promise<boolean> = runnable): Promise<string | undefined> {
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (await canRun(candidate).catch(() => false)) return candidate
  }
  return undefined
}

export interface NodeRuntime {
  node: string
  npx: string
  /** npm's CLI script, run with `node`: Fig installs DSH from its lockfile with `npm ci` (shared/dsh-runtime.js). */
  npm: string
  version: string
  environment: NodeJS.ProcessEnv
}

export function supportsDsh(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) return false
  const major = Number(match[1])
  return major >= 24 || (major === 22 && Number(match[2]) >= 19)
}

/** Locate a user's runtime without executing shell startup files. */
export async function findNodeRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<NodeRuntime> {
  const home = homedir()
  const bins = executableDirectories(environment, { after: [join(home, '.volta/bin'), join(home, '.asdf/shims')] })
  const nvmRoot = join(environment.NVM_DIR || join(home, '.nvm'), 'versions/node')
  try {
    const versions = await readdir(nvmRoot)
    for (const version of versions.sort().reverse()) bins.push(join(nvmRoot, version, 'bin'))
  } catch {
    // nvm is optional; absence does not prevent conventional runtime discovery.
  }
  for (const bin of bins) {
    try {
      const node = await realpath(join(bin, 'node'))
      await access(node, constants.X_OK)
      const npx = await realpath(join(bin, 'npx'))
      const npm = await realpath(join(bin, 'npm'))
      const env: NodeJS.ProcessEnv = { ...environment, PATH: [bin, dirname(node), environment.PATH ?? '', '/usr/bin', '/bin'].join(delimiter) }
      // Electron-as-Node is not a replacement for the user's installed Node/npm.
      delete env.ELECTRON_RUN_AS_NODE
      // Only the discovery probe skips user preloads/options. Preserve them for DSH and tools.
      const probeEnvironment = { ...env }
      delete probeEnvironment.NODE_OPTIONS
      const { stdout } = await execFileAsync(node, ['--version'], { env: probeEnvironment, timeout: 5000 })
      const version = stdout.trim()
      if (supportsDsh(version)) return { node, npx, npm, version, environment: env }
    } catch {
      // A missing/broken candidate is skipped; all failures produce one actionable result below.
    }
  }
  throw new Error(uiText('未找到可用的 Node.js / npm。请安装 Node.js 22.19+（22.x）或 24+，然后重试。', 'No usable Node.js / npm was found. Install Node.js 22.19+ (22.x) or 24+, then retry.'))
}
