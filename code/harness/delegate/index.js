import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { executableDirectories, findExecutable } from '../environment'
import { fromDsh, textBlock } from '../shared/dsh-plugin.js'
import { runOwnedAgent } from '../shared/owned-agent.js'

// A `delegate_agent` tool for every DSH session and model: hand one task to an external coding agent
// (Codex or Claude Code) that runs with ITS OWN native authentication and settings, and bring its
// answer back for the caller to act on. The motivating case is a second opinion / review — "ask Codex
// (or Claude) to review this and report back" — so the external agent runs READ-ONLY by default: it may
// read the workspace but not change files, which keeps delegation safe and the result purely advisory.
// DSH ships official on-demand Codex/Claude subagents; this tool is the lighter, read-only alternative that
// shells out to the CLIs already on the machine, with no extra install.

export const name = 'fig-agents'
export const inject = ['tools', 'workingDirectory']

const toolName = 'delegate_agent'
const runTimeout = 600_000
const agents = ['codex', 'claude']

/** Where Fig looks for the external agents' CLIs: PATH first, then the usual install folders. */
const agentFolders = (env = process.env) => executableDirectories(env, { after: [join(homedir(), '.local/bin'), join(homedir(), '.claude/local')] })

/**
 * Where each installed external agent's CLI is: PATH first, then the usual install folders, because an app opened from
 * Finder gets only a minimal PATH (Homebrew and ~/.local/bin are missing). Checked once when the Host starts;
 * installing a CLI later needs a restart to appear.
 * @param {NodeJS.ProcessEnv} [env] @param {(path: string) => Promise<boolean>} [canRun]
 * @returns {Promise<Record<string, string>>} agent → absolute path
 */
export async function locateAgents(env = process.env, canRun = undefined) {
  const folders = agentFolders(env)
  /** @type {Record<string, string>} */
  const found = {}
  for (const agent of agents) {
    const path = await findExecutable(agent, folders, canRun)
    if (path) found[agent] = path
  }
  return found
}

// Set when the Host starts; the delegated process runs the CLI found there, not whatever its own PATH would pick.
let located = /** @type {Record<string, string>} */ ({})
// The same folders as the delegated process's PATH, so the agent's own tools (git, rg from Homebrew) are found
// too, as for the Grok and Codex CLIs Fig starts.
let searchPath = /** @type {string | undefined} */ (undefined)

/**
 * Resolve the CLI command + args for an external agent, writing its final answer to `outFile` when it can.
 * Both CLIs read the task from stdin, so task text can never be parsed as one of their options.
 */
