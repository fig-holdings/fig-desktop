// 研发工作台 reviews and worktrees against real DSH, offline: a pull request's review state and a thread handed to the
// Agent; review requests; reviewing another pull request in the diff tab (draft, the Agent's read-only review, submit);
// the worktree list and a new Session in a new worktree, opened in the window. A fake gh first on PATH answers from a
// state file; the probe holds every turn of the source Session so no model is called there. Nothing reaches GitHub.
// Paths that need Session history (pull requests from the Session's own gh output, 在工作树中处理) and archiving
// (移除…) are covered by tests/workbench-review-worktree.test.mjs against the real Host.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedProfile, launchFig, cleanUp } from '../scripts/isolated-fig.mjs'
import { evidenceDir, insertProbes, openWorkbench } from './helpers/fig-smoke.mjs'
import { initRepo } from './helpers/git-fixture.mjs'

const evidence = await evidenceDir('workbench-review-worktree')
let fakeDir = ''
const state = await isolatedProfile('workbench-review-worktree', { extraEnv: root => {
  fakeDir = join(root, 'fake-gh')
  return { GROK_HOME: join(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok/auth.json'), CODEX_HOME: join(root, 'codex'),
    PATH: fakeDir + ':' + process.env.PATH, FIG_FAKE_GH_STATE: join(fakeDir, 'state.json') }
} })
await insertProbes(state, ['handoff-probe'])
await mkdir(fakeDir, { recursive: true })
await writeFile(join(fakeDir, 'gh'), `#!${process.execPath}
const fs = require('node:fs'); const state = JSON.parse(fs.readFileSync(process.env.FIG_FAKE_GH_STATE, 'utf8')); const argv = process.argv.slice(2)
fs.appendFileSync(process.env.FIG_FAKE_GH_STATE + '.log', JSON.stringify(argv) + '\\n')
const out = value => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0) }
if (argv[0] === 'pr' && argv[1] === 'list') out(state.list)
if (argv[0] === 'pr' && argv[1] === 'view' && state.views[argv[2]]) out(state.views[argv[2]])
if (argv[0] === 'api' && state.diffs[argv[1]]) out(state.diffs[argv[1]])
if (argv[0] === 'search') out(state.search)
if (argv[0] === 'api' && argv[1] === 'graphql') out(state.graphql)
if (argv[0] === 'api' && argv[1] === '-X') out({ html_url: 'https://github.com/other/lib/pull/21#pullrequestreview-1' })
process.stderr.write('Could not resolve to a PullRequest'); process.exit(1)
`)
await chmod(join(fakeDir, 'gh'), 0o755)
const APP = 'https://github.com/fig-fixture/app/pull/7', LIB = 'https://github.com/fig-fixture/app/pull/21', HEAD = 'c'.repeat(40)
const BASE = 'b'.repeat(40), COMPARE = 'repos/fig-fixture/app/compare/' + BASE + '...' + HEAD
const pr7 = { number: 7, title: 'Sidebar workbench', url: APP, headRefName: 'feat', baseRefName: 'main', headRefOid: HEAD, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', statusCheckRollup: [] }
await writeFile(join(fakeDir, 'state.json'), JSON.stringify({
  list: [pr7],
  views: { [APP]: { ...pr7, baseRefOid: BASE, state: 'OPEN' }, [LIB]: { number: 21, title: 'Lib change', url: LIB, headRefName: 'x', baseRefName: 'main', baseRefOid: BASE, headRefOid: HEAD, statusCheckRollup: [], state: 'OPEN', author: { login: 'zed' } } },
  graphql: { data: { repository: { pullRequest: { latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'alice' } }, { state: 'CHANGES_REQUESTED', author: { login: 'bob' } }] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'carol' } }] },
    reviewThreads: { totalCount: 2, nodes: [{ id: 'T1', isResolved: false, path: 'b.txt', line: 1, comments: { totalCount: 1, nodes: [{ author: { login: 'bob' }, body: 'Please rename b', url: 'https://github.com/fig-fixture/app/pull/7#discussion_r1' }] } },
      { id: 'T2', isResolved: true, path: 'a.txt', line: 1, comments: { totalCount: 1, nodes: [{ author: { login: 'bob' }, body: 'done', url: 'u2' }] } }] } } } } },
  // The second is another repository of the same organization: it must not be listed.
  search: [{ number: 21, title: 'Lib change', url: LIB, repository: { nameWithOwner: 'fig-fixture/app' }, author: { login: 'zed' }, updatedAt: '2026-11-17T10:00:00Z' },
    { number: 74, title: 'Elsewhere', url: 'https://github.com/fig-fixture/figone/pull/74', repository: { nameWithOwner: 'fig-fixture/figone' }, author: { login: 'zed' }, updatedAt: '2026-11-17T11:00:00Z' }],
  diffs: { [COMPARE]: 'diff --git a/lib.js b/lib.js\n--- a/lib.js\n+++ b/lib.js\n@@ -1,2 +1,3 @@\n keep\n+added\n end\n' }
}))

