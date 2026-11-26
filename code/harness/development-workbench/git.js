import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { insideCheckout } from './commit.js'
import { MAX_FILE_LINES, parsePatch } from './patch.js'

// Git facts for the 研发工作台: the checkout, its uncommitted changes and the branch compared with its base. The
// readers here only read (the runner also serves the card's worktree writes in index.js). Every command runs under
// the Session's sandbox policy; the safety settings follow DSH's experimental
// forge panel (MIT, @deepseek-ai/dsh-experimental-client-ui-forge 0.2.2-rc.1): no hooks, filesystem monitor, optional
// index writes, prompts or lazy fetches, inherited repository selectors cleared, and the repository's clean/process
// filters switched off for each diff so reading changes never runs a program the repository configures.

/** Arguments before every subcommand. */
const GIT_PREFIX = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/** Inherited selectors cleared, prompts, optional locks and lazy fetches off. */
export const GIT_ENV = {
  ...Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CEILING_DIRECTORIES',
    'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE', 'GIT_EXTERNAL_DIFF'].map(key => [key, undefined])),
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C'
}

/** git's empty tree, the comparison base before the first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const NOT_A_CHECKOUT = /not a git repository|must be run in a work tree/i
const DIFF_FLAGS = ['--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty']

/** maxUntrackedTotalBytes: what the card's line count reads across all untracked files on each refresh. */
export const limits = { timeoutMs: 10_000, maxOutputBytes: 4 * 1024 * 1024, maxUntracked: 500, maxUntrackedBytes: 1024 * 1024, maxUntrackedTotalBytes: 4 * 1024 * 1024 }

/**
 * Totals of `git diff --numstat -z`: files, added and deleted lines. Binary files ("-\t-") count as files only.
 * A rename prints "added\tdeleted\t" then the old and new paths as separate NUL-terminated fields.
 * @param {string} text
 */
export function parseNumstat(text) {
  const fields = text.split('\0')
  const paths = new Set()
  let added = 0, deleted = 0
  for (let index = 0; index < fields.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[index])
    if (!match) continue
    if (match[1] !== '-') added += Number(match[1])
    if (match[2] !== '-') deleted += Number(match[2])
    if (match[3]) paths.add(match[3])
    else { paths.add(fields[index + 2] ?? fields[index + 1] ?? ''); index += 2 }
  }
  return { files: paths.size, added, deleted, paths }
}

/**
 * Overrides that switch off every clean/process filter `git config --get-regexp` listed; with `smudge`, smudge filters
 * too, so creating a worktree never runs a program the repository configures (LFS smudge, decryption…).
 * @param {string} text @param {boolean} [smudge]
 * @returns {Record<string, string>}
 */
export function filterOverrides(text, smudge = false) {
  const keys = smudge ? /^filter\..+\.(clean|smudge|process)$/ : /^filter\..+\.(clean|process)$/
  /** @type {Record<string, string>} */
  const overrides = {}
  for (const line of text.split('\n')) {
    const key = line.split(' ')[0]
    if (keys.test(key)) overrides[key] = ''
  }
  return overrides
}

/**
 * The repository's filter overrides, read from its config: clean/process for reading changes, all three drivers
 * (`smudge`) for a checkout. @param {any} git @param {{ smudge?: boolean }} [options]
 */
export async function readFilters(git, { smudge = false } = {}) {
  const pattern = smudge ? '^filter\\.' : '^filter\\..*\\.(clean|process)$'
  return filterOverrides((await git(['config', '--get-regexp', pattern], [0, 1])).stdout, smudge)
}

/**
 * The bytes of an untracked regular file of at most `maxBytes`, or undefined. git lists a symlink (to a folder, to a file
 * outside the checkout, to a FIFO) as an ordinary untracked path; the Host reads outside the Session's sandbox, so it
 * never follows one and never blocks on a special file.
 * @param {string} path @param {number} maxBytes
 */
async function readUntracked(path, maxBytes, tooLarge = () => {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined)
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile()) return undefined
    if (info.size > maxBytes) { tooLarge(); return undefined }
    const buffer = Buffer.alloc(info.size)
    if (info.size) await handle.read(buffer, 0, info.size, 0)
    return buffer
  } catch { return undefined } finally { await handle.close() }
}