export function agentCommand(agent, cwd, outFile) {
  if (agent === 'codex') {
    // codex exec: non-interactive, read-only sandbox, no git-repo requirement; -o captures the last message.
    // The OS sandbox only confines Codex's own shell and patch tools. User-configured MCP servers, plugin
    // servers (computer use) and ChatGPT app connectors run outside it and can write or act on the desktop,
    // so a review skips the user config (auth still comes from CODEX_HOME) and turns those features off.
    return { file: 'codex', args: ['exec', '--ignore-user-config', '--disable', 'apps', '--disable', 'computer_use',
      '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '-C', cwd, '-o', outFile, '-'] }
  }
  if (agent === 'claude') {
    // claude -p: only the read-only built-in tools, no MCP servers, and anything else is refused without
    // asking, so the user's own allow rules or default mode cannot let a review change files.
    return { file: 'claude', args: ['-p', '--output-format', 'text', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'] }
  }
  throw new Error(`unknown agent "${agent}" (use "codex" or "claude")`)
}

// Asked of every delegated task, so a review comes back in a form the conversation row can list. The caller's model
// reads the same block as plain text.
export const findingsRequest = '\n\nIf you report problems, end your answer with a line that says only FINDINGS, followed by one problem per line as '
  + '`[high|medium|low] path:line - summary` (path relative to the working directory; leave out `:line` when it does not apply). '
  + 'If you looked for problems and found none, write FINDINGS and then `none`. Skip the block when the task is not a review.'

// Matched against a trimmed line of bounded length, so no part of the pattern can backtrack across trailing whitespace.
const findingLine = /^(?:[-*]\s*)?\[(high|medium|low)\]\s+`?([^\s`]+?)(?::(\d+))?`?\s+[-–—]\s+(.+)$/i
const findingLineLimit = 2000
const findingLimit = 50

/**
 * The problems listed after the answer's last FINDINGS line. `undefined` when the answer has no such block (a
 * task that was not a review, or an agent that ignored the request); `[]` when the block says there are none.
 */
export function parseFindings(answer) {
  const lines = String(answer ?? '').split(/\r?\n/)
  const start = lines.findLastIndex(line => /^\s*(?:#+\s*)?[*_]*FINDINGS:?[*_]*:?\s*$/.test(line))
  if (start < 0) return undefined
  const findings = []
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    if (line.length > findingLineLimit) continue
    const match = findingLine.exec(line)
    if (match && findings.length < findingLimit) findings.push({ severity: match[1].toLowerCase(), path: match[2], line: match[3] ? Number(match[3]) : null, summary: match[4] })
  }
  return findings
}

/** Run the external agent and return its textual answer. */
export async function delegate({ agent, task }, cwd, signal) {
  const text = String(task ?? '').trim()
  if (!text) throw new Error('Give the task text to delegate.')
  // Validate before allocating scratch data, including for direct service callers.
  agentCommand(agent, cwd, '')
  const scratch = await mkdtemp(join(tmpdir(), 'fig-agents-'))
  const outFile = join(scratch, 'answer.txt')
  const { file: command, args } = agentCommand(agent, cwd, outFile)
  const file = located[agent] ?? command
  let cleanupConfirmed = true
  try {
    const result = await runOwnedAgent({ file, args, cwd, input: text + findingsRequest, signal, ...(searchPath ? { env: { ...process.env, PATH: searchPath } } : {}) }).catch(error => {
      if (error.code === 'AGENT_CLEANUP_FAILED') cleanupConfirmed = false
      if (error.code === 'ENOENT') throw new Error(`${agent} CLI not found on PATH`)
      throw error
    })
    // Codex writes the final message to -o; Claude prints it to stdout.
    const captured = agent === 'codex' ? await readFile(outFile, 'utf8').catch(() => '') : ''
    const answer = (captured || result.out).trim()
    if (!answer && result.code !== 0) throw new Error(`${agent} exited ${result.code}: ${result.err.trim().slice(0, 500) || 'no output'}`)
    return { agent, exitCode: result.code, elapsedMs: result.elapsedMs, text: answer || '(the agent returned no text)' }
  } finally {
    if (cleanupConfirmed) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function apply(ctx) {
  // Offer only the agents installed here, so a model is never handed a tool that can only fail.
  located = await locateAgents()
  searchPath = agentFolders().join(delimiter)
  const available = agents.filter(agent => located[agent])
  if (!available.length) {
    ctx.logger?.info?.('fig-agents: neither the codex nor the claude CLI is installed; delegate_agent not registered')
    return
  }
  const { defineTool } = await fromDsh('@deepseek-ai/dsh-tools')
  const names = { codex: 'Codex', claude: 'Claude Code' }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: `Delegate ONE task to an external coding agent (${available.map(agent => names[agent]).join(' or ')}) running under its own account, `
      + 'and return its answer. Use it for a second opinion or a review — e.g. "have the agent review this change and report '
      + 'what is wrong". The external agent runs READ-ONLY (it can read the working directory but cannot change files'
      + (available.includes('codex') ? '; Codex runs with its default model and without the user\'s MCP servers or app connectors' : '') + '), so '
      + 'the result is advisory; put everything it needs in `task`, including what to review and what to report back. Takes '
      + 'up to several minutes.',
    parameters: {
      agent: { type: 'string', required: true, enum: available, description: 'Which external agent to ask.' },
      task: { type: 'string', required: true, description: 'The full instructions for the external agent, including the content or paths to review and the exact report you want back.' }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(value.text)],
      presentationMeta: (_args, value) => ({ kind: 'fig-delegate', agent: value.agent, exitCode: value.exitCode, elapsedMs: value.elapsedMs,
        findings: parseFindings(value.text) ?? null })
    },
    timeoutMs: runTimeout,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return delegate(args, cwd, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `Delegate to ${String(args.agent ?? '')}`, kind: 'read' })
  })))
}
