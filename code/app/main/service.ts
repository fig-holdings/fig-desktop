import { EventEmitter } from 'node:events'
import type { Writable } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { runOwnedAgent } from '../../harness/shared/owned-agent.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { mkdir, rm } from 'node:fs/promises'
import { figCacheRoot, figNpmCache } from '../../harness/shared/npx-cache.js'
import { dshRuntimeRoot, ensureDshRuntime, lockedRelease, staleRuntimes, type DshRuntimeLock } from '../../harness/shared/dsh-runtime.js'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { findNodeRuntime, resolveLaunchProxy } from '../../harness/environment'
import { launchDsh } from '../../harness/dsh-versions'
import { errorText, logLine, sanitizeLog, stripAnsi } from '../../harness/shared/log'
import type { ServiceState } from '../shared/protocol'
import { tr } from './language'
import { writePluginConfig } from './plugin-config'
import { ensureBundles } from './bundles'
import { ensureExternalPlugins, type WorkbenchProviderEntry } from './external-plugins'
import { pruneUpdates, selectUpdates } from './plugin-updates'
import { nextGeneration, type ProfileDescriptor, type TrustedKey } from './profile'
import type { ProfileState } from '../../harness/shared/profile-contract.ts'
import { pnpmShim } from './pnpm-shim'
import { startCoworkPluginBridge } from './cowork-plugin-bridge'
import type { TeamAuthorization, TeamRequestProof } from './cowork-session'

/**
 * The DSH release whose native model settings Fig patches for account model discovery (shell-bridge/native-model-catalog.js). Another release runs without the patch, on its own catalog, until it is verified and
 * named here; the patch goes once DSH offers a hook between credential resolution and its pi-ai model list.
 */
const modelCatalogRelease = '0.2.2-rc.5'

export interface LaunchCommand {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  version?: string
}

export interface ServiceOptions {
  homeDirectory: string
  workingDirectory: string
  previousDshHome?: string
  /** The extra skill folder the skills-dir package registers; none when unset. */
  skillDirectory?: string
  /** The packages' own patches, in load order; Fig's config layer (plugin-config.ts) follows them. */
  webPatches?: readonly string[]
  /** Packages installed into the Web profile as plugin bundles (bundles.ts): the build folder and each package's
   * folder and insert id. One that cannot be installed is patched in like webPatches. */
  bundles?: { built: string, packages: readonly { folder: string, id: string }[],
    /** Plugin updates (plugin-updates.ts): this Fig release and the keys built into Fig. Without them none is used. */
    updates?: { appVersion: string, keys: readonly TrustedKey[] } }
  /** This Profile's descriptor (profile.ts), read at each start: its edition, shell look and external plugins. */
  profile?: () => Promise<ProfileDescriptor>
  /** The exact DSH release to run; the newest verified one unless a candidate is being verified. */
  dshVersion?: string
  /** The manifest and lockfile DSH is installed from (code/dsh-runtime/, or a candidate's); it must pin `dshVersion`. */
  dshRuntime?: DshRuntimeLock
  environment?: NodeJS.ProcessEnv
  /** Fig's capture mode for the `preview` tool (harness/preview). */
  previewCommand?: { executable: string, args: string[] }
  attentionBootstrap?: string
  modelCatalogBootstrap?: string
  authorizeTeamRequest?: (profile: string, request: TeamRequestProof) => Promise<TeamAuthorization>
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  /** Rejects when this process must not start DSH again (bundle-replacement.ts); its message is shown. */
  ensureCurrent?: () => Promise<void>
  /** Dependency injection for lifecycle tests; never configurable through renderer IPC. */
  resolveCommand?: () => Promise<LaunchCommand>
}

type NodeRuntime = Awaited<ReturnType<typeof findNodeRuntime>>
type Attention = { capability: string; generation: string }
/** What a launch needs besides the command: the attention capability and the Profile this start installed. */
interface Prepared { command: LaunchCommand, attention?: Attention, profile?: ProfileState }

/** Starts DSH Web from its installed entry (shared/dsh-runtime.js) on an ephemeral loopback port. */
export function dshArguments(entry: string): string[] {
  if (!entry.startsWith('/')) throw new Error('Invalid DSH entry')
  return [entry, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0']
}

/** npm's network failures, for a plain message instead of npm's log. */
const npmNetworkError = /\b(?:EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|FETCH_ERROR|CERT_HAS_EXPIRED|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\b/

/** Only accept the documented, process-owned startup line on explicit loopback. */
export function parseLaunchUrl(line: string): string | undefined {
  const match = /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/.exec(stripAnsi(line))
  if (!match) return undefined
  try {
    const url = new URL(match[1])
    if (url.hostname !== '127.0.0.1' || url.username || url.password || !url.port) return undefined
    return url.href
  } catch {
    return undefined
  }
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/** macOS can briefly report EPERM while a signalled group disappears. Never treat it as absent. */
async function settledGroupExists(pid: number): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try { return groupExists(pid) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 20) throw error
      await delay(25)
    }
  }
}

