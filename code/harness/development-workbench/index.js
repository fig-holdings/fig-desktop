import { lstat, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, sep } from 'node:path'
import { registerPageRoute } from '../shared/http.js'
import { aheadBehind, branchBase, readDiff, readRepository, repoContext, repoRoot } from './git.js'
import { commitInstruction, fingerprint, insideCheckout, parseStatus } from './commit.js'
import { mergePulls, readPullsByUrl, sortPulls } from './pulls.js'
import { readOutputs, SESSION_PULL_LIMIT } from './outputs.js'
import { fetchInstruction, fixInstruction, fixKinds, mergeInstruction, mergeReady, pullRequestInstruction, pushInstruction,
  reviewByAgentInstruction, safeBranch } from './actions.js'
import { addWorktree, parseWorktrees, preparePool, readRegistry, registryPath, removable, updateRegistry, worktreeName } from './worktree.js'
import { dshHome } from '../shared/dsh-plugin.js'
import { autofixWatches } from './autofix.js'
import { homePath, openSessionIn, send as sendTo, withSession as inSession } from './session.js'
import { prefix, route } from './route.js'
import { githubFor } from './github.js'
import { failedCheck } from './ci.js'
import { extensionCall, targetRepo, unavailable, workbenchExtension } from './extension.js'
import { extensionInstruction, workbenchCoAuthor } from './extension-instructions.js'

export { homePath, route }

// The 研发工作台's Host half: per Session, repository facts, the changed files of one scope, and the user's pull
// requests, plus the few writes the card makes itself (worktree add/remove, deleting a merged worktree's branch, and
// a review the user confirmed); everything else is an instruction to the Session's Agent. git runs under the
// Session's working directory and sandbox policy; gh runs on the host.

export const name = 'fig-development-workbench'
/** A pull request list is reused this long unless the user presses 刷新; focus and turn ends do not hit GitHub each time. */
const PULLS_FRESH_MS = 60_000
/** While checks run the page asks for those pull requests only; the whole list is re-read at least this often. */
const PULLS_FULL_MS = 120_000