/** Lines in a text file's bytes; binary or empty count 0. @param {Buffer | undefined} buffer */
function textLines(buffer) {
  if (!buffer?.length || buffer.subarray(0, 8000).includes(0)) return 0
  let lines = 0
  for (const byte of buffer) if (byte === 10) lines++
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1
}

/**
 * A git runner bound to one directory, under one sandbox policy, through DSH's subprocess and sandbox services.
 * @param {{ subprocess: any, sandbox: any }} services
 * @param {{ mode: string }} policy
 * @param {string} cwd
 * @param {AbortSignal} signal
 */
export function gitRunner(services, policy, cwd, signal) {
  return async function git(args, allowed = [0], config = {}) {
    const name = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c') ?? args[0]
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)])
    const command = [await services.subprocess.resolveExecutable('git', undefined, timeout), ...GIT_PREFIX, ...args]
    // An unrestricted session needs no confinement; any other mode is confined, and fails closed if it cannot be.
    const argv = policy.mode === 'danger-full-access' ? command : (await services.sandbox.confine(command, policy, timeout)).argv
    const overrides = Object.entries(config)
    const child = services.subprocess.spawn({
      argv, cwd, signal: timeout, graceMs: 500,
      env: { ...GIT_ENV, GIT_CONFIG_COUNT: String(overrides.length),
        ...Object.fromEntries(overrides.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])) },
      stdio: { stdin: 'ignore', stdout: { maxBytes: limits.maxOutputBytes }, stderr: { maxBytes: 64 * 1024 } }
    })
    try {
      const outcome = await child.done
      timeout.throwIfAborted()
      const stdout = child.collected.stdout.readFrom(0)
      const stderr = child.collected.stderr.readFrom(0).text
      if (outcome.exitCode === null || !allowed.includes(outcome.exitCode)) {
        throw new Error(`git ${name} failed (${outcome.signal ?? outcome.exitCode}): ${stderr.trim().split('\n')[0] ?? ''}`)
      }
      if (stdout.lossy) throw new Error(`git ${name} output too large`)
      return { stdout: stdout.text, stderr, exitCode: outcome.exitCode }
    } finally {
      child.terminate()
      await child.waitForExit()
    }
  }
}

/**
 * The checkout's canonical root, or null outside a checkout. `strict`: any other failure of git throws instead.
 * @param {any} git @param {{ strict?: boolean }} [options]
 * @returns {Promise<string | null>}
 */
export async function repoRoot(git, { strict = false } = {}) {
  const top = await git(['rev-parse', '--show-toplevel'], [0, 128])
  if (top.exitCode === 0) return realpath(top.stdout.trim())
  if (strict && !NOT_A_CHECKOUT.test(top.stderr)) throw new Error('git rev-parse failed: ' + top.stderr.trim().split('\n')[0])
  return null
}

/** One line of output when git exited 0, else null. @param {{ exitCode: number, stdout: string }} result */
const lineOf = result => result.exitCode === 0 ? result.stdout.trim() : null

/**
 * The checkout's root and the facts a caller asks for, each read only when asked (so every caller runs just the git
 * commands it needs, in parallel); null outside a checkout. `origin` gives the remote's address and its parsed form;
 * `root`, when the caller has read it already, is not read again.
 * @param {any} git
 * @param {{ root?: string, strict?: boolean, branch?: boolean, head?: boolean, upstream?: boolean, origin?: boolean, filters?: boolean, dirs?: boolean }} fields
 * @returns {Promise<{ root: string, branch: string | null, head: string | null, upstream: string | null, origin: string | null,
 *   remote: ReturnType<typeof parseRemote>, filters: Record<string, string>, gitDir: string, commonDir: string } | null>}
 */
export async function repoContext(git, fields) {
  const root = fields.root ?? await repoRoot(git, { strict: fields.strict })
  if (root === null) return null
  const skip = Promise.resolve(undefined)
  const dir = flag => git(['rev-parse', '--path-format=absolute', flag]).then(result => realpath(result.stdout.trim()))
  const [gitDir, commonDir, branch, head, upstream, filters, origin] = await Promise.all([
    fields.dirs ? dir('--git-dir') : skip,
    fields.dirs ? dir('--git-common-dir') : skip,
    fields.branch ? git(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1, 128]).then(lineOf) : skip,
    fields.head ? git(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1, 128]).then(lineOf) : skip,
    fields.upstream ? git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], [0, 128]).then(lineOf) : skip,
    fields.filters ? readFilters(git) : skip,
    fields.origin ? git(['remote', 'get-url', 'origin'], [0, 2, 128]).then(lineOf) : skip
  ])
  return /** @type {any} */ ({ root, gitDir, commonDir, branch, head, upstream, filters, origin, remote: origin ? parseRemote(origin) : null })
}

