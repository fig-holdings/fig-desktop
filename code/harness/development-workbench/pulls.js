import { access, constants } from 'node:fs/promises'
import { normalizeCheck, ciSummary, failedCheck, activeCheck } from './ci.js'

// 关联 PR: the user's open pull requests in the repository, read with the GitHub CLI already signed in on this Mac.
// `gh` runs as a host process, as DSH's forge GitHub provider runs it: it reads the code host, not the workspace, so the
// Session's file sandbox does not apply. It only lists; nothing is written to GitHub or the repository.

const FIELDS = 'number,title,url,headRefName,baseRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,isDraft,reviewDecision,mergeable,statusCheckRollup'
const PR_LIMIT = 30

/**
 * One pull request's state for the card: needs attention (failed checks, conflicts or requested changes), checks in
 * progress, checks passed, no checks, or draft.
 * @param {any} pull
 * @returns {'attention' | 'pending' | 'passed' | 'none' | 'draft'}
 */
export function pullState(pull) {
  const checks = Array.isArray(pull?.statusCheckRollup) ? pull.statusCheckRollup.map(normalizeCheck) : []
  if (checks.some(failedCheck) || pull?.mergeable === 'CONFLICTING' || pull?.reviewDecision === 'CHANGES_REQUESTED') return 'attention'
  if (pull?.isDraft) return 'draft'
  if (checks.some(activeCheck)) return 'pending'
  return checks.length && checks.every(c => c.state === 'passed') ? 'passed' : 'none'
}

const rank = { attention: 0, pending: 1, passed: 2, none: 3, draft: 4, merged: 5, closed: 6 }
/** Card order: the current branch's first, then by state, then newest first. @param {any[]} rows */
export const sortPulls = rows => rows.sort((a, b) => Number(b.current) - Number(a.current) || rank[a.state] - rank[b.state] || b.number - a.number)

/** "owner/name" of a pull request address, lower-cased for comparison. @param {string} url */
const repoOf = url => (/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(url)?.[1] ?? '').toLowerCase()

/**
 * `gh pr list --json` / `gh pr view --json` output as card rows: the current branch's first, then by state, then
 * newest first. `current`: the Session's branch in the Session's repository (`repo`, owner/name; any when omitted).
 * @param {string} json
 * @param {string | null} branch
 * @param {string} [repo]
 */
export function shapePulls(json, branch, repo) {
  const list = JSON.parse(json)
  if (!Array.isArray(list)) return []
  return sortPulls(list.map(pull => {
    const baseRepository = repoOf(String(pull.url ?? ''))
    const headRepository = pull.headRepository?.nameWithOwner?.toLowerCase?.() ??
      (pull.headRepositoryOwner?.login && pull.headRepository?.name ? `${pull.headRepositoryOwner.login}/${pull.headRepository.name}`.toLowerCase()
        : pull.isCrossRepository === true ? undefined : baseRepository)
    return {
    number: Number(pull.number), title: String(pull.title ?? ''), url: String(pull.url ?? ''), branch: String(pull.headRefName ?? ''),
    base: String(pull.baseRefName ?? ''), head: String(pull.headRefOid ?? ''), repo: repoOf(String(pull.url ?? '')),
    open: pull.state === undefined || pull.state === 'OPEN', closed: pull.state === 'MERGED' ? 'merged' : pull.state === 'CLOSED' ? 'closed' : null,
    draft: Boolean(pull.isDraft), mergeable: String(pull.mergeable ?? ''), reviewDecision: String(pull.reviewDecision ?? ''),
    state: pull.state === 'MERGED' ? 'merged' : pull.state === 'CLOSED' ? 'closed' : pullState(pull),
    headRepository, current: Boolean(branch) && pull.headRefName === branch && (!repo ? pull.isCrossRepository !== true : headRepository === repo.toLowerCase()),
    checks: (Array.isArray(pull.statusCheckRollup) ? pull.statusCheckRollup : []).map(normalizeCheck).sort((a, b) => Number(failedCheck(b)) - Number(failedCheck(a))),
    ci: ciSummary((Array.isArray(pull.statusCheckRollup) ? pull.statusCheckRollup : []).map(normalizeCheck)),
    // gh pr list exposes a rollup, not its connection pageInfo. Never promise all checks were loaded.
    checksComplete: false
    }
  }))
}

/**
 * `rows` with the re-read pull requests in place of theirs (by address); one that `gone` names leaves the list.
 * @param {any[]} rows @param {any[]} fresh @param {string[]} gone
 */
export function mergePulls(rows, fresh, gone = []) {
  const byUrl = new Map(fresh.map(pull => [pull.url, pull]))
  return sortPulls(rows.filter(pull => !gone.includes(pull.url)).map(pull => byUrl.get(pull.url) ?? pull))
}

