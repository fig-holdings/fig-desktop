import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants, createWriteStream, type WriteStream } from 'node:fs'
import { access, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { executableDirectories, findExecutable, resolveLaunchProxy } from '../environment'
import { PublicError } from '../shared/public-error'
import { logLine } from '../shared/log'
import { safeFailure } from './shared'
import { uiText } from '../shared/ui-text'

type Pending = { accept: (result: unknown) => void; reject: (error: Error) => void }

const logLimit = 1024 * 1024

async function openLog(path: string): Promise<WriteStream | undefined> {
  try {
    if (((await stat(path).catch(() => undefined))?.size ?? 0) > logLimit) await rename(path, path + '.1')
    const stream = createWriteStream(path, { flags: 'a', mode: 0o600 })
    stream.on('error', () => undefined)
    return stream
  } catch { return undefined }
}

/** Finds the official Grok CLI and the environment Fig launches it with. */
export async function grokCommand(): Promise<{ executable: string; env: NodeJS.ProcessEnv }> {
  const paths = executableDirectories(process.env, { before: [join(homedir(), '.local/bin')], after: ['/usr/bin', '/bin'] })
  const executable = await findExecutable('grok', paths)
  if (!executable) throw new PublicError(uiText('未找到 Grok CLI。请先安装官方 Grok CLI，再在设置「Grok 账号」中登录。', 'Grok CLI was not found. Install the official Grok CLI, then sign in under Settings › Grok Account.'))
  const env = await resolveLaunchProxy({ ...process.env, PATH: paths.join(delimiter) })
  for (const key of ['XAI_API_KEY', 'GROK_API_KEY', 'XAI_BASE_URL', 'XAI_API_BASE_URL',
    'GROK_BASE_URL', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'CLI_CHAT_PROXY_BASE_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    delete env[key]
  }
  return { executable, env }
}

/**
 * An owned ACP v1 stdio connection, used only for the CLI's own sign-in renewal and billing calls; no
 * agent session runs on it. The child stays in the Host's process group.
 */
export class GrokAcp {
  private sequence = 0
  private pending = new Map<number, Pending>()
  private ended = false
  private stopping?: Promise<void>

  private constructor(private readonly child: ChildProcessWithoutNullStreams, log?: WriteStream) {
    // CLI diagnostics can contain local paths or authentication details. Keep only a redacted local log.
    if (log) {
      createInterface({ input: child.stderr }).on('line', line => {
        const clean = logLine(line)
        if (clean) log.write(`${new Date().toISOString()} ${clean}\n`)
      }).on('close', () => log.end())
    } else child.stderr.resume()
    child.stdin.on('error', () => this.disconnect())
    child.on('error', () => this.disconnect())
    child.on('exit', () => this.disconnect())
    createInterface({ input: child.stdout }).on('line', line => this.receive(line))
  }

  /**
   * Starts the CLI's ACP agent for a headless sign-in refresh or a quota read. No agent session runs on
   * it, so nothing here relies on the permission and sandbox flags; they are kept (asking mode, workspace
   * sandbox) as a cautious default because it is unverified whether the CLI acts on them at startup.
   */
  static async start(cwd: string, log?: string): Promise<GrokAcp> {
    const { executable, env } = await grokCommand()
    // A missing working directory makes spawn fail with ENOENT; refuse it plainly instead.
    if (!await access(cwd, constants.F_OK).then(() => true, () => false)) throw new PublicError(uiText('Grok CLI 工作目录不存在。', 'The Grok CLI working folder does not exist.'))
    // Open the log first: the child's error listener must be attached in the same tick as
    // spawn, or a launch failure becomes an uncaught exception that stops DSH.
    const stream = log ? await openLog(log) : undefined
    return new GrokAcp(spawn(executable, [
      '--no-auto-update', '--permission-mode', 'default', '--sandbox', 'workspace', 'agent', '--no-leader', 'stdio'
    ], { cwd, env }), stream)
  }

  async request<T>(method: string, params: object, timeout = 45_000): Promise<T> {
    if (this.ended) throw new PublicError(uiText('Grok CLI 连接已关闭。', 'The Grok CLI connection closed.'))
    const id = ++this.sequence
    const timer = timeout ? setTimeout(() => {
      this.pending.get(id)?.reject(new PublicError(uiText(`Grok CLI 未及时响应 ${method}。`, `Grok CLI did not answer ${method} in time.`)))
    }, timeout) : undefined
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { accept: result => resolve(result as T), reject })
        this.send({ id, method, params })
      })
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.disconnect()
      this.child.stdin.end()
      if (!this.child.pid) return
      // Never signal the Host's own process group.
      const exited = () => this.child.exitCode !== null || this.child.signalCode !== null
      const deadline = Date.now() + 1500
      while (!exited() && Date.now() < deadline) await delay(25)
      if (!exited()) this.child.kill('SIGKILL')
    })().catch(error => {
      this.stopping = undefined
      throw error
    })
    return this.stopping
  }

  private send(message: object): void {
    if (!this.ended) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  }

  private disconnect(): void {
    if (this.ended) return
    this.ended = true
    for (const pending of this.pending.values()) pending.reject(new PublicError(uiText('Grok CLI 连接已关闭。', 'The Grok CLI connection closed.')))
  }

  private receive(line: string): void {
    if (this.ended) return
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message?.jsonrpc !== '2.0') return
    const { id, method, result, error } = message
    if (typeof method === 'string') {
      // Notifications are ignored; with no agent session, no request from the CLI is expected.
      if (id !== undefined) this.send({ id, error: { code: -32601, message: 'Method not supported by Fig' } })
    } else if (error) {
      // Classify locally and keep only fixed text. Provider messages may contain credentials.
      const code = Number(error.code) || -32603
      const detail = [error.message, JSON.stringify(error.data ?? '')].join(' ')
      const failure = safeFailure(`GROK_ACP_${code}`, detail)
      this.pending.get(id)?.reject(new PublicError(failure.code === `GROK_ACP_${code}`
        ? uiText(`Grok CLI 请求失败（${code}）。`, `Grok CLI request failed (${code}).`) : failure.message, failure.code))
    } else {
      this.pending.get(id)?.accept(result)
    }
  }
}

