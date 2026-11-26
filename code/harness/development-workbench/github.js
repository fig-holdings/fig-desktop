import { parsePullUrl, safeBranch, MERGE_METHODS } from './actions.js'
import { failedCheck, normalizeCheck } from './ci.js'
import { checkId, cleanPullPolicy, cleanSessionPolicy, extensionCall, repoId, targetRepo, unavailable } from './extension.js'
import { isSha } from './actions.js'
import { readMergeMethods, readPulls, readPullsByUrl, shapePulls } from './pulls.js'
import { readPullDiff, readReviewRequests, readReviews, submitReview } from './review.js'
import { parsePatch } from './patch.js'

const patchLimit = 4 * 1024 * 1024
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : ''
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const githubLink = value => {
  const url = typeof value === 'string' && value.length <= 2000 ? URL.parse(value) : null
  return url?.origin === 'https://github.com' && !url.username && !url.password ? url.href : undefined
}
const stringList = value => Array.isArray(value) ? value.slice(0, 100).map(each => text(each)) : []
const samePull = (value, url) => typeof value === 'string' && value.toLowerCase() === url.toLowerCase() && Boolean(targetRepo(value))

function projectPull(value, repo, branch, checkoutRepo) {
  const url = value?.url
  const id = parsePullUrl(url)
  if (!id || targetRepo(url) !== repo || value.number !== id.number || !isSha(value.headRefOid) ||
    !safeBranch(value.headRefName) || !safeBranch(value.baseRefName) || !['OPEN', 'MERGED', 'CLOSED'].includes(value.state)) return undefined
  const sourceRepo = repoId(value.headRepository)
  const rawChecks = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup.slice(0, 100) : []
  const checks = rawChecks.map(check => ({
    name: text(check?.name ?? check?.context), __typename: text(check?.__typename),
    ...check?.__typename === 'StatusContext' ? { state: text(check?.state) } : { status: text(check?.status), conclusion: text(check?.conclusion) },
    detailsUrl: githubLink(check?.detailsUrl ?? check?.targetUrl), startedAt: text(check?.startedAt), completedAt: text(check?.completedAt)
  }))
  const [row] = shapePulls(JSON.stringify([{ number: id.number, title: text(value.title, 500), url, headRefName: value.headRefName, baseRefName: value.baseRefName,
    headRefOid: value.headRefOid, isDraft: value.isDraft === true, mergeable: text(value.mergeable), reviewDecision: text(value.reviewDecision),
    state: value.state, statusCheckRollup: checks }]), null)
  const identifiedChecks = checks.map((check, index) => {
    const id = rawChecks[index]?.id
    return { ...normalizeCheck(check), id: checkId(id) ? id : undefined }
  }).sort((a, b) => Number(failedCheck(b)) - Number(failedCheck(a)))
  return { ...row, headRepository: sourceRepo, current: Boolean(branch && checkoutRepo && sourceRepo === checkoutRepo && branch === row.branch),
    checks: identifiedChecks, checksComplete: value.checksComplete === true && Array.isArray(value.statusCheckRollup) &&
      value.statusCheckRollup.length === rawChecks.length, source: 'extension' }
}

