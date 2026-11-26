import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFilters } from './git.js'

// Git worktrees for the 研发工作台: list a repository's checkouts, create one under <repository>/.agents/worktrees/<name>
// for a new Session (as DSH's own worktree service places them), and remove one Fig created once it is clean and no
// open Session uses it. Creation and removal are the plugin Host's own git writes (user decision, discussion round 26):
// they run under the Session's sandbox, with hooks and the repository's filters off, never --force, never copying
// uncommitted files, and never deleting a branch that is not merged.

/** Worktrees a repository lists at most. */
const WORKTREE_LIMIT = 30

/**
 * `git worktree list --porcelain -z` as entries; the first is the main checkout.
 * @param {string} text
 */
export function parseWorktrees(text) {
  const entries = []
  /** @type {any} */
  let entry
  for (const field of text.split('\0')) {
    if (!field) { if (entry) entries.push(entry); entry = undefined; continue }
    const space = field.indexOf(' ')
    const key = space < 0 ? field : field.slice(0, space), value = space < 0 ? '' : field.slice(space + 1)
    if (key === 'worktree') entry = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }
    else if (!entry) continue
    else if (key === 'HEAD') entry.head = value
    else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') entry.detached = true
    else if (key === 'bare') entry.bare = true
    else if (key === 'locked') entry.locked = true
    else if (key === 'prunable') entry.prunable = true
  }
  if (entry) entries.push(entry)
  return entries.slice(0, WORKTREE_LIMIT)
}

/** The pool for a checkout's new worktrees. @param {string} root */
const poolOf = root => join(root, '.agents', 'worktrees')

/** A directory name for a branch: path-safe, short. @param {string} branch */
export const worktreeName = branch => branch.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'worktree'

/**
 * Makes the pool directory and its ignore file. The pool is the Host's own write into the Session's checkout, so it
 * refuses a symlinked `.agents` or pool (which could point outside) rather than follow one.
 * @param {string} root - canonical checkout root
 */
export async function preparePool(root) {
  const pool = poolOf(root)
  for (const path of [join(root, '.agents'), pool]) {
    const info = await lstat(path).catch(() => undefined)
    if (info && !info.isDirectory()) throw Object.assign(new Error('pool is not a plain directory'), { refused: 'pool' })
    if (!info) await mkdir(path)
  }
  if (await realpath(pool) !== pool) throw Object.assign(new Error('pool is not a plain directory'), { refused: 'pool' })
  await writeFile(join(pool, '.gitignore'), '*\n', { flag: 'wx' }).catch(error => { if (error?.code !== 'EEXIST') throw error })
  return pool
}

/**
 * Adds a worktree at `path`: a new branch from `from`, an existing local branch, or a new branch tracking `track`.
 * @param {any} git - runner for the source checkout
 * @param {{ path: string, branch: string, from?: string, existing?: boolean, track?: string }} spec
 */
export async function addWorktree(git, { path, branch, from, existing, track }) {
  // Every filter driver off, so the checkout never runs a program the repository configures (LFS smudge, decryption…).
  const filters = await readFilters(git, { smudge: true })
  const args = existing ? ['worktree', 'add', '--', path, branch]
    : track ? ['worktree', 'add', '--track', '-b', branch, '--', path, track]
      : ['worktree', 'add', '--no-track', '-b', branch, '--', path, /** @type {string} */ (from)]
  await git(args, [0], filters)
}

/** Where Fig records the worktrees it created. @param {string} home - DSH home */
export const registryPath = home => join(home, 'fig', 'development-workbench', 'worktrees.json')

/**
 * The worktrees Fig created: { path, branch, root, sessionId, createdAt }. Unreadable → empty.
 * @param {string} file
 * @returns {Promise<{ path: string, branch: string, root: string, sessionId: string, createdAt: number }[]>}
 */
export async function readRegistry(file) {
  const value = await readFile(file, 'utf8').then(JSON.parse, () => undefined)
  return Array.isArray(value?.worktrees) ? value.worktrees.filter(entry => typeof entry?.path === 'string' && typeof entry?.sessionId === 'string') : []
}

/** Writes the record atomically; at most 200 entries, newest kept. @param {string} file @param {any[]} worktrees */
async function writeRegistry(file, worktrees) {
  await mkdir(dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  await writeFile(temp, JSON.stringify({ schema: 1, worktrees: worktrees.slice(-200) }, null, 2) + '\n')
  await rename(temp, file)
}

/**
 * Whether one listed worktree may be removed from the card, and why not.
 * @param {{ path: string, branch: string | null, locked?: boolean }} worktree
 * @param {{ record?: { sessionId: string }, dirty: boolean, current: boolean, ownerOpen: boolean, main: boolean }} facts
 * @returns {{ ok: true } | { ok: false, reason: 'main' | 'foreign' | 'current' | 'open' | 'dirty' | 'locked' }}
 */
export function removable(worktree, { record, dirty, current, ownerOpen, main }) {
  if (main) return { ok: false, reason: 'main' }
  if (!record) return { ok: false, reason: 'foreign' }
  if (current) return { ok: false, reason: 'current' }
  if (ownerOpen) return { ok: false, reason: 'open' }
  if (worktree.locked) return { ok: false, reason: 'locked' }
  if (dirty) return { ok: false, reason: 'dirty' }
  return { ok: true }
}

let registryQueue = Promise.resolve()
/**
 * Read-modify-write of the record, one at a time in this process, so two Sessions changing worktrees together keep
 * both changes. @param {string} file @param {(worktrees: Awaited<ReturnType<typeof readRegistry>>) => any[]} change
 */
export function updateRegistry(file, change) {
  const next = registryQueue.then(async () => writeRegistry(file, change(await readRegistry(file))))
  registryQueue = next.catch(() => undefined)
  return next
}