export function apply(ctx, config) {
  /** key → the request in flight, so repeated refreshes share one run. */
  const running = new Map()
  const once = (key, start) => {
    const existing = running.get(key)
    if (existing) return existing
    const started = start().finally(() => { if (running.get(key) === started) running.delete(key) })
    running.set(key, started)
    return started
  }
  /** key → which action holds it. One action per Session at a time: a different one is refused, the same one shares the run. */
  const holders = new Map()
  const exclusive = (key, action, start) => {
    if (running.has(key) && holders.get(key) !== action) return Promise.resolve({ refused: 'running' })
    holders.set(key, action)
    return once(key, start)
  }
  /** Session id → { at, value }: its pull request lists and when they were last read in full. */
  const pullCache = new Map()
  const confirmations = new Map(), comparisons = new Map(), reviewResults = new Map()
  const extension = workbenchExtension(ctx, config, () => { pullCache.clear(); confirmations.clear(); comparisons.clear(); autofix.dispose() })
  /** @param {string} sessionId @param {(tools: { git: any, services: any, directory: string, agent: any }) => Promise<any>} read */
  const withSession = (sessionId, read) => inSession(ctx, sessionId, read)
  const send = (sessionId, text, /** @type {(() => boolean | Promise<boolean>) | undefined} */ allowed = undefined) => sendTo(ctx, sessionId, text, allowed)
  const binding = (sessionId, services, snapshot = extension.snapshot()) => githubFor(snapshot, sessionId, services)
  const freshPull = (sessionId, git, services, url, snapshot = extension.snapshot()) => pullContext(git, services, url, binding(sessionId, services, snapshot))
  const autofix = autofixWatches({ ctx, running, withSession, pullContext: (git, services, url, sessionId) => freshPull(sessionId, git, services, url), send,
    externalInstruction: (agent, pull, kind, chinese) => extensionPrompt(extension.snapshot(), agent, 'fix', { url: pull.url, head: pull.head, kind }, chinese) })
  ctx.effect(() => extension.dispose)
  ctx.provide('figDevelopment', extension.service)

  // Do not build instructions for a name supplied by the page. Match the exact admitted definition of a signed extension tool.
  async function extensionPrompt(snapshot, agent, action, target, chinese, data) {
    const definition = snapshot.extension?.tools?.[action]
    const tools = ctx.get('tools')
    if (!definition || !/^[a-zA-Z][\w-]{0,79}$/.test(definition.name ?? '') || !tools || !agent || snapshot.signal.aborted) return undefined
    const signal = AbortSignal.any([snapshot.signal, AbortSignal.timeout(5000)])
    const admitted = await tools.resolve({ agent, signal, modelSelection: agent.model.current() }).catch(() => undefined)
    if (!admitted) return undefined
    try {
      if (signal.aborted || admitted.view(agent).get(definition.name) !== definition) return undefined
      return extensionInstruction({ action, tool: definition.name, target, chinese, data })
    } finally { admitted.dispose() }
  }

  function remember(map, value) {
    while (map.size >= 256) map.delete(map.keys().next().value)
    const id = randomUUID()
    map.set(id, { ...value, expires: Date.now() + 15 * 60_000 })
    return id
  }
  function decorateAction(action, target) {
    if (!action) return undefined
    const token = remember(confirmations, { ...target, action })
    return { ...action, token }
  }

  async function mayUsePull(snapshot, sessionId, git, services, original, action) {
    if (snapshot.signal.aborted) return false
    const current = await freshPull(sessionId, git, services, original.url, snapshot)
    if (current.refused || current.pull.head !== original.head || current.pull.source !== original.source) return false
    if (current.pull.source !== 'extension') return true
    return !snapshot.signal.aborted && current.pull.policy?.allowed.includes(action) === true
  }
  const handlers = {
    status: sessionId => once('status:' + sessionId, async () => ({ ...await readStatus(ctx, sessionId), githubSource: extension.snapshot().mode })),
    'extension-state': () => { const { epoch, mode } = extension.snapshot(); return { epoch, mode } },
    outputs: sessionId => once('outputs:' + sessionId, () => readOutputs(ctx.get('sessionController'), sessionId, AbortSignal.timeout(30_000))),
    diff: (sessionId, scope) => once(`diff:${sessionId}:${scope}`, () => withSession(sessionId, async ({ git }) => readDiff(git, scope))),
    /**
     * 关联 PR: this Session's pull requests (links in its `gh pr …` results, and its branch's), from any repository and
     * in any state, then the user's other open ones in this repository. `checks`: re-read only these addresses.
     */
    pulls: (sessionId, force, checks) => {
      const snapshot = extension.snapshot()
      return once(`pulls:${snapshot.epoch}:${sessionId}:${force ? 'full' : ''}:${checks.join(' ')}`, () => withSession(sessionId, async ({ git, services }) => autofix.withAutofix(sessionId, await (async () => {
      const root = await repoRoot(git)
      if (root === null) return { problem: 'not-repository' }
      const github = binding(sessionId, services, snapshot)
      const { branch, remote, head } = /** @type {any} */ (await repoContext(git, { root, branch: true, origin: true, head: true }))
      const repo = await github.findRepo(remote)
      const signal = AbortSignal.any([snapshot.signal, AbortSignal.timeout(60_000)])
      const stored = pullCache.get(sessionId)
      const cached = stored?.root === root && stored?.branch === branch && stored?.repo === repo && stored?.head === head ? stored : undefined
      if (!force && !checks.length && cached && Date.now() - cached.at < PULLS_FRESH_MS) return cached.value
      // Checks running: re-read just those pull requests into the cached lists; the lists keep their full-read time.
      if (snapshot.mode === 'local' && checks.length && cached?.value?.pulls && Date.now() - cached.at < PULLS_FULL_MS) {
        const update = await github.byUrl(root, branch, repo, checks, signal)
        if (update.problem) return update
        const closed = update.fresh.filter(pull => !pull.open).map(pull => pull.url)
        // A checks poll does not re-read reviews: each re-read row keeps the review it had.
        const fresh = update.fresh.map(pull => ({ ...pull, review: cached.value.session.find(row => row.url === pull.url)?.review }))
        const value = { ...cached.value, session: mergePulls(cached.value.session, fresh), pulls: mergePulls(cached.value.pulls, update.fresh, closed), readAt: Date.now() }
        pullCache.set(sessionId, { at: cached.at, root, branch, repo, head, value })
        return value
      }
      const [list, history, policy] = await Promise.all([github.list(root, branch, repo, signal),
        handlers.outputs(sessionId).catch(() => ({ pullUrls: [] })), github.sessionPolicy(repo, branch, head)])
      if (list.problem && snapshot.mode === 'local') return list
      if (snapshot.signal.aborted) return unavailable()
      const rows = list.pulls ?? []
      const listed = new Map(rows.map(pull => [pull.url, pull]))
      const wanted = [...new Set([...(policy?.linkedPulls ?? []), ...rows.filter(pull => pull.current).map(pull => pull.url), ...history.pullUrls])].slice(0, SESSION_PULL_LIMIT)
      const read = await github.byUrl(root, branch, repo, wanted.filter(url => !listed.has(url)), signal)
      if (read.problem) return read
      const byUrl = new Map([...rows, ...read.fresh].map(pull => [pull.url, pull]))
      const found = sortPulls(wanted.map(url => byUrl.get(url)).filter(Boolean))
      // Reviews of this Session's open pull requests, and pull requests waiting for the user's review, on full reads only.
      const [session, requests] = await Promise.all([
        Promise.all(found.map(async pull => !pull.open ? pull : { ...pull, review: await github.reviews(root, pull.url, signal).then(review => review.problem ? undefined : review, () => undefined) })),
        github.requests(root, repo, signal).catch(() => ({ problem: 'failed' }))])
      if (snapshot.signal.aborted) return unavailable()
      const mine = new Set(session.map(pull => pull.url))
      const decorate = pull => pull.source !== 'extension' ? pull : { ...pull, policy: pull.policy && { ...pull.policy,
        actions: pull.policy.actions.map(action => decorateAction(action, { sessionId, root, repo: pull.repo, head: pull.head, url: pull.url, epoch: snapshot.epoch })) } }
      const value = { session: session.map(decorate), pulls: rows.filter(pull => !mine.has(pull.url)).map(decorate), requests: /** @type {any} */ (requests).requests ?? [], readAt: Date.now(),
        ...snapshot.mode !== 'local' ? { epoch: snapshot.epoch, extensionUnavailable: Boolean(list.problem), sessionPolicy: policy && {
          ...policy, deliver: decorateAction(policy.deliver, { sessionId, root, repo, branch, head, epoch: snapshot.epoch }) } } : {} }
      if (snapshot.mode === 'local') pullCache.set(sessionId, { at: Date.now(), root, branch, head, repo, value })
      return value
      })())))
    },
    /** 修复 CI／解决冲突／处理评审意见: one of this Session's open pull requests, with the Session on its branch. */
    fix: (sessionId, payload) => exclusive('act:' + sessionId, 'fix', () => withSession(sessionId, async ({ git, services, agent }) => {
      if (!await owns(sessionId, payload.url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot(), github = binding(sessionId, services, snapshot)
      const context = await freshPull(sessionId, git, services, payload.url, snapshot)
      if (context.refused) return context
      if (!context.pull.open || !(fixKinds(context.pull).includes(payload.kind) || (payload.kind === 'review' && payload.threads))) return { refused: 'changed' }
      if (payload.head && payload.head !== context.pull.head) return { refused: 'changed' }
      if (!context.pull.current) return { refused: 'off-branch' }
      let threads
      if (payload.kind === 'review' && payload.threads) {
        // The threads' text is read again here, from GitHub, never taken from the page.
        const review = await github.reviews(context.root, payload.url, AbortSignal.timeout(20_000))
        if (review.problem) return review
        threads = payload.threads === 'all' ? review.threads : review.threads.filter(thread => payload.threads.includes(thread.id))
        if (!threads.length) return { refused: 'changed' }
      }
      if (context.pull.source === 'extension') {
        if (!context.pull.policy?.allowed.includes('fix')) return { refused: 'not-authorized' }
        const failed = context.pull.checks.filter(check => check.id && failedCheck(check)).slice(0, 4)
        const logs = payload.kind === 'ci' ? await Promise.all(failed.map(async check => ({ check: check.id, log: await github.checkLog(context.pull, check.id) }))) : undefined
        const instruction = await extensionPrompt(snapshot, agent, 'fix', { url: payload.url, head: context.pull.head, kind: payload.kind }, payload.chinese, { threads, logs })
        return instruction ? send(sessionId, instruction, () => mayUsePull(snapshot, sessionId, git, services, context.pull, 'fix')) : { refused: 'not-authorized' }
      }
      return send(sessionId, fixInstruction({ pull: context.pull, kind: payload.kind, root: context.root, chinese: payload.chinese, threads }), () => !snapshot.signal.aborted)
    })),
    /** The head to lock and the methods the repository allows, read when 合并… opens. */
    mergeOptions: (sessionId, url) => withSession(sessionId, async ({ git, services }) => {
      if (!await owns(sessionId, url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot()
      const context = await freshPull(sessionId, git, services, url, snapshot)
      if (context.refused) return context
      if (context.pull.source === 'extension' && !context.pull.policy?.allowed.includes('merge')) return { refused: 'not-authorized' }
      if (!mergeReady(context.pull).ok) return { refused: 'not-ready' }
      const allowed = await binding(sessionId, services, snapshot).mergeMethods(context.root, context.pull.repo, AbortSignal.any([snapshot.signal, AbortSignal.timeout(20_000)]))
      if (snapshot.signal.aborted) return unavailable()
      if (allowed.problem) return allowed
      return { head: context.pull.head, methods: allowed.methods }
    }),
    /** 合并…: at exactly the head the dialog showed, by a method the repository allows. */
    merge: (sessionId, payload) => exclusive('act:' + sessionId, 'merge', () => withSession(sessionId, async ({ git, services, agent }) => {
      if (!await owns(sessionId, payload.url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot()
      const context = await freshPull(sessionId, git, services, payload.url, snapshot)
      if (context.refused) return context
      if (context.pull.source === 'extension' && (!context.pull.policy?.allowed.includes('merge') || payload.deleteBranch)) return { refused: 'not-authorized' }
      if (!mergeReady(context.pull).ok) return { refused: 'not-ready' }
      if (context.pull.head !== payload.head) return { refused: 'changed' }
      const allowed = await binding(sessionId, services, snapshot).mergeMethods(context.root, context.pull.repo, AbortSignal.timeout(20_000))
      if (allowed.problem) return allowed
      if (!allowed.methods.includes(payload.method)) return { refused: 'changed' }
      if (context.pull.source === 'extension') {
        const instruction = await extensionPrompt(snapshot, agent, 'merge', { url: payload.url, head: payload.head, method: payload.method }, payload.chinese)
        return instruction ? send(sessionId, instruction, () => mayUsePull(snapshot, sessionId, git, services, context.pull, 'merge')) : { refused: 'not-authorized' }
      }
      if (payload.deleteBranch && !safeBranch(context.pull.branch)) return { refused: 'branch-name' }
      return send(sessionId, mergeInstruction({ pull: context.pull, method: payload.method, head: payload.head, deleteBranch: payload.deleteBranch, chinese: payload.chinese }), () => !snapshot.signal.aborted)
    })),
    /** 工作树: the repository's worktrees, which the Session is in, and which Fig may remove. */
    worktrees: sessionId => withSession(sessionId, async ({ git, directory }) => {
      // Worktrees share the repository's config: its clean/process filters stay off here too, as for 改动.
      const context = await repoContext(git, { branch: true, upstream: true, filters: true })
      if (!context) return { worktrees: [] }
      const { branch, upstream, filters } = context
      const list = parseWorktrees((await git(['worktree', 'list', '--porcelain', '-z'])).stdout)
      const records = await readRegistry(registryPath(dshHome()))
      const workspaces = ctx.get('workspaceRegistry')
      const archived = new Set(workspaces?.archivedSessionIds ?? [])
      const known = new Set((workspaces?.list?.() ?? []).flatMap(workspace => [...(workspace.sessionIds ?? [])]))
      const cwd = await realpath(directory).catch(() => directory)
      const reals = await Promise.all(list.map(entry => realpath(entry.path).catch(() => entry.path)))
      // The Session is in the worktree whose path is the longest prefix of its directory (the pool sits inside the main checkout).
      const mine = reals.filter(path => cwd === path || cwd.startsWith(path + sep)).sort((a, b) => b.length - a.length)[0]
      const base = await branchBase(git, branch, upstream)
      return { base, worktrees: await Promise.all(list.map(async (entry, index) => {
        const path = reals[index]
        const record = records.find(each => each.path === path)
        const status = entry.prunable ? { exitCode: 0, stdout: '' } : await git(['-C', path, 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty'], [0, 128], filters)
        const dirty = status.exitCode !== 0 || status.stdout.trim().length > 0
        const ownerOpen = record !== undefined && known.has(record.sessionId) && !archived.has(record.sessionId)
        const verdict = removable(entry, { record, dirty, current: path === mine, ownerOpen, main: index === 0 })
        const merged = Boolean(verdict.ok && entry.branch && base) && (await git(['merge-base', '--is-ancestor', entry.branch, base], [0, 1, 128])).exitCode === 0
        return { path, display: homePath(path), branch: entry.branch, detached: entry.detached, main: index === 0, dirty, current: path === mine,
          fig: Boolean(record), session: record?.sessionId, ownerOpen, removable: verdict, merged }
      })) }
    }),
    /** 在新工作树中开新会话…: a new branch from HEAD or the comparison base, in the pool, with a new Session in it. */
    createWorktree: (sessionId, payload) => exclusive('worktree:' + sessionId, 'createWorktree', () => withSession(sessionId, async ({ git }) => {
      const state = await branchState(git)
      if (state.refused && state.refused !== 'no-remote') return state
      if (!safeBranch(payload.branch)) return { refused: 'branch-name' }
      if ((await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + payload.branch], [0, 1, 128])).exitCode === 0) return { refused: 'exists' }
      const from = payload.from === 'base' ? await branchBase(git, state.branch ?? null, state.upstream ?? null) : state.head
      if (!from) return { refused: 'base' }
      return makeWorktree(sessionId, git, state.root, { branch: payload.branch, from }, payload.message || undefined)
    })),
    /** 在工作树中处理: this Session's pull request on its own branch, in a new worktree and Session, its fix as the first message. */
    pullWorktree: (sessionId, payload) => exclusive('worktree:' + sessionId, 'pullWorktree', () => withSession(sessionId, async ({ git, services }) => {
      if (!await owns(sessionId, payload.url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot()
      const context = await freshPull(sessionId, git, services, payload.url, snapshot)
      if (context.refused) return context
      const pull = context.pull
      if (!pull.open) return { refused: 'changed' }
      if (pull.source === 'extension' && !pull.policy?.allowed.includes('pull-worktree')) return { refused: 'not-authorized' }
      if (pull.current) return { refused: 'on-branch' }
      if (!context.sameRepo) return { refused: 'other-repo' }
      if (!safeBranch(pull.branch)) return { refused: 'branch-name' }
      const taken = parseWorktrees((await git(['worktree', 'list', '--porcelain', '-z'])).stdout).find(entry => entry.branch === pull.branch)
      if (taken) return { refused: 'checked-out', path: homePath(taken.path) }
      const local = (await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + pull.branch], [0, 1, 128])).exitCode === 0
      const tracked = (await git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + pull.branch], [0, 1, 128])).exitCode === 0
      if (!local && !tracked) return { refused: 'not-fetched' }
      // The new Session starts without a message until it receives its own authorization from the extension.
      const kind = payload.fix && pull.source !== 'extension' ? fixKinds(pull)[0] : undefined
      const opened = await makeWorktree(sessionId, git, context.root, local ? { branch: pull.branch, existing: true } : { branch: pull.branch, track: 'origin/' + pull.branch },
        path => kind ? fixInstruction({ pull, kind, root: path, chinese: payload.chinese }) : undefined)
      const child = 'sessionId' in opened ? opened.sessionId : undefined
      if (child && pull.source === 'extension' && payload.fix && fixKinds(pull)[0]) {
        await withSession(child, async ({ git: childGit, services: childServices, agent }) => {
          if (!await mayUsePull(snapshot, child, childGit, childServices, pull, 'fix')) return
          const instruction = await extensionPrompt(snapshot, agent, 'fix', { url: pull.url, head: pull.head, kind: fixKinds(pull)[0] }, payload.chinese)
          if (instruction) await send(child, instruction, () => mayUsePull(snapshot, child, childGit, childServices, pull, 'fix'))
        })
      }
      return opened
    })),
    /** 获取分支: asks this Session's Agent to fetch a pull request's branch first. */
    fetchBranch: (sessionId, payload) => exclusive('act:' + sessionId, 'fetchBranch', () => withSession(sessionId, async ({ git, services }) => {
      if (!await owns(sessionId, payload.url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot()
      const context = await freshPull(sessionId, git, services, payload.url, snapshot)
      if (context.refused) return context
      if (context.pull.source === 'extension' && !context.pull.policy?.allowed.includes('fetch-branch')) return { refused: 'not-authorized' }
      if (!context.sameRepo || !safeBranch(context.pull.branch)) return { refused: 'branch-name' }
      return send(sessionId, fetchInstruction({ root: context.root, branch: context.pull.branch, url: payload.url, chinese: payload.chinese }),
        () => mayUsePull(snapshot, sessionId, git, services, context.pull, 'fetch-branch'))
    })),
    /** 移除…: a worktree Fig created, clean, not this or another open Session's; never --force. */
    removeWorktree: (sessionId, payload) => exclusive('worktree:' + sessionId, 'removeWorktree', () => withSession(sessionId, async ({ git }) => {
      const listed = /** @type {any} */ (await handlers.worktrees(sessionId))
      const entry = listed.worktrees?.find(each => each.path === payload.path)
      if (!entry) return { refused: 'changed' }
      if (!entry.removable.ok) return { refused: 'worktree-' + entry.removable.reason }
      await git(['worktree', 'remove', '--', entry.path])
      let branchDeleted = false
      if (payload.deleteBranch && entry.merged && safeBranch(entry.branch)) branchDeleted = (await git(['branch', '-d', entry.branch], [0, 1])).exitCode === 0
      const file = registryPath(dshHome())
      await updateRegistry(file, worktrees => worktrees.filter(each => each.path !== entry.path))
      return { removed: true, branchDeleted }
    })),
    /** A pull request's diff for reviewing it in Fig: one this Session lists (its own, the user's other ones, or a review request). */
    pullDiff: (sessionId, url) => withSession(sessionId, async ({ git, services }) => {
      if (!await listed(sessionId, url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot()
      const result = await binding(sessionId, services, snapshot).diff(await repoRoot(git) ?? process.cwd(), url, AbortSignal.any([snapshot.signal, AbortSignal.timeout(30_000)]))
      return snapshot.signal.aborted ? unavailable() : result
    }),
    /** 提交评审: the user's own review, pinned to the head the diff was read at. The Host's one write to GitHub. */
    submitReview: (sessionId, payload) => {
      const key = createHash('sha256').update(JSON.stringify([sessionId, payload])).digest('hex')
      return once(`review:${key}`, () => withSession(sessionId, async ({ git, services }) => {
      if (!await listed(sessionId, payload.url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot()
      const context = await freshPull(sessionId, git, services, payload.url, snapshot)
      if (context.refused) return context
      if (!context.pull.open) return { refused: 'changed' }
      if (context.pull.head !== payload.head) return { refused: 'changed' }
      if (context.pull.source === 'extension' && !context.pull.policy?.allowed.includes('submit-review')) return { refused: 'not-authorized' }
      if (context.pull.source === 'extension' && reviewResults.has(key)) return reviewResults.get(key)
      const result = await binding(sessionId, services, snapshot).submit(context.root,
        context.pull.source === 'extension' ? { ...payload, idempotencyKey: key } : payload, AbortSignal.any([snapshot.signal, AbortSignal.timeout(30_000)]))
      if (context.pull.source === 'extension' && result?.submitted) {
        if (reviewResults.size >= 256) reviewResults.delete(reviewResults.keys().next().value)
        reviewResults.set(key, result)
      }
      return result
      }))
    },
    /** 让 Agent 先审一遍: the Agent reads the pull request and reports in the conversation only. */
    agentReview: (sessionId, payload) => exclusive('act:' + sessionId, 'agentReview', () => withSession(sessionId, async ({ git, services, agent }) => {
      if (!await listed(sessionId, payload.url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot()
      if (snapshot.mode !== 'local') {
        const context = await freshPull(sessionId, git, services, payload.url, snapshot)
        if (context.refused) return context
        if (context.pull.source === 'extension') {
          if (!context.pull.policy?.allowed.includes('agent-review')) return { refused: 'not-authorized' }
          const instruction = await extensionPrompt(snapshot, agent, 'agent-review', { url: payload.url, head: context.pull.head }, payload.chinese)
          return instruction ? send(sessionId, instruction, () => mayUsePull(snapshot, sessionId, git, services, context.pull, 'agent-review')) : { refused: 'not-authorized' }
        }
      }
      return send(sessionId, reviewByAgentInstruction({ url: payload.url, chinese: payload.chinese }), () => !snapshot.signal.aborted)
    })),
    /** 自动修复 on or off for one of this Session's pull requests. */
    autofix: async (sessionId, payload) => {
      if (!payload.on) { autofix.stop(payload.url, sessionId); return { autofix: { on: false } } }
      if (!await owns(sessionId, payload.url)) return { refused: 'unknown-pull' }
      const snapshot = extension.snapshot()
      if (snapshot.mode !== 'local') {
        const context = await withSession(sessionId, async ({ git, services }) => freshPull(sessionId, git, services, payload.url, snapshot))
        if (context?.refused || !context?.pull || context.pull.source === 'extension' && !context.pull.policy?.allowed.includes('autofix') ||
          snapshot.signal.aborted) return { refused: 'not-authorized' }
      }
      autofix.start(sessionId, payload.url, payload.chinese)
      return { autofix: { on: true } }
    },
    /** 在访达中显示: the Session's own checkout root (never a path from the page) opened in Finder. */
    reveal: sessionId => withSession(sessionId, async ({ git, services }) => {
      if (process.platform !== 'darwin' || extension.snapshot().mode === 'extension-only') return { refused: 'unsupported' }
      const root = await repoRoot(git)
      if (root === null) return { refused: 'not-repository' }
      const child = services.subprocess.spawn({ argv: ['/usr/bin/open', '--', root], cwd: root, signal: AbortSignal.timeout(10_000), graceMs: 500,
        env: {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
      try { return { opened: (await child.done).exitCode === 0 } } finally { child.terminate(); await child.waitForExit() }
    }),
    commitFiles: sessionId => withSession(sessionId, async ({ git }) => changedFiles(git)),
    commit: (sessionId, payload) => once('commit:' + sessionId, () => withSession(sessionId, async ({ git }) => {
      const current = /** @type {any} */ (await changedFiles(git))
      if (!current.repository) return { refused: 'not-repository' }
      // The files changed since the dialog read them: the user confirms again against the new list.
      if (current.token !== payload.token) return { refused: 'changed', ...current }
      /** @type {Map<string, any>} */
      const byPath = new Map(current.files.map((/** @type {any} */ entry) => [entry.path, entry]))
      const picked = payload.files.map(path => byPath.get(path))
      if (picked.length === 0 || picked.some(entry => !entry || !insideCheckout(current.root, entry.path))) return { refused: 'changed', ...current }
      const text = commitInstruction(/** @type {any[]} */ (picked), { root: current.root, branch: current.branch, chinese: payload.chinese,
        coAuthor: extension.snapshot().mode === 'local' ? undefined : workbenchCoAuthor })
      const sent = await send(sessionId, text)
      return sent.sent ? { sent: picked.length } : sent
    })),
    /** 推送: the Session's branch, at the head the card showed. */
    push: (sessionId, payload) => exclusive('act:' + sessionId, 'push', () => withSession(sessionId, async ({ git, services }) => {
      const state = await branchState(git)
      if (state.refused) return state
      if (state.head !== payload.head) return { refused: 'changed' }
      if (state.upstream && state.ahead === 0) return { refused: 'nothing' }
      const snapshot = extension.snapshot()
      const github = binding(sessionId, services, snapshot)
      const repo = await github.findRepo(state.remote)
      return send(sessionId, pushInstruction({ root: state.root, branch: state.branch, upstream: state.upstream, chinese: payload.chinese }), async () => {
        const source = await github.source(repo)
        const current = await branchState(git)
        return !snapshot.signal.aborted && !current.refused && current.head === state.head && current.branch === state.branch && current.root === state.root &&
          await github.findRepo(current.remote) === repo && (source === 'local' || source === 'extension' && (await github.sessionPolicy(repo, state.branch, state.head))?.allowPush === true)
      })
    })),
    /** 创建 PR…: from the Session's branch into `base`, a branch the origin remote has as recorded locally. */
    createPull: (sessionId, payload) => exclusive('act:' + sessionId, 'createPull', () => withSession(sessionId, async ({ git, services, agent }) => {
      const state = await branchState(git)
      if (state.refused) return state
      if (state.head !== payload.head) return { refused: 'changed' }
      const snapshot = extension.snapshot(), github = binding(sessionId, services, snapshot)
      const repo = await github.findRepo(state.remote), source = await github.source(repo)
      if (!source || snapshot.signal.aborted) return { refused: 'not-authorized' }
      if (!safeBranch(payload.base) || payload.base === state.branch) return { refused: 'base' }
      const known = await git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + payload.base], [0, 1, 128])
      if (known.exitCode !== 0) return { refused: 'base' }
      const pushed = Boolean(state.upstream) && state.ahead === 0
      if (source === 'extension') {
        const allowed = async () => {
          const current = await branchState(git)
          if (current.refused || current.root !== state.root || current.branch !== state.branch || current.head !== state.head || await github.findRepo(current.remote) !== repo)
            return false
          return !snapshot.signal.aborted && (await github.sessionPolicy(repo, state.branch, state.head))?.allowCreatePull === true
        }
        if (!await allowed()) return { refused: 'not-authorized' }
        const instruction = await extensionPrompt(snapshot, agent, 'create-pull', { repo, branch: state.branch, base: payload.base, head: state.head, draft: payload.draft, pushed }, payload.chinese)
        return instruction ? send(sessionId, instruction, allowed) : { refused: 'not-authorized' }
      }
      return send(sessionId, pullRequestInstruction({ root: state.root, branch: state.branch, base: payload.base, draft: payload.draft,
        pushed, upstream: state.upstream, chinese: payload.chinese }), () => !snapshot.signal.aborted)
    })),
    runAction: (sessionId, token) => exclusive(`act:${sessionId}`, `runAction:${token}`, () => withSession(sessionId, async ({ git, services }) => {
      const intent = confirmations.get(token), snapshot = extension.snapshot(), github = binding(sessionId, services, snapshot)
      if (!intent || intent.sessionId !== sessionId || intent.expires < Date.now() || intent.epoch !== snapshot.epoch) return { refused: 'changed' }
      const state = await branchState(git)
      if (state.refused || state.root !== intent.root) return { refused: 'changed' }
      let descriptor
      if (intent.url) {
        const context = await freshPull(sessionId, git, services, intent.url, snapshot)
        if (context.refused || context.pull.source !== 'extension' || context.pull.repo !== intent.repo || context.pull.head !== intent.head) return { refused: 'changed' }
        descriptor = context.pull.policy?.actions.find(action => action.id === intent.action.id)
      } else {
        if (state.branch !== intent.branch || state.head !== intent.head || await github.findRepo(state.remote) !== intent.repo) return { refused: 'changed' }
        descriptor = (await github.sessionPolicy(intent.repo, intent.branch, intent.head))?.deliver
      }
      if (!descriptor || descriptor.id !== intent.action.id || descriptor.version !== intent.action.version || descriptor.label !== intent.action.label) return { refused: 'changed' }
      if (intent.result) return intent.result
      const result = await extensionCall(snapshot, snapshot.extension, 'runAction', [{ sessionId, repo: intent.repo, branch: intent.branch, head: intent.head,
        url: intent.url, action: descriptor.id, version: descriptor.version, idempotencyKey: token }], { maxBytes: 4096, ms: 30_000 })
      if (result?.completed !== true) return unavailable()
      return intent.result = { completed: true }
    })),
    openComparison: (sessionId, grant) => withSession(sessionId, async ({ git, services }) => {
      const snapshot = extension.snapshot(), root = await repoRoot(git)
      if (!root) return unavailable()
      const comparison = await binding(sessionId, services, snapshot).compare(grant, undefined)
      if (!comparison.repo || snapshot.signal.aborted) return unavailable()
      return { handle: remember(comparisons, { sessionId, root, grant, epoch: snapshot.epoch, expected: {
        repo: comparison.repo, round: comparison.round, base: comparison.base, head: comparison.head } }) }
    }),
    comparison: (sessionId, handle) => withSession(sessionId, async ({ git, services }) => {
      const intent = comparisons.get(handle), snapshot = extension.snapshot()
      if (!intent || intent.sessionId !== sessionId || intent.epoch !== snapshot.epoch || intent.expires < Date.now() || await repoRoot(git) !== intent.root) return unavailable()
      const result = await binding(sessionId, services, snapshot).compare(intent.grant, intent.expected)
      return snapshot.signal.aborted ? unavailable() : result
    })
  }
  /** Whether `url` is one of this Session's pull requests (read now when the card has not loaded them yet). */
  async function owns(sessionId, url) {
    // Through the handler, so a list cached for the Session's previous folder is never used.
    const session = (await handlers.pulls(sessionId, false, []))?.session
    return Boolean(session?.some(pull => pull.url === url))
  }

  /** Whether `url` is any pull request this Session's card lists: its own, the user's other ones, or a review request. */
  async function listed(sessionId, url) {
    const value = await handlers.pulls(sessionId, false, [])
    return [...(value?.session ?? []), ...(value?.pulls ?? []), ...(value?.requests ?? [])].some(pull => pull.url === url)
  }

  /**
   * Creates a worktree in the pool of `root`, records it, and opens a new Session in it (same Workspace, preset and
   * model as the source Session), with an optional first message (a string, or made from the worktree's path).
   * @param {string} sessionId @param {any} git @param {string} root
   * @param {{ branch: string, from?: string, existing?: boolean, track?: string }} spec
   * @param {string | ((path: string) => string | undefined) | undefined} message
   */
  async function makeWorktree(sessionId, git, root, spec, message) {
    let pool
    try { pool = await preparePool(root) } catch (error) { if (/** @type {any} */ (error)?.refused) return { refused: 'pool' }; throw error }
    const path = join(pool, worktreeName(spec.branch))
    if (await lstat(path).then(() => true, () => false)) return { refused: 'path-exists', path: homePath(path) }
    await addWorktree(git, { path, ...spec })
    const real = await realpath(path)
    const file = registryPath(dshHome())
    // Recorded before the Session opens, so a worktree whose Session could not be opened can still be removed from the card.
    const record = (/** @type {string} */ opened) => updateRegistry(file, worktrees => [...worktrees.filter(each => each.path !== real),
      { path: real, branch: spec.branch, root, sessionId: opened, createdAt: Date.now() }])
    await record('')
    const opened = await openSessionIn(ctx, sessionId, real, typeof message === 'function' ? message(real) : message)
    if (opened.sessionId) await record(opened.sessionId)
    return { ...opened, path: homePath(real) }
  }

  registerPageRoute(ctx, prefix, 'fig-development-workbench: route', (connection, req, res) => route(connection, req, res, handlers))
}

/**
 * One pull request, read fresh, with the Session's checkout: whether the Session is on its branch is `pull.current`.
 * @param {any} git @param {any} services @param {string} url
 * @returns {Promise<any>}
 */
export async function pullContext(git, services, url, github) {
  const context = await repoContext(git, { branch: true, origin: true })
  if (!context) return { refused: 'not-repository' }
  const { root, branch, remote } = context
  const repo = github ? await github.findRepo(remote) : remote?.web ? remote.path : undefined
  const signal = AbortSignal.timeout(30_000)
  const read = github ? await github.byUrl(root, branch, repo ?? '\0', [url], signal) : await readPullsByUrl(services, root, branch, repo ?? '\0', [url], signal)
  if (read.problem) return { refused: read.problem }
  const pull = read.fresh[0]
  if (!pull) return { refused: 'failed' }
  return { root, branch, pull, sameRepo: Boolean(repo) && targetRepo(url) === repo?.toLowerCase() && pull.headRepository === repo?.toLowerCase() }
}

/**
 * The Session's checkout for push and pull request actions: root, branch, head and position against the upstream.
 * @param {any} git
 * @returns {Promise<any>}
 */
export async function branchState(git) {
  const context = await repoContext(git, { branch: true, head: true, upstream: true, origin: true })
  if (!context) return { refused: 'not-repository' }
  const { root, branch, head, upstream, origin, remote } = context
  if (!branch || !head) return { refused: 'detached' }
  if (!safeBranch(branch)) return { refused: 'branch-name' }
  // Any origin counts, a local path too: the push and pull request instructions name it, they do not parse it.
  if (origin === null) return { refused: 'no-remote' }
  // Counts git cannot read (the upstream ref is gone) stay unknown, so push is offered rather than refused as nothing.
  const counts = upstream ? await aheadBehind(git, upstream) : null
  return { root, branch, head, upstream, remote, ahead: counts?.ahead ?? null, behind: counts?.behind ?? null }
}

/** The checkout's changed files and their fingerprint, read under the Session's sandbox. @param {any} git */
export async function changedFiles(git) {
  const context = await repoContext(git, { filters: true, branch: true })
  if (!context) return { repository: false, files: [] }
  const { root, filters, branch } = context
  const porcelain = (await git(['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], [0], filters)).stdout
  const files = parseStatus(porcelain)
  return { repository: true, root, branch, files, token: await fingerprint(root, porcelain, files) }
}

/** @param {any} ctx @param {string} sessionId */
const readStatus = (ctx, sessionId) => inSession(ctx, sessionId, async ({ git, directory }) => {
  const { repository } = await readRepository(git, directory)
  const worktreeCount = repository ? parseWorktrees((await git(['worktree', 'list', '--porcelain', '-z'], [0, 128])).stdout).length : 0
  return { directory, repository: repository ? { ...repository, display: homePath(repository.root), worktreeCount } : null, readAt: Date.now() }
})
