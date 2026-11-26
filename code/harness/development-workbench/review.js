import { runGh, withGh } from './pulls.js'
import { parsePatch } from './patch.js'
import { parsePullUrl } from './actions.js'
import { isSha } from './actions.js'

// GitHub reviews for the 研发工作台, through the gh CLI signed in on this Mac: who approved, asked for changes or is
// still asked; the unresolved review threads; pull requests waiting for the user's review; one pull request's diff;
// and submitting the user's own review. Submitting is the one write the plugin's Host makes to GitHub itself (user
// decision, discussion round 26): the text is the user's own, shown in full before it is sent, and pinned to the head
// commit the user read.

const REVIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    latestReviews(first: 30) { nodes { state author { login } } }
    reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } } }
    reviewThreads(first: 100) { totalCount nodes { id isResolved isOutdated path line originalLine diffSide
      comments(first: 20) { totalCount nodes { author { login } body url } } } }
  } } }`

/** A thread's first comment is cut to this many characters for the card and the instruction. */
const THREAD_TEXT_LIMIT = 2000

/**
 * The review state of one pull request from the GraphQL reply: who approved, asked for changes or is asked; the
 * unresolved threads (first comment, reply count); how many are resolved.
 * @param {any} reply
 */
export function shapeReviews(reply) {
  const pull = reply?.data?.repository?.pullRequest
  if (!pull) return undefined
  const reviews = pull.latestReviews?.nodes ?? []
  const by = state => reviews.filter(review => review?.state === state).map(review => String(review.author?.login ?? '?'))
  const threads = pull.reviewThreads?.nodes ?? []
  return {
    approved: by('APPROVED'), changes: by('CHANGES_REQUESTED'),
    pending: (pull.reviewRequests?.nodes ?? []).map(node => String(node?.requestedReviewer?.login ?? node?.requestedReviewer?.name ?? '?')),
    resolved: threads.filter(thread => thread?.isResolved).length,
    more: (pull.reviewThreads?.totalCount ?? threads.length) > threads.length,
    threads: threads.filter(thread => thread && !thread.isResolved).map(thread => {
      const first = thread.comments?.nodes?.[0] ?? {}
      return { id: String(thread.id), path: String(thread.path ?? ''), line: thread.line ?? thread.originalLine ?? null, outdated: Boolean(thread.isOutdated),
        author: String(first.author?.login ?? '?'), body: String(first.body ?? '').slice(0, THREAD_TEXT_LIMIT), url: String(first.url ?? ''),
        replies: Math.max(0, (thread.comments?.totalCount ?? 1) - 1) }
    })
  }
}

/**
 * One pull request's review state, or `{ problem }`.
 * @param {{ subprocess: any }} services @param {string} cwd @param {string} url @param {AbortSignal} signal
 */
export async function readReviews(services, cwd, url, signal) {
  const pull = parsePullUrl(url)
  if (!pull) return { problem: 'failed' }
  return withGh(services, signal, 20_000, async (executable, timeout) => {
    const result = await runGh(services, executable, cwd, ['api', 'graphql', '-f', 'query=' + REVIEW_QUERY,
      '-f', 'owner=' + pull.owner, '-f', 'name=' + pull.repo, '-F', 'number=' + pull.number], timeout)
    if (result.problem) return result
    return shapeReviews(JSON.parse(result.json)) ?? { problem: 'failed' }
  })
}

/**
 * Open pull requests in this repository (`repo`, owner/name) that ask for the user's review, newest first. Other
 * repositories, even in the same organization, are left out: the card is about this Session's repository.
 * @param {{ subprocess: any }} services @param {string} cwd @param {AbortSignal} signal @param {string | undefined} repo
 */
export async function readReviewRequests(services, cwd, signal, repo) {
  if (!repo) return { requests: [] }
  return withGh(services, signal, 20_000, async (executable, timeout) => {
    const result = await runGh(services, executable, cwd, ['search', 'prs', '--repo', repo, '--review-requested=@me', '--state=open', '--limit', '30',
      '--json', 'number,title,url,repository,author,updatedAt,isDraft'], timeout)
    if (result.problem) return result
    const list = JSON.parse(result.json)
    return { requests: (Array.isArray(list) ? list : []).filter(pull => parsePullUrl(pull?.url) && String(pull.repository?.nameWithOwner ?? '').toLowerCase() === repo.toLowerCase()).map(pull => ({
      number: Number(pull.number), title: String(pull.title ?? ''), url: String(pull.url), repo: String(pull.repository?.nameWithOwner ?? ''),
      author: String(pull.author?.login ?? ''), draft: Boolean(pull.isDraft), updatedAt: String(pull.updatedAt ?? '')
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
  })
}

/** The largest pull request diff the review tab reads. */
const PULL_DIFF_BYTES = 4 * 1024 * 1024

/**
 * One pull request's diff as files and hunks, with the head commit it was read at (a review is pinned to it).
 * @param {{ subprocess: any }} services @param {string} cwd @param {string} url @param {AbortSignal} signal
 */
export async function readPullDiff(services, cwd, url, signal) {
  const pull = parsePullUrl(url)
  if (!pull) return { problem: 'failed' }
  return withGh(services, signal, 30_000, async (executable, timeout) => {
    const view = await runGh(services, executable, cwd, ['pr', 'view', url, '--json', 'baseRefOid,headRefOid,title,number,state,author'], timeout)
    if (view.problem) return view
    const meta = JSON.parse(view.json)
    if (!isSha(meta.baseRefOid) || !isSha(meta.headRefOid) || meta.number !== pull.number) return { problem: 'failed' }
    const diff = await runGh(services, executable, cwd, ['api', `repos/${pull.owner}/${pull.repo}/compare/${meta.baseRefOid}...${meta.headRefOid}`,
      '-H', 'Accept: application/vnd.github.diff'], timeout, PULL_DIFF_BYTES)
    if (diff.problem) return diff.lossy ? { tooLarge: true, head: String(meta.headRefOid ?? ''), title: String(meta.title ?? '') } : diff
    return { files: parsePatch(diff.json), head: String(meta.headRefOid ?? ''), title: String(meta.title ?? ''), number: Number(meta.number), author: String(meta.author?.login ?? ''),
      open: meta.state === 'OPEN' }
  })
}

/** The verdicts a review may carry. */
export const REVIEW_EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']
/** Line comments one review may carry. */
const REVIEW_COMMENT_LIMIT = 50

/**
 * A review's comments, checked: a path, a positive line on a side, an optional start line before it, and a body.
 * @param {unknown} comments
 * @returns {{ path: string, line: number, side: 'LEFT' | 'RIGHT', startLine?: number, body: string }[] | undefined}
 */
export function validComments(comments) {
  if (!Array.isArray(comments) || comments.length > REVIEW_COMMENT_LIMIT) return undefined
  const valid = []
  for (const comment of comments) {
    const { path, line, side, startLine, body } = comment ?? {}
    if (typeof path !== 'string' || !path || path.length > 1000 || path.includes('\0')) return undefined
    if (!Number.isSafeInteger(line) || line < 1 || (side !== 'LEFT' && side !== 'RIGHT')) return undefined
    if (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1 || startLine >= line)) return undefined
    if (typeof body !== 'string' || !body.trim() || body.length > 65_536) return undefined
    valid.push({ path, line, side, ...(startLine === undefined ? {} : { startLine }), body })
  }
  return valid
}

/**
 * gh's arguments for one review: `gh api -X POST repos/<o>/<r>/pulls/<n>/reviews` with the head commit, verdict,
 * body and line comments as typed fields (-f keeps text raw, so no value is read as a file or a number).
 * @param {{ url: string, head: string, event: string, body: string, comments: { path: string, line: number, side: string, startLine?: number, body: string }[] }} review
 */
export function reviewArgs({ url, head, event, body, comments }) {
  const pull = /** @type {{ owner: string, repo: string, number: number }} */ (parsePullUrl(url))
  const args = ['api', '-X', 'POST', `repos/${pull.owner}/${pull.repo}/pulls/${pull.number}/reviews`, '-f', 'commit_id=' + head, '-f', 'event=' + event]
  if (body.trim()) args.push('-f', 'body=' + body)
  for (const comment of comments) {
    args.push('-f', 'comments[][path]=' + comment.path, '-F', 'comments[][line]=' + comment.line, '-f', 'comments[][side]=' + comment.side)
    if (comment.startLine !== undefined) args.push('-F', 'comments[][start_line]=' + comment.startLine, '-f', 'comments[][start_side]=' + comment.side)
    args.push('-f', 'comments[][body]=' + comment.body)
  }
  return args
}

/**
 * Submits the user's review. GitHub refuses it when the pull request moved past `head`.
 * @param {{ subprocess: any }} services @param {string} cwd @param {Parameters<typeof reviewArgs>[0]} review @param {AbortSignal} signal
 */
export async function submitReview(services, cwd, review, signal) {
  return withGh(services, signal, 30_000, async (executable, timeout) => {
    const result = await runGh(services, executable, cwd, reviewArgs(review), timeout)
    if (result.problem) return result
    const reply = JSON.parse(result.json)
    return { submitted: true, url: String(reply?.html_url ?? '') }
  })
}