/**
 * Commits to push and to pull against `upstream`, as recorded locally (nothing is fetched); null when git cannot count
 * them (the upstream ref is gone, say). @param {any} git @param {string} upstream
 * @returns {Promise<{ ahead: number, behind: number } | null>}
 */
export async function aheadBehind(git, upstream) {
  const counts = await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], [0, 128])
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
  return counts.exitCode === 0 && Number.isInteger(ahead) && Number.isInteger(behind) ? { ahead, behind } : null
}

/**
 * The 研发工作台's repository facts for `directory`, or `{ repository: null }` outside a checkout.
 * @param {(args: string[], allowed?: number[], config?: Record<string, string>) => Promise<{ stdout: string, stderr: string, exitCode: number }>} git
 * @param {string} directory
 */
export async function readRepository(git, directory) {
  const context = await repoContext(git, { strict: true, dirs: true, branch: true, head: true, upstream: true, filters: true, origin: true })
  if (!context) return { repository: null }
  const { root, gitDir, commonDir, branch, head: headId, upstream, filters, remote: origin } = context
  const untrackedList = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean)
  const counted = untrackedList.slice(0, limits.maxUntracked)
  // One byte budget across the files, read one by one, so a folder of large new files cannot make every refresh (focus,
  // turn end) read hundreds of megabytes. A file left uncounted marks the total as partial.
  let untrackedAdded = 0, partial = untrackedList.length > counted.length, left = limits.maxUntrackedTotalBytes
  for (const path of counted) {
    if (!insideCheckout(root, path)) continue
    const buffer = await readUntracked(resolve(root, path), Math.min(limits.maxUntrackedBytes, left), () => { partial = true })
    if (!buffer) continue
    left -= buffer.length
    untrackedAdded += textLines(buffer)
  }
  const withUntracked = diff => {
    const paths = new Set(diff.paths)
    for (const path of untrackedList) paths.add(path)
    return { files: paths.size, added: diff.added + untrackedAdded, deleted: diff.deleted }
  }
  const commit = headId ? headId.slice(0, 7) : null
  const head = headId ? 'HEAD' : EMPTY_TREE
  const uncommitted = withUntracked(parseNumstat((await git(['diff', ...DIFF_FLAGS, head], [0], filters)).stdout))
  // The branch's base (see branchBase), compared from their merge base. When HEAD is that merge base the branch has no
  // commits of its own and the comparison would only repeat 未提交, so the card says so instead.
  const base = await branchBase(git, branch, upstream)
  const fork = base && headId ? await forkPoint(git, base) : null
  const branchCompare = !fork ? null : fork === headId ? { base, noCommits: true }
    : { base, ...withUntracked(parseNumstat((await git(['diff', ...DIFF_FLAGS, fork], [0], filters)).stdout)) }
  // Against the upstream: commits to push and to pull, as recorded locally (nothing is fetched).
  let sync = null
  if (branch && headId) {
    if (!upstream) sync = { upstream: null }
    else {
      const counts = await aheadBehind(git, upstream)
      if (counts) sync = { upstream, ...counts }
    }
  }
  return {
    repository: {
      name: basename(root), root, branch, commit, head: headId, sync, worktree: gitDir !== commonDir, remote: origin,
      uncommitted, branchCompare, ...(partial ? { untrackedTruncated: true } : {})
    }
  }
}

/**
 * The branch's comparison base, as recorded locally: the remote's default branch (origin/HEAD, which a clone sets; else
 * origin/main or origin/master), else an upstream that tracks a different branch. An upstream of the same branch is no
 * base: comparing with it shows only what has not been pushed, not the branch.
 * @param {any} git @param {string | null} branch @param {string | null} upstream
 * @returns {Promise<string | null>}
 */