/** Calls take a structured object and the scoped signal as their last argument. Routing is checked on every call. */
export function githubFor(snapshot, sessionId, services) {
  const extension = snapshot.extension
  const provider = extension?.provider
  const invoke = (method, target, limits) => extensionCall(snapshot, provider, method, [{ sessionId, ...target }], limits)
  const source = async repo => {
    if (snapshot.mode === 'local') return 'local'
    if (!repo || !provider || snapshot.signal.aborted) return undefined
    const result = await invoke('owns', { repo }, { maxBytes: 64 })
    if (result === 'managed') return 'extension'
    if (result === 'unmanaged' && snapshot.mode === 'mixed') return 'local'
  }
  const findRepo = async remote => {
    const direct = remote?.web ? repoId(remote.path) : undefined
    if (direct || snapshot.mode === 'local' || !remote || !remote.host || !remote.path) return direct
    const mapped = await invoke('repoFromRemote', { remote: { host: remote.host, path: remote.path } }, { maxBytes: 512 })
    return repoId(mapped?.repo)
  }
  async function pullPolicy(pull) {
    if (pull.source !== 'extension') return { managed: false, actions: [], allowed: /** @type {string[]} */ ([]) }
    const policy = cleanPullPolicy(await extensionCall(snapshot, extension, 'pullPolicy', [{ sessionId, repo: pull.repo, url: pull.url, head: pull.head }], { maxBytes: 16_384 }))
    return policy && { ...policy, allowed: policy.allowed.filter(action => {
      const tool = action === 'autofix' ? 'fix' : action
      return !['fix', 'merge', 'agent-review'].includes(tool) || Boolean(extension.tools?.[tool])
    }) }
  }
  async function sessionPolicy(repo, branch, head) {
    const kind = await source(repo)
    if (kind === 'local') return { source: 'local', linkedPulls: [], deliver: undefined, branchFor: undefined, allowPush: true, allowCreatePull: true }
    if (kind !== 'extension') return undefined
    const result = cleanSessionPolicy(await extensionCall(snapshot, extension, 'sessionPolicy', [{ sessionId, repo, branch, head }], { maxBytes: 16_384 }))
    return result && { ...result, source: 'extension', allowCreatePull: result.allowCreatePull && !result.deliver && Boolean(extension.tools?.['create-pull']) }
  }
  async function decorate(value, repo, branch, checkoutRepo) {
    const pull = projectPull(value, repo, branch, checkoutRepo)
    if (!pull) return undefined
    const policy = await pullPolicy(pull)
    return { ...pull, policy, githubActionsAvailable: Boolean(policy) }
  }
  return {
    source, findRepo, sessionPolicy, pullPolicy,
    async list(cwd, branch, repo, signal) {
      const kind = await source(repo)
      if (kind === 'local') return readPulls(services, cwd, branch, signal, repo)
      if (kind !== 'extension') return unavailable()
      const value = await invoke('listPulls', { repo, author: 'self' })
      if (repoId(value?.repo) !== repo || !Array.isArray(value?.pulls) || value.pulls.length > 30) return unavailable()
      const pulls = await Promise.all(value.pulls.map(pull => decorate(pull, repo, branch, repo)))
      return pulls.every(Boolean) && !snapshot.signal.aborted ? { pulls } : unavailable()
    },
    async byUrl(cwd, branch, checkoutRepo, urls, signal) {
      if (snapshot.mode === 'local') return readPullsByUrl(services, cwd, branch, checkoutRepo, urls, signal)
      const fresh = [], missing = []
      for (const url of urls) {
        const repo = targetRepo(url)
        const kind = await source(repo)
        if (kind === 'local') {
          const result = await readPullsByUrl(services, cwd, branch, checkoutRepo ?? '\0', [url], signal)
          const row = result.fresh?.find(pull => samePull(pull.url, url) && pull.repo === repo)
          if (row) fresh.push(row); else missing.push(url)
        } else if (kind === 'extension') {
          const value = await invoke('viewPull', { repo, url })
          const row = samePull(value?.url, url) && await decorate(value, repo, branch, checkoutRepo)
          if (row) fresh.push(row); else missing.push(url)
        } else missing.push(url)
      }
      return snapshot.signal.aborted ? unavailable() : { fresh, missing, clear: missing.length > 0 }
    },
    async reviews(cwd, url, signal) {
      const repo = targetRepo(url), kind = await source(repo)
      if (kind === 'local') return readReviews(services, cwd, url, signal)
      if (kind !== 'extension') return unavailable()
      const value = await invoke('reviews', { repo, url })
      if (!samePull(value?.url, url) || !Array.isArray(value.threads) || value.threads.length > 100) return unavailable()
      return { approved: stringList(value.approved), pending: stringList(value.pending), changes: stringList(value.changes), resolved: count(value.resolved), more: value.more === true,
        threads: value.threads.filter(thread => checkId(thread?.id)).map(thread => ({ id: thread.id, path: text(thread.path, 1000), line: count(thread.line) || null,
          author: text(thread.author), body: text(thread.body, 2000), url: githubLink(thread.url), outdated: thread.outdated === true, replies: count(thread.replies) })) }
    },
    async requests(cwd, repo, signal) {
      const kind = await source(repo)
      if (kind === 'local') return readReviewRequests(services, cwd, signal, repo)
      if (kind !== 'extension') return unavailable()
      const value = await invoke('reviewRequests', { repo })
      if (repoId(value?.repo) !== repo || !Array.isArray(value?.requests) || value.requests.length > 30) return unavailable()
      const requests = value.requests.filter(pull => targetRepo(pull?.url) === repo && parsePullUrl(pull.url)?.number === pull.number)
        .map(pull => ({ number: pull.number, title: text(pull.title, 500), url: pull.url, repo, author: text(pull.author), draft: pull.draft === true, updatedAt: text(pull.updatedAt), source: 'extension' }))
      return { requests }
    },
    async mergeMethods(cwd, repo, signal) {
      const kind = await source(repo)
      if (kind === 'local') return readMergeMethods(services, cwd, repo, signal)
      if (kind !== 'extension') return unavailable()
      const value = await invoke('mergeMethods', { repo }, { maxBytes: 1024 })
      return repoId(value?.repo) === repo && Array.isArray(value.methods) ? { methods: MERGE_METHODS.filter(method => value.methods.includes(method)) } : unavailable()
    },
    async diff(cwd, url, signal) {
      const repo = targetRepo(url), kind = await source(repo)
      if (kind === 'local') return readPullDiff(services, cwd, url, signal)
      if (kind !== 'extension') return unavailable()
      const value = await invoke('pullDiff', { repo, url }, { maxBytes: patchLimit + 4096, ms: 30_000 })
      if (!samePull(value?.url, url) || !isSha(value.head) || value.patchHead !== value.head || typeof value.patch !== 'string' || Buffer.byteLength(value.patch) > patchLimit) return unavailable()
      const policy = await pullPolicy({ source: 'extension', repo, url, head: value.head })
      return snapshot.signal.aborted ? unavailable() : { files: parsePatch(value.patch), head: value.head, number: parsePullUrl(url)?.number, title: text(value.title, 500),
        author: text(value.author), open: value.open === true, source: 'extension', allowAgentReview: policy?.allowed.includes('agent-review') === true,
        allowReview: policy?.allowed.includes('submit-review') === true }
    },
    async submit(cwd, review, signal) {
      const repo = targetRepo(review.url), kind = await source(repo)
      if (kind === 'local') return submitReview(services, cwd, review, signal)
      if (kind !== 'extension') return unavailable()
      const value = await invoke('submitReview', { repo, ...review }, { maxBytes: 4096, ms: 30_000 })
      return value?.submitted === true && samePull(value.pullUrl, review.url) && value.head === review.head
        ? { submitted: true, url: githubLink(value.url) } : unavailable()
    },
    async checkLog(pull, id) {
      if (!checkId(id) || !pull.checks.some(check => check.id === id) || await source(pull.repo) !== 'extension') return undefined
      const value = await invoke('checkLog', { repo: pull.repo, url: pull.url, head: pull.head, checkId: id }, { maxBytes: 40_000 })
      return samePull(value?.url, pull.url) && value.head === pull.head && value.checkId === id ? text(value.log, 12_000) : undefined
    },
    async compare(grant, expected) {
      if (!extension || snapshot.mode === 'local') return unavailable()
      const value = await invoke('compare', { grant, ...expected }, { maxBytes: patchLimit + 4096, ms: 30_000 })
      const repo = repoId(value?.repo), round = value?.round
      if (!repo || !checkId(round) || !isSha(value.base) || !isSha(value.head) || value.sessionId !== sessionId ||
        (expected && (repo !== expected.repo || round !== expected.round || value.base !== expected.base || value.head !== expected.head)) ||
        typeof value.patch !== 'string' || Buffer.byteLength(value.patch) > patchLimit || await source(repo) !== 'extension') return unavailable()
      return { repo, round, base: value.base, head: value.head, files: parsePatch(value.patch) }
    }
  }
}