/** Redacted Grok CLI diagnostics (sign-in renewal and billing) live under DSH's home. */
async function logPath(): Promise<string | undefined> {
  const root = process.env.DSH_HOME
  if (!root || !isAbsolute(root)) return undefined
  const directory = join(root, 'fig-grok')
  return mkdir(directory, { recursive: true, mode: 0o700 }).then(() => join(directory, 'grok-cli.log'), () => undefined)
}

interface GrokInit {
  protocolVersion?: number
  authMethods?: { id: string }[]
}

/** Starts the Grok CLI over ACP and signs in with its cached token, without opening a browser. */
export async function connect(cwd: string): Promise<{ connection: GrokAcp }> {
  const connection = await GrokAcp.start(cwd, await logPath())
  try {
    const init = await connection.request<GrokInit>('initialize', { protocolVersion: 1, clientCapabilities: {} })
    if (init.protocolVersion !== 1) throw new PublicError(uiText('当前 Grok CLI 的 ACP 版本不兼容。', 'This Grok CLI ACP version is not compatible.'))
    try {
      if (!init.authMethods?.some(method => method.id === 'cached_token')) throw new Error()
      await connection.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } })
    } catch {
      throw new PublicError(uiText('无法使用 Grok CLI 登录。请在设置「Grok 账号」中重新登录后重试。', 'Could not use the Grok CLI sign-in. Sign in again under Settings › Grok Account, then retry.'))
    }
    return { connection }
  } catch (error) {
    await connection.stop()
    throw error
  }
}