export async function branchBase(git, branch, upstream) {
  const originHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], [0, 1, 128])
  if (originHead.exitCode === 0 && originHead.stdout.trim()) return originHead.stdout.trim()
  for (const name of ['main', 'master']) {
    const ref = await git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + name], [0, 1, 128])
    if (ref.exitCode === 0) return 'origin/' + name
  }
  if (upstream && (!branch || upstream.slice(upstream.indexOf('/') + 1) !== branch)) return upstream
  return null
}

/** The merge base of HEAD and `base`, or null. @param {any} git @param {string} base */
async function forkPoint(git, base) {
  const fork = await git(['merge-base', 'HEAD', base], [0, 1, 128])
  return fork.exitCode === 0 ? fork.stdout.trim() : null
}

/** Untracked files whose contents are read for the diff view; the rest are listed by name. */
const MAX_UNTRACKED_CONTENT = 200

/**
 * An untracked file as an added file: its lines, or binary / too large.
 * @param {string} root @param {string} path @param {boolean} read @param {{ left: number }} budget
 */
async function untrackedFile(root, path, read, budget) {
  const file = { path, status: 'added', untracked: true, binary: false, added: 0, deleted: 0, truncated: 0, hunks: /** @type {any[]} */ ([]) }
  if (!read || !insideCheckout(root, path)) return { ...file, omitted: true }
  const buffer = await readUntracked(resolve(root, path), Math.min(limits.maxUntrackedBytes, budget.left))
  if (!buffer) return { ...file, omitted: true }
  budget.left -= buffer.length
  if (buffer.subarray(0, 8000).includes(0)) return { ...file, binary: true }
  const lines = buffer.toString('utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const shown = lines.slice(0, MAX_FILE_LINES)
  return { ...file, added: lines.length, truncated: lines.length - shown.length,
    hunks: shown.length ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: shown.map((text, index) => ({ kind: '+', text, new: index + 1 })) }] : [] }
}

/**
 * The files changed in one scope: `uncommitted` (working tree and untracked files against HEAD) or `branch` (the same
 * against the fork point with the remote's default branch, else the upstream).
 * @param {any} git
 * @param {'uncommitted' | 'branch'} scope
 */
export async function readDiff(git, scope) {
  const context = await repoContext(git, { head: true, branch: true, upstream: true, filters: true })
  if (!context) return { scope, repository: false, files: [] }
  const { root, head: commit, branch, upstream, filters } = context
  let from = commit ? 'HEAD' : EMPTY_TREE
  let base = null
  if (scope === 'branch') {
    base = await branchBase(git, branch, upstream)
    const fork = base && commit ? await forkPoint(git, base) : null
    if (!fork) return { scope, repository: true, base, files: [], noBase: true }
    from = fork
  }
  let patch, untracked
  try {
    patch = (await git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--ignore-submodules=dirty',
      '--src-prefix=a/', '--dst-prefix=b/', from], [0], filters)).stdout
    untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean)
  } catch (/** @type {any} */ error) {
    if (/too large/.test(String(error?.message))) return { scope, repository: true, base, files: [], tooLarge: true }
    throw error
  }
  // Untracked contents share one byte budget, so a folder of new files cannot swell the reply past the patch limit.
  const budget = { left: limits.maxOutputBytes }
  const extra = []
  for (const [index, path] of untracked.entries()) extra.push(await untrackedFile(root, path, index < MAX_UNTRACKED_CONTENT, budget))
  const files = [...parsePatch(patch), ...extra].sort((a, b) => a.path.localeCompare(b.path))
  return { scope, repository: true, base, root, files, readAt: Date.now() }
}

/**
 * The origin remote as host and path, with a web address for GitHub. Credentials in the URL are dropped.
 * @param {string} url
 * @returns {{ host: string, path: string, web: string | null } | null}
 */
export function parseRemote(url) {
  let host, path
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/.exec(url)
  if (/^[a-z][\w+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      host = parsed.hostname; path = parsed.pathname.replace(/^\/+/, '')
    } catch { return null }
  } else if (scp) { host = scp[1]; path = scp[2].split(/[?#]/, 1)[0] } else return null
  path = path.replace(/\.git$/, '').replace(/\/+$/, '')
  if (!host || !path) return null
  const github = host.toLowerCase() === 'github.com' && /^[\w.-]+\/[\w.-]+$/.test(path)
  return { host, path, web: github ? `https://github.com/${path}` : null }
}