export async function stopProcessGroup(pid: number, graceMs = 5000): Promise<void> {
  if (!await settledGroupExists(pid)) return
  try { process.kill(-pid, 'SIGTERM') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && await settledGroupExists(pid)) throw error
  }
  const deadline = Date.now() + graceMs
  while (await settledGroupExists(pid) && Date.now() < deadline) await delay(50)
  if (await settledGroupExists(pid)) {
    try { process.kill(-pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && await settledGroupExists(pid)) throw error
    }
    const killDeadline = Date.now() + 2000
    while (await settledGroupExists(pid) && Date.now() < killDeadline) await delay(50)
    if (await settledGroupExists(pid)) throw new Error(tr('DSH 进程尚未完全停止，请稍后重试退出。', 'DSH processes have not fully stopped. Try quitting again shortly.'))
  }
}

/** Owns exactly the process group created for this application launch. */
export class DshService extends EventEmitter {
  private child?: ChildProcess
  private controller?: AbortController
  private pending?: Promise<void>
  private stopped?: Promise<void>
  private url?: string
  private attention?: Attention
  private profileState?: ProfileState
  private activeUpdates: Record<string, string> = {}
  private current: ServiceState = { phase: 'idle', message: tr('准备启动', 'Getting ready'), logs: [] }

  constructor(private readonly options: ServiceOptions) { super() }

  get state(): ServiceState { return { ...this.current, logs: [...this.current.logs] } }
  get launchUrl(): string | undefined {
    const child = this.child
    if (this.current.phase === 'ready' && child?.exitCode === null && child.signalCode === null) return this.url
  }
  /** The Profile as this start installed it (external plugins and their state); undefined before the first start. */
  get profile(): ProfileState | undefined { return this.profileState }
  /** Package name → plugin update version linked at the last start (plugin-updates.ts). */
  get updates(): Readonly<Record<string, string>> { return this.activeUpdates }
  /** Main-process only; never part of state/IPC/logging. */
  get attentionConnection() { return this.attention && this.url ? { ...this.attention, origin: new URL(this.url).origin } : undefined }
  private get stopTimeout(): number { return this.options.stopTimeoutMs ?? 5000 }

  private update(patch: Partial<ServiceState>): void {
    this.current = { ...this.current, ...patch }
    this.emit('state', this.state)
  }

  private log(line: string): void {
    const clean = logLine(line)
    if (!clean) return
    this.update({ logs: [...this.current.logs, clean].slice(-100) })
  }

