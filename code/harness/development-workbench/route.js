import { pageRoute, RouteError } from '../shared/http.js'
import { CHECK_POLL_LIMIT } from './pulls.js'
import { FIX_KINDS, isSha, MERGE_METHODS, parsePullUrl } from './actions.js'
import { REVIEW_EVENTS, validComments } from './review.js'

// The 研发工作台's page endpoints: each checks its payload's shape, then hands it to the plugin's handlers (index.js),
// which decide everything else against the Session's own repository and pull requests.

export const prefix = '/fig-development-workbench'

const sessionOf = payload => {
  const session = typeof payload?.session === 'string' && /^[\w-]{1,200}$/.test(payload.session) ? payload.session : undefined
  if (!session) throw new RouteError(400, 'BAD_SESSION')
  return session
}

/** POST /fig-development-workbench/<endpoint> for the page plugin. */
export const route = pageRoute({
  prefix,
  endpoints: {
    'extension-state': (_payload, handlers) => handlers['extension-state'](),
    status: (payload, handlers) => handlers.status(sessionOf(payload)),
    diff(payload, handlers) {
      if (payload?.scope !== 'uncommitted' && payload?.scope !== 'branch') throw new RouteError(400, 'BAD_SCOPE')
      return handlers.diff(sessionOf(payload), payload.scope)
    },
    pulls(payload, handlers) {
      const checks = Array.isArray(payload?.checks) ? [...new Set(payload.checks.filter(url => parsePullUrl(url)))].slice(0, CHECK_POLL_LIMIT) : []
      return handlers.pulls(sessionOf(payload), payload?.force === true, checks)
    },
    outputs: (payload, handlers) => handlers.outputs(sessionOf(payload)),
    'run-action'(payload, handlers) {
      if (typeof payload?.token !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.token)) throw new RouteError(400, 'BAD_ACTION')
      return handlers.runAction(sessionOf(payload), payload.token)
    },
    'open-comparison'(payload, handlers) {
      if (typeof payload?.grant !== 'string' || !payload.grant || payload.grant.length > 4096) throw new RouteError(400, 'BAD_COMPARISON')
      return handlers.openComparison(sessionOf(payload), payload.grant)
    },
    comparison(payload, handlers) {
      if (typeof payload?.handle !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.handle)) throw new RouteError(400, 'BAD_COMPARISON')
      return handlers.comparison(sessionOf(payload), payload.handle)
    },
    reveal: (payload, handlers) => handlers.reveal(sessionOf(payload)),
    'commit-files': (payload, handlers) => handlers.commitFiles(sessionOf(payload)),
    push(payload, handlers) {
      if (typeof payload?.head !== 'string') throw new RouteError(400, 'BAD_PUSH')
      return handlers.push(sessionOf(payload), { head: payload.head, chinese: payload?.language !== 'en' })
    },
    fix(payload, handlers) {
      if (!parsePullUrl(payload?.url) || !FIX_KINDS.includes(payload?.kind)) throw new RouteError(400, 'BAD_FIX')
      const threads = payload?.threads === 'all' ? 'all' : Array.isArray(payload?.threads) ? payload.threads.filter(id => typeof id === 'string').slice(0, 50) : undefined
      return handlers.fix(sessionOf(payload), { url: payload.url, kind: payload.kind, head: typeof payload?.head === 'string' ? payload.head : undefined, threads, chinese: payload?.language !== 'en' })
    },
    'merge-options'(payload, handlers) {
      if (!parsePullUrl(payload?.url)) throw new RouteError(400, 'BAD_MERGE')
      return handlers.mergeOptions(sessionOf(payload), payload.url)
    },
    merge(payload, handlers) {
      if (!parsePullUrl(payload?.url) || !isSha(payload?.head) || !MERGE_METHODS.includes(payload?.method)) throw new RouteError(400, 'BAD_MERGE')
      return handlers.merge(sessionOf(payload), { url: payload.url, head: payload.head, method: payload.method, deleteBranch: payload?.deleteBranch === true, chinese: payload?.language !== 'en' })
    },
    autofix(payload, handlers) {
      if (!parsePullUrl(payload?.url)) throw new RouteError(400, 'BAD_AUTOFIX')
      return handlers.autofix(sessionOf(payload), { url: payload.url, on: payload?.on === true, chinese: payload?.language !== 'en' })
    },
    worktrees: (payload, handlers) => handlers.worktrees(sessionOf(payload)),
    'create-worktree'(payload, handlers) {
      if (typeof payload?.branch !== 'string' || (payload?.from !== 'head' && payload?.from !== 'base')) throw new RouteError(400, 'BAD_WORKTREE')
      const message = typeof payload?.message === 'string' ? payload.message.slice(0, 20_000) : ''
      return handlers.createWorktree(sessionOf(payload), { branch: payload.branch, from: payload.from, message })
    },
    'pull-worktree'(payload, handlers) {
      if (!parsePullUrl(payload?.url)) throw new RouteError(400, 'BAD_WORKTREE')
      return handlers.pullWorktree(sessionOf(payload), { url: payload.url, fix: payload?.fix === true, chinese: payload?.language !== 'en' })
    },
    'fetch-branch'(payload, handlers) {
      if (!parsePullUrl(payload?.url)) throw new RouteError(400, 'BAD_FETCH')
      return handlers.fetchBranch(sessionOf(payload), { url: payload.url, chinese: payload?.language !== 'en' })
    },
    'remove-worktree'(payload, handlers) {
      if (typeof payload?.path !== 'string') throw new RouteError(400, 'BAD_WORKTREE')
      return handlers.removeWorktree(sessionOf(payload), { path: payload.path, deleteBranch: payload?.deleteBranch === true })
    },
    'pull-diff'(payload, handlers) {
      if (!parsePullUrl(payload?.url)) throw new RouteError(400, 'BAD_REVIEW')
      return handlers.pullDiff(sessionOf(payload), payload.url)
    },
    'submit-review'(payload, handlers) {
      const comments = validComments(payload?.comments)
      if (!parsePullUrl(payload?.url) || !isSha(payload?.head) || !REVIEW_EVENTS.includes(payload?.event)
        || !comments || typeof payload?.body !== 'string' || payload.body.length > 65_536) throw new RouteError(400, 'BAD_REVIEW')
      if (payload.event !== 'APPROVE' && !payload.body.trim() && !comments.length) throw new RouteError(400, 'EMPTY_REVIEW')
      return handlers.submitReview(sessionOf(payload), { url: payload.url, head: payload.head, event: payload.event, body: payload.body, comments })
    },
    'agent-review'(payload, handlers) {
      if (!parsePullUrl(payload?.url)) throw new RouteError(400, 'BAD_REVIEW')
      return handlers.agentReview(sessionOf(payload), { url: payload.url, chinese: payload?.language !== 'en' })
    },
    'create-pull'(payload, handlers) {
      if (typeof payload?.head !== 'string' || typeof payload?.base !== 'string') throw new RouteError(400, 'BAD_PULL')
      return handlers.createPull(sessionOf(payload), { head: payload.head, base: payload.base, draft: payload?.draft === true, chinese: payload?.language !== 'en' })
    },
    commit(payload, handlers) {
      const files = Array.isArray(payload?.files) ? payload.files.filter(path => typeof path === 'string') : []
      if (files.length === 0 || files.length > 500 || typeof payload?.token !== 'string') throw new RouteError(400, 'BAD_COMMIT')
      return handlers.commit(sessionOf(payload), { files: [...new Set(files)], token: payload.token, chinese: payload?.language !== 'en' })
    }
  },
  failure: error => ({ code: 'WORKBENCH', message: String(error?.message ?? error).slice(0, 300) })
})