const repo = join(state.documents, 'app')
const git = await initRepo(repo, { remote: true })
await writeFile(join(repo, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-q', '-m', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD')
git('checkout', '-q', '-b', 'feat'); await writeFile(join(repo, 'b.txt'), 'b\n'); git('add', '.'); git('commit', '-q', '-m', 'feature')

let app, page, passed = false, item, seen = 0
const checks = {}
const probe = (endpoint, payload) => page.evaluate(async ({ endpoint, payload }) => (await (await fetch('/handoff-probe/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json()).value, { endpoint, payload })
const idle = async () => { for (let i = 0; i < 100 && !await probe('idle', {}); i++) await page.waitForTimeout(200) }
async function nextInstruction() {
  for (let i = 0; i < 100; i++) {
    const held = await probe('held', { id: item.id })
    if (held?.entries?.length > seen) { const text = JSON.stringify(held.entries.slice(seen)); seen = held.entries.length; await probe('stop', { id: item.id }); await idle(); await page.waitForTimeout(300); return text }
    await page.waitForTimeout(200)
  }
  throw new Error('no instruction reached the session')
}
const card = () => page.locator('[data-fig-workbench="docked"]')
const refresh = async () => { await card().locator('button.fig-wb-link', { hasText: /^(刷新|Refresh)$/ }).first().click(); await page.waitForTimeout(1500) }
const ghLog = async () => (await readFile(join(fakeDir, 'state.json.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

try {
  app = await launchFig(state.env); page = await openWorkbench(app)
  await page.setViewportSize({ width: 1600, height: 1000 })
  item = await probe('parent', { workspacePath: repo, cwd: repo, preset: 'workspace-write', title: 'Review and worktrees' })
  await probe('hold', { id: item.id }); await probe('followup', { id: item.id, text: 'Offline review and worktrees' })
  const group = page.locator(`[data-row-key="workspace:${item.workspaceId}"]`); await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.locator(`[data-row-key="session:${item.id}"]`).click()
  seen = (await probe('held', { id: item.id }))?.entries?.length ?? 0
  await probe('stop', { id: item.id }); await idle()
  if (!await card().isVisible().catch(() => false)) await page.locator('[data-fig-workbench-button]').click()
  await card().locator('[data-fig-workbench-sync]').waitFor({ timeout: 20_000 })
  await refresh()

  // The card lists the pull request in two lines; review state and threads live in PR 详情.
  checks.compactRow = (await card().locator('[data-fig-workbench-pull="7"]').innerText()).replace(/\s+/g, ' ')
  assert.match(checks.compactRow, /Sidebar workbench app #7 · 要求修改/)
  await card().locator('[data-fig-workbench-pull="7"]').click()
  // R1/R2: review state, the unresolved thread, handed to the Agent.
  const review = page.locator('[data-fig-pull-detail] [data-fig-pull-review="7"]')
  await review.waitFor()
  checks.reviewSummary = (await review.innerText()).replace(/\s+/g, ' ')
  assert.match(checks.reviewSummary, /已批准 alice · 要求修改 bob · 待评审 carol/)
  assert.match(checks.reviewSummary, /未解决 1 条评审意见 · 已解决 1/)
  await review.locator('[data-fig-review-thread="T1"]').waitFor()
  await page.waitForTimeout(800) // the right sidebar finishes opening
  await page.screenshot({ path: join(evidence, 'review-threads.png') })
  await review.locator('[data-fig-thread-agent="T1"]').click()
  await page.locator('[data-fig-action-dialog="threads"] [data-fig-action-send]').click()
  const thread = await nextInstruction()
  assert.match(thread, /b\.txt:1 — @bob/); assert.match(thread, /> Please rename b/); checks.threadToAgent = true

  // R3/R4: a review request reviewed in the diff tab; the Agent's read-only review; the user's review submitted once confirmed.
  await page.locator('[data-sidebar-right-toggle]').click(); await card().waitFor()
  await card().locator('[data-fig-workbench-requests-toggle]').click()
  checks.requests = await card().locator('[data-fig-review-request]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-fig-review-request')))
  assert.deepEqual(checks.requests, [LIB], 'only this repository\'s review requests')
  await card().locator(`[data-fig-review-request="${LIB}"] [data-fig-workbench-pull]`).click()
  const lineNumber = page.locator('[data-fig-diff-file="lib.js"] tr[data-fig-diff-line]').filter({ hasText: '+ added' }).locator('[data-fig-diff-number="new"]')
  await lineNumber.waitFor({ timeout: 20_000 })
  checks.pullTitle = await page.locator('[data-fig-development-diff="pull"]').locator('span[title]').first().innerText()
  assert.match(checks.pullTitle, /#21 Lib change · @zed/)
  await page.locator('[data-fig-review-agent]').click()
  await page.locator('[data-fig-review-agent-status="sent"]').waitFor()
  assert.match(await nextInstruction(), /不要在 GitHub 上评论/); checks.agentReview = true
  await lineNumber.click()
  await page.locator('[data-fig-diff-comment-text]').fill('Why add this line?')
  await page.locator('[data-fig-diff-comment-add]').click()
  await page.locator('[data-fig-review-panel]').waitFor()
  assert.equal(await page.locator('[data-fig-review-comment]').count(), 1)
  await page.locator('[data-fig-review-body]').fill('Looks close.')
  await page.locator('[data-fig-review-event="REQUEST_CHANGES"]').check()
  await page.screenshot({ path: join(evidence, 'review-draft.png') })
  await page.locator('[data-fig-review-submit]').click()
  assert.equal((await ghLog()).filter(argv => argv[1] === '-X').length, 0, 'nothing is posted before the second confirmation')
  await page.locator('[data-fig-review-confirm]').click()
  await page.locator('[data-fig-review-notice="done"]').waitFor()
  const posted = (await ghLog()).filter(argv => argv[1] === '-X')
  assert.deepEqual(posted, [['api', '-X', 'POST', 'repos/fig-fixture/app/pulls/21/reviews', '-f', 'commit_id=' + HEAD, '-f', 'event=REQUEST_CHANGES', '-f', 'body=Looks close.',
    '-f', 'comments[][path]=lib.js', '-F', 'comments[][line]=2', '-f', 'comments[][side]=RIGHT', '-f', 'comments[][body]=Why add this line?']])
  assert.equal(await page.locator('[data-fig-review-comment]').count(), 0, 'the draft is cleared once submitted'); checks.reviewSubmitted = true
  await page.screenshot({ path: join(evidence, 'review-submitted.png') })

  // W1/W2: the worktree list, then a new Session in a new worktree, opened in the window. The right sidebar closes
  // first: with it open, 1600px leaves no room to dock the card.
  await page.locator('[data-sidebar-right-toggle]').click()
  await card().waitFor()
  // No separate repository-name row or heading; the branch row is the worktree entry.
  checks.environment = (await card().locator('[data-fig-workbench-repository]').innerText()).replace(/\s+/g, ' ')
  assert.doesNotMatch(checks.environment, /当前仓库|项目目录/)
  assert.match(checks.environment, /^app · .* feat .*fig-fixture\/app$/)
  await card().locator('[data-fig-workbench-worktrees-toggle]').click()
  await card().locator('[data-fig-worktree]').first().waitFor()
  checks.worktreesBefore = await card().locator('[data-fig-worktree]').count()
  await card().locator('[data-fig-workbench-new-worktree]').click()
  const dialog = page.locator('[data-fig-action-dialog="worktree"]')
  assert.match(await dialog.locator('[data-fig-action-branch]').inputValue(), /^fig\/[0-9a-f]{6}$/)
  await dialog.locator('[data-fig-action-branch]').fill('fig/ui-wt')
  await dialog.locator('[data-fig-action-from="base"]').check()
  await dialog.locator('[data-fig-action-message]').fill('Start here')
  await page.screenshot({ path: join(evidence, 'worktree-dialog.png') })
  await dialog.locator('[data-fig-action-send]').click(); await dialog.waitFor({ state: 'hidden' })
  const path = join(repo, '.agents', 'worktrees', 'fig-ui-wt')
  for (let i = 0; i < 50 && !existsSync(path); i++) await page.waitForTimeout(200)
  assert.ok(existsSync(path))
  const real = realpathSync(path)
  assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: path }).toString().trim(), 'fig/ui-wt')
  assert.equal(git('status', '--porcelain').trim(), '', 'the source checkout is untouched')
  const registry = JSON.parse(await readFile(join(state.dshHome, 'fig', 'development-workbench', 'worktrees.json'), 'utf8'))
  const created = registry.worktrees.find(entry => entry.branch === 'fig/ui-wt')
  assert.ok(created?.sessionId)
  await page.waitForFunction(id => document.querySelector(`[data-conversation-session="${id}"]`), created.sessionId, { timeout: 20_000 })
  checks.openedNewSession = true
  const inspected = await probe('inspect', { id: created.sessionId })
  checks.newSessionCwd = inspected.cwd
  assert.equal(inspected.cwd, real)
  assert.ok(inspected.messages.some(message => message.text.includes('Start here'))); checks.firstMessage = true
  await page.screenshot({ path: join(evidence, 'worktree-session.png') })
  await page.locator(`[data-row-key="session:${item.id}"]`).click()
  await card().locator('[data-fig-workbench-sync]').waitFor()
  if (await card().locator('[data-fig-workbench-worktrees-toggle]').getAttribute('aria-expanded') !== 'true') await card().locator('[data-fig-workbench-worktrees-toggle]').click()
  await card().locator(`[data-fig-worktree="${real}"]`).waitFor()
  checks.newWorktreeRow = (await card().locator(`[data-fig-worktree="${real}"]`).innerText()).replace(/\s+/g, ' ')
  assert.match(checks.newWorktreeRow, /fig\/ui-wt.*Fig 创建.*仍有打开的会话在用/)
  await page.screenshot({ path: join(evidence, 'worktree-list.png') })
  passed = true
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ date: new Date().toISOString().slice(0, 10), status: 'pass', checks,
    scope: 'development-workbench review state and threads, review requests, reviewing another pull request in Fig, worktree list and a new Session in a new worktree; real isolated DSH, fake gh, no model or network',
    not_verified: ['在工作树中处理 and 移除… in the UI (Host-tested in workbench-review-worktree.test.mjs: Session history and archiving cannot be produced here)', 'real GitHub (gh is faked)',
      'a real Agent acting on the instructions', 'packaged app'] }, null, 2))
  console.log('PASS', JSON.stringify(checks))
} catch (error) { await page?.screenshot({ path: join(evidence, 'failure.png') }); throw error } finally { await app?.close(); await cleanUp(state.profile, passed) }