  async start(): Promise<void> {
    if (this.pending) return this.pending
    if (this.stopped) await this.stopped
    if (this.current.phase === 'ready') return
    this.pending = this.launch().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async launch(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.url = undefined
    this.attention = undefined
    let teamBridge: Awaited<ReturnType<typeof startCoworkPluginBridge>> | undefined
    let teamCapability: string | undefined
    this.update({ phase: 'checking', message: tr('检查本机运行环境', 'Checking this Mac\'s runtime'), logs: [], error: undefined, pid: undefined })
    try {
      await this.options.ensureCurrent?.()
      await mkdir(this.options.homeDirectory, { recursive: true })
      const prepared = this.options.resolveCommand ? { command: await this.options.resolveCommand() } : await this.resolveCommand(controller.signal)
      if (controller.signal.aborted) return
      const command = prepared.command
      this.attention = prepared.attention
      if (prepared.profile) this.profileState = prepared.profile
      const authorize = this.options.authorizeTeamRequest, profile = prepared.profile
      if (this.attention && authorize && profile?.edition === 'team') {
        teamCapability = randomBytes(32).toString('hex')
        teamBridge = await startCoworkPluginBridge(teamCapability, controller.signal, request => authorize(profile.id, request))
      }
      if (controller.signal.aborted) return
      this.update({ phase: 'starting', message: tr('正在启动 DSH', 'Starting DSH'), nodeVersion: command.version })
      const child = spawn(command.executable, command.args, {
        cwd: this.options.workingDirectory,
        env: command.env,
        detached: true,
        shell: false,
        stdio: this.attention ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
      })
      if (this.attention) {
        const bootstrapPipe = child.stdio[3] as Writable
        bootstrapPipe.on('error', () => controller.abort())
        bootstrapPipe.end(JSON.stringify({ ...this.attention, teamPort: teamBridge?.port, teamCapability }))
      }
      this.child = child
      child.once('exit', () => { teamBridge?.close(); if (this.child === child) this.emit('process-exit') })
      this.update({ pid: child.pid })
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let npmNetworkFailure = false
        const buffers = { stdout: '', stderr: '' }
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', abort)
          if (error) reject(error); else resolve()
        }
        const abort = () => finish(new Error(tr('启动已取消', 'Startup cancelled')))
        const timer = setTimeout(() => finish(new Error(tr('DSH 启动超时，请检查网络并重试。', 'DSH took too long to start. Check the network and retry.'))), this.options.startupTimeoutMs ?? 360_000)
        controller.signal.addEventListener('abort', abort, { once: true })
        const line = (text: string) => {
          if (/^npm (?:error|ERR!) code (?:EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|FETCH_ERROR|CERT_HAS_EXPIRED|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\b/i.test(text)) {
            npmNetworkFailure = true
          }
          const url = parseLaunchUrl(text)
          this.log(text)
          if (url && !settled && !controller.signal.aborted) {
            this.url = url
            this.update({ phase: 'ready', message: tr('DSH 已就绪', 'DSH is ready') })
            this.emit('ready', url)
            finish()
          }
        }
        const consume = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
          buffers[kind] += chunk.toString()
          const lines = buffers[kind].split(/\r?\n|\r/)
          buffers[kind] = lines.pop() ?? ''
          for (const value of lines) line(value)
          if (buffers[kind].length > 16_384) { line(buffers[kind]); buffers[kind] = '' }
        }
        child.stdout!.on('data', (chunk: Buffer) => consume('stdout', chunk))
        child.stderr!.on('data', (chunk: Buffer) => consume('stderr', chunk))
        child.once('error', error => finish(new Error(tr(`无法启动 DSH：${error.message}`, `Could not start DSH: ${error.message}`))))
        child.once('close', (code, signal) => {
          if (buffers.stdout) line(buffers.stdout)
          if (buffers.stderr) line(buffers.stderr)
          const error = new Error(tr(`DSH 已停止（${signal ?? `退出码 ${code}`}）。请查看诊断后重试。`, `DSH stopped (${signal ?? `exit code ${code}`}). Check the diagnostics and retry.`))
          if (!settled) finish(npmNetworkFailure
            ? new Error(tr('无法连接 npm 获取 DSH。请检查网络或代理设置，然后重试。', 'Could not reach npm to get DSH. Check the network or proxy settings, then retry.'))
            : error)
          else if (!controller.signal.aborted) {
            this.url = undefined
            this.update({ phase: 'failed', message: tr('DSH 意外停止', 'DSH stopped unexpectedly'), error: error.message })
            // Reap remaining descendants immediately; never retain an exited leader's PID for a later retry.
            if (child.pid) void stopProcessGroup(child.pid, this.stopTimeout)
              .then(() => this.emit('confirmed-exit'))
              .catch(cleanupError => this.log(tr('退出清理：', 'Exit cleanup: ') + errorText(cleanupError)))
              .finally(() => { if (this.child === child) this.child = undefined })
          }
        })
      })
    } catch (error) {
      teamBridge?.close()
      if (this.child?.pid) await stopProcessGroup(this.child.pid, this.stopTimeout)
        .catch(cleanupError => this.log(tr('启动清理：', 'Startup cleanup: ') + errorText(cleanupError)))
      this.child = undefined
      if (!controller.signal.aborted) {
        this.url = undefined
        this.update({ phase: 'failed', pid: undefined, message: tr('暂时无法启动', 'Could not start for now'), error: sanitizeLog(errorText(error)) })
      }
    }
  }

  /** The launch command and, for the verified direct DSH process, its one-use attention capability. */
  private async resolveCommand(signal: AbortSignal): Promise<Prepared> {
    const { runtime, env, npmCache } = await this.launchEnvironment()
    const version = this.options.dshVersion ?? launchDsh
    const entry = await this.installDsh(runtime, env, npmCache, version, signal)
    const install = await this.installPlugins(runtime, env, version, entry, signal)
    const args = dshArguments(entry)
    // DSH parses profile overlays before forwarding the remaining flags to Web.
    args.splice(args.indexOf('--no-open'), 0, ...install.patches.flatMap(path => ['--patch', path]))
    const command = { executable: runtime.node, args, env, version: runtime.version }
    if (!this.options.attentionBootstrap) return { command, profile: install.profile }
    const preloads = [this.options.attentionBootstrap]
    if (version === modelCatalogRelease && this.options.modelCatalogBootstrap) preloads.push(this.options.modelCatalogBootstrap)
    return {
      command: { ...command, args: [...preloads.map(file => `--import=${pathToFileURL(file).href}`), ...args] },
      attention: { capability: randomBytes(32).toString('hex'), generation: randomUUID() },
      profile: install.profile
    }
  }

  /** The runtime and the environment DSH and its npm installs run with. */
  private async launchEnvironment() {
    const runtime = await findNodeRuntime(this.options.environment)
    const npmCache = figNpmCache()
    const env: NodeJS.ProcessEnv = { ...await resolveLaunchProxy(runtime.environment),
      DSH_HOME: this.options.homeDirectory,
      // Keep npm's executable cache separate from Application Support and durable DSH data.
      npm_config_cache: npmCache,
      npm_config_update_notifier: 'false',
      NO_COLOR: '1', CI: '1'
    }
    // A saved DSH provider wins over this launch default, including when its plugin is disabled.
    if (this.options.bundles) env.DSH_WEB_SEARCH_PROVIDER ??= 'fig-follow-model'
    // First on PATH: it runs the installed pnpm (or npx's pinned one) and keeps DSH's package lookups working with npm 12 (pnpm-shim.ts).
    const shim = await pnpmShim(runtime.npx, join(figCacheRoot(), 'bin'), env.PATH ?? '').catch(() => undefined)
    if (shim) env.PATH = [shim, env.PATH ?? ''].filter(Boolean).join(delimiter)
    delete env.FORCE_COLOR
    return { runtime, env, npmCache }
  }

  /**
   * Installs the locked DSH release once (shared/dsh-runtime.js) and returns its entry; removes older installs.
   * Installation runs without any capability; only the started DSH process receives the one-use attention pipe.
   */
  private async installDsh(runtime: NodeRuntime, env: NodeJS.ProcessEnv, npmCache: string, version: string, signal: AbortSignal): Promise<string> {
    const locked = this.options.dshRuntime
    if (!locked) throw new Error('No DSH lockfile')
    if (lockedRelease(locked.manifest, locked.lock).version !== version) throw new Error(`The DSH lockfile does not install DSH ${version}`)
    const root = dshRuntimeRoot()
    const installed = await ensureDshRuntime({ ...locked, root, node: runtime.node, npm: runtime.npm, env, cache: npmCache,
      signal: AbortSignal.any([signal, AbortSignal.timeout(900_000)]),
      onInstall: () => this.update({ message: tr(`正在安装 DSH ${version}（首次需要几分钟）`, `Installing DSH ${version} (the first time takes a few minutes)`) })
    }).catch(error => {
      if (signal.aborted) throw error
      if (npmNetworkError.test(errorText(error))) throw new Error(tr('无法连接 npm 获取 DSH。请检查网络或代理设置，然后重试。', 'Could not reach npm to get DSH. Check the network or proxy settings, then retry.'))
      throw error
    })
    for (const folder of staleRuntimes(root, installed.folder)) {
      await rm(folder, { recursive: true, force: true }).then(() => this.log('Removed an older DSH install: ' + folder),
        error => this.log(sanitizeLog('An older DSH install was not removed: ' + errorText(error))))
    }
    return installed.entry
  }

  /** Installs Fig's bundles and the Profile's plugins, writes their config; returns the patches to load and the Profile. */
  private async installPlugins(runtime: NodeRuntime, env: NodeJS.ProcessEnv, version: string, entry: string, signal: AbortSignal): Promise<{ patches: string[], profile?: ProfileState }> {
    // Fig's feature packages as Web profile bundles, linked again only when this build changed them.
    const bundles = this.options.bundles
    const installPlugin = async (pluginArgs: string[]) => {
      const result = await runOwnedAgent({ file: runtime.node, args: [entry, 'plugin', '--profile', 'web', ...pluginArgs],
        nodeExecutable: runtime.node, cwd: this.options.homeDirectory, env, input: '', signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) })
      if (result.code !== 0) throw new Error('dsh plugin ' + pluginArgs[0] + ' failed: ' + sanitizeLog(result.err.slice(-400)))
    }
    if (bundles) this.update({ message: tr('正在安装 Fig 插件', 'Installing Fig plugins') })
    const folders = bundles?.packages.map(item => item.folder) ?? []
    // Plugin updates replace single packages for this Fig release; a failure here leaves the built-in copies.
    const updates = bundles?.updates ? await selectUpdates({ dshHome: this.options.homeDirectory, built: bundles.built, packages: folders,
      appVersion: bundles.updates.appVersion, dshRelease: version, keys: bundles.updates.keys, log: line => this.log(sanitizeLog(line)) })
      .catch(error => { this.log(sanitizeLog('Plugin updates were not read: ' + errorText(error))); return undefined }) : undefined
    this.activeUpdates = updates?.active ?? {}
    const installed = bundles ? await ensureBundles({ built: bundles.built, packages: folders, overrides: updates?.overrides, dshHome: this.options.homeDirectory,
      log: line => this.log(sanitizeLog(line)), plugin: installPlugin }) : undefined
    if (bundles?.updates) await pruneUpdates(this.options.homeDirectory).catch(error => this.log(sanitizeLog('Unused plugin updates were not removed: ' + errorText(error))))
    // Plugins from outside Fig's build that this Profile names (external-plugins.ts), through the same install path.
    const descriptor = await this.options.profile?.()
    if (descriptor?.unreadable) this.log('fig/profile.json is not valid JSON; it is kept as written and Profile plugins are left as they are')
    let profile: ProfileState | undefined
    const workbenchProviders: WorkbenchProviderEntry[] = []
    if (descriptor) {
      if (descriptor.plugins.length) this.update({ message: tr('正在安装 Profile 插件', 'Installing Profile plugins') })
      // Also with none listed: what an earlier descriptor installed is removed.
      const plugins = descriptor.unreadable ? [] : await ensureExternalPlugins({ entries: descriptor.plugins, trustedKeys: descriptor.trustedKeys,
        dshHome: this.options.homeDirectory, dshRelease: version, plugin: installPlugin, teamPlugins: descriptor.teamPlugins, log: line => this.log(sanitizeLog(line)),
        onWorkbenchProvider: descriptor.edition === 'team' ? entry => workbenchProviders.push(entry) : undefined })
      profile = { id: descriptor.id, edition: descriptor.edition, shell: descriptor.shell, plugins, coworkOrigin: descriptor.coworkOrigin, teamModels: descriptor.teamModels,
        dshGeneration: await nextGeneration(this.options.homeDirectory) }
    }
    // A package the profile lacks is patched in; one switched off on the Plugins page gets no config row.
    const fallback = bundles && installed ? bundles.packages.filter(item => installed.missing.includes(item.folder)).map(item => join(bundles.built, item.folder, 'cordis.patch.yml')) : []
    const switchedOff = bundles && installed ? bundles.packages.filter(item => installed.switchedOff.has(item.folder)).map(item => item.id) : []
    // The packages take their settings as plugin config, written at each start after their own patches.
    if (workbenchProviders.length > 1) this.log('Development workbench: multiple signed providers requested registration')
    const config = this.options.webPatches?.length || bundles ? await writePluginConfig(this.options.homeDirectory, {
      startupDirectory: this.options.workingDirectory, previousDshHome: this.options.previousDshHome, profile,
      workbenchProvider: workbenchProviders.length === 1 ? workbenchProviders[0] : undefined,
      skillDirectory: this.options.skillDirectory, previewRenderer: this.options.previewCommand
    }, new Set(switchedOff)) : undefined
    return { patches: [...this.options.webPatches ?? [], ...fallback, ...config ? [config] : []], profile }
  }

  async retry(): Promise<void> { await this.stop(); await this.start() }

  async stop(): Promise<void> {
    if (this.stopped) return this.stopped
    this.stopped = this.stopOwned().finally(() => { this.stopped = undefined })
    return this.stopped
  }

  private async stopOwned(): Promise<void> {
    this.controller?.abort()
    this.update({ phase: 'stopping', message: tr('正在停止 DSH', 'Stopping DSH') })
    try {
      if (this.child?.pid) await stopProcessGroup(this.child.pid, this.stopTimeout)
    } catch (error) {
      // Keep the child so the next stop or retry tries again; 'failed' lets the page offer Retry.
      this.update({ phase: 'failed', message: tr('无法停止 DSH', 'Could not stop DSH'), error: sanitizeLog(errorText(error)) })
      throw error
    }
    await this.pending
    this.child = undefined
    this.url = undefined
    this.attention = undefined
    this.update({ phase: 'idle', message: tr('DSH 已停止', 'DSH stopped'), pid: undefined })
    this.emit('confirmed-exit')
  }

  /** Last-resort cleanup on synchronous process exit; normal quit awaits stop(). */
  killOnExit(): void {
    if (!this.child?.pid) return
    try { process.kill(-this.child.pid, 'SIGKILL') } catch {
      // The process group may already have exited during orderly shutdown.
    }
  }
}