/** What gh's error says about the repository or sign-in, for the card. @param {string} stderr */
export function ghProblem(stderr) {
  if (/auth login|not logged|authentication/i.test(stderr)) return 'signed-out'
  if (/no git remotes|none of the git remotes|not a git repository|could not determine/i.test(stderr)) return 'not-github'
  return 'failed'
}

/** Where Homebrew and the gh installer put gh; a Finder-launched app's PATH usually lacks them. */
const GH_LOCATIONS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

/** gh on PATH, else at a usual install location. @param {{ subprocess: any }} services @param {AbortSignal} signal */
export async function findGh(services, signal, locations = GH_LOCATIONS) {
  try { return await services.subprocess.resolveExecutable('gh', undefined, signal) } catch { /* not on PATH */ }
  for (const path of locations) if (await access(path, constants.X_OK).then(() => true, () => false)) return path
  return undefined
}

/**
 * Runs `run` with gh's path and a signal that also ends after `ms`, or returns `{ problem: 'no-gh' }` when gh is not
 * installed. @param {{ subprocess: any }} services @param {AbortSignal} signal @param {number} ms
 * @param {(executable: string, timeout: AbortSignal) => Promise<any>} run
 * @returns {Promise<any>}
 */
export async function withGh(services, signal, ms, run) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(ms)])
  const executable = await findGh(services, timeout)
  if (!executable) return { problem: 'no-gh' }
  return run(executable, timeout)
}

/**
 * Runs gh in `root` and returns its output (`json`, any text), or `{ problem }`. argv only: nothing passes a shell.
 * @param {{ subprocess: any }} services @param {string} executable @param {string} root @param {string[]} args @param {AbortSignal} signal
 * @param {number} [maxBytes]
 */
export async function runGh(services, executable, root, args, signal, maxBytes = 2 * 1024 * 1024) {
  const child = services.subprocess.spawn({
    argv: [executable, ...args], cwd: root, signal, graceMs: 500,
    env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '', PAGER: '' },
    stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 64 * 1024 } }
  })
  try {
    const outcome = await child.done
    const stdout = child.collected.stdout.readFrom(0)
    const stderr = child.collected.stderr.readFrom(0).text
    if (outcome.exitCode !== 0) return { problem: ghProblem(stderr), message: stderr.trim().split('\n')[0]?.slice(0, 200) }
    if (stdout.lossy) return { problem: 'failed', lossy: true }
    return { json: stdout.text }
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}

/** Pull requests re-read one by one while their checks run; at most this many per poll. */
export const CHECK_POLL_LIMIT = 5

/**
 * These pull requests, each re-read with `gh pr view <address>` (any repository), merged or closed ones included.
 * Used for this Session's pull requests and, while checks run, so a 15-second poll costs one small query per active
 * pull request instead of the whole list. `missing`: addresses gh could not read (deleted, no access).
 * @param {{ subprocess: any }} services @param {string} cwd @param {string | null} branch @param {string | undefined} repo
 * @param {string[]} urls @param {AbortSignal} signal
 */
export async function readPullsByUrl(services, cwd, branch, repo, urls, signal) {
  return withGh(services, signal, 30_000, async (executable, timeout) => {
    const fresh = [], missing = []
    for (const url of urls) {
      const result = await runGh(services, executable, cwd, ['pr', 'view', url, '--json', FIELDS + ',state'], timeout)
      if (result.problem === 'signed-out') return result
      if (result.problem) { missing.push(url); continue }
      fresh.push(...shapePulls(`[${result.json}]`, branch, repo))
    }
    return { fresh, missing }
  })
}

/**
 * The user's open pull requests in the checkout at `root`.
 * @param {{ subprocess: any }} services
 * @param {string} root
 * @param {string | null} branch
 * @param {AbortSignal} signal
 */
export async function readPulls(services, root, branch, signal, repo) {
  return withGh(services, signal, 20_000, async (executable, timeout) => {
    const result = await runGh(services, executable, root, ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', String(PR_LIMIT), '--json', FIELDS], timeout)
    return result.problem ? result : { pulls: shapePulls(result.json, branch, repo) }
  })
}

/**
 * The merge methods a repository allows, as gh's flags (squash, merge, rebase).
 * @param {{ subprocess: any }} services @param {string} cwd @param {string} repo - owner/name @param {AbortSignal} signal
 */
export async function readMergeMethods(services, cwd, repo, signal) {
  return withGh(services, signal, 20_000, async (executable, timeout) => {
    const result = await runGh(services, executable, cwd, ['repo', 'view', repo, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'], timeout)
    if (result.problem) return result
    const allowed = JSON.parse(result.json)
    return { methods: [allowed.squashMergeAllowed && 'squash', allowed.mergeCommitAllowed && 'merge', allowed.rebaseMergeAllowed && 'rebase'].filter(Boolean) }
  })
}
