// 研发工作台 actions against real DSH, offline: 推送, 创建 PR…, this Session's pull requests (its branch and its own
// `gh pr` output, across repositories), 修复 CI, 合并… with the head lock, 自动修复, and a diff line comment put in the
// input. A fake gh first on PATH answers from a state file; the origin remote is a GitHub address that is never
// contacted. The probe holds every turn, so no model is called: each instruction is read from the held turn, then
// stopped. Nothing is pushed, created or merged anywhere.
import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedProfile, launchFig, cleanUp } from '../scripts/isolated-fig.mjs'
import { evidenceDir, insertProbes, openWorkbench } from './helpers/fig-smoke.mjs'
import { initRepo } from './helpers/git-fixture.mjs'

const evidence = await evidenceDir('workbench-agent-actions')
let fakeDir = ''
const state = await isolatedProfile('workbench-agent-actions', { extraEnv: root => {
  fakeDir = join(root, 'fake-gh')
  return { GROK_HOME: join(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok/auth.json'), CODEX_HOME: join(root, 'codex'),
    PATH: fakeDir + ':' + process.env.PATH, FIG_FAKE_GH_STATE: join(fakeDir, 'state.json') }
} })
await insertProbes(state, ['handoff-probe'])

// The fake gh: pr list, pr view <address>, repo view; anything else fails.
await mkdir(fakeDir, { recursive: true })
await writeFile(join(fakeDir, 'gh'), `#!${process.execPath}
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FIG_FAKE_GH_STATE, 'utf8'))
const [a, b, c] = process.argv.slice(2)
fs.appendFileSync(process.env.FIG_FAKE_GH_STATE + '.log', process.argv.slice(2).join(' ') + '\\n')
if (a === 'pr' && b === 'list') { process.stdout.write(JSON.stringify(state.list)); process.exit(0) }
if (a === 'pr' && b === 'view' && state.views[c]) { process.stdout.write(JSON.stringify(state.views[c])); process.exit(0) }
if (a === 'repo' && b === 'view') { process.stdout.write(JSON.stringify(state.repo)); process.exit(0) }
process.stderr.write('Could not resolve to a PullRequest\\n'); process.exit(1)
`)
await chmod(join(fakeDir, 'gh'), 0o755)
const APP = 'https://github.com/fig-fixture/app/pull/7', LIB = 'https://github.com/fig-fixture/lib/pull/9'
const H1 = '1'.repeat(40), H2 = '2'.repeat(40), H3 = '3'.repeat(40)
const run = (status, conclusion) => ({ __typename: 'CheckRun', name: 'build', status, conclusion, detailsUrl: 'https://github.com/fig-fixture/app/actions/runs/1' })
const pr7 = (head, checks, mergeable = 'MERGEABLE') => ({ number: 7, title: 'Sidebar workbench', url: APP, headRefName: 'feat', baseRefName: 'main', headRefOid: head,
  isDraft: false, reviewDecision: '', mergeable, statusCheckRollup: checks, state: 'OPEN' })
const lib9 = { number: 9, title: 'Shared helper', url: LIB, headRefName: 'helper', baseRefName: 'main', headRefOid: H1, isDraft: false, reviewDecision: '', mergeable: 'UNKNOWN', statusCheckRollup: [], state: 'MERGED' }
const gh = async (list, views) => writeFile(join(fakeDir, 'state.json'), JSON.stringify({ list, views, repo: { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false } }))
await gh([], {})

// The repository: main recorded on a GitHub origin, feat one commit ahead and never pushed.
const repo = join(state.documents, 'app')
const git = await initRepo(repo, { remote: true })
await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n'); git('add', '.'); git('commit', '-q', '-m', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD')
git('checkout', '-q', '-b', 'feat'); await writeFile(join(repo, 'b.txt'), 'b\n'); git('add', '.'); git('commit', '-q', '-m', 'feature')

let app, page, passed = false
const checks = {}
const probe = (endpoint, payload) => page.evaluate(async ({ endpoint, payload }) => (await (await fetch('/handoff-probe/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json()).value, { endpoint, payload })
let item, seen = 0
const idle = async () => { for (let i = 0; i < 100 && !await probe('idle', {}); i++) await page.waitForTimeout(200) }
/** The text of the next turn the workbench started, then that turn stopped. */
async function nextInstruction() {
  for (let i = 0; i < 100; i++) {
    const held = await probe('held', { id: item.id })
    if (held?.entries?.length > seen) {
      const text = JSON.stringify(held.entries.slice(seen)); seen = held.entries.length
      await probe('stop', { id: item.id }); await idle(); await page.waitForTimeout(300)
      return text
    }
    await page.waitForTimeout(200)
  }
  throw new Error('no instruction reached the session')
}
const card = () => page.locator('[data-fig-workbench="docked"]')
const refresh = async () => { await card().locator('button.fig-wb-link', { hasText: /^(刷新|Refresh)$/ }).first().click(); await page.waitForTimeout(1500) }
const dialog = kind => page.locator(`[data-fig-action-dialog="${kind}"]`)
/** One action from a pull request row's ⋯ menu in the card. */
const menuItem = async (number, key) => { await card().locator(`[data-fig-pull-menu="${number}"]`).click(); await card().locator(`[data-fig-pull-menu-list="${number}"] [data-fig-pull-${key}="${number}"]`).click() }
const confirm = async kind => { await dialog(kind).locator('[data-fig-action-send]').click(); await dialog(kind).waitFor({ state: 'hidden' }) }

try {
  app = await launchFig(state.env); page = await openWorkbench(app)
  await page.setViewportSize({ width: 1600, height: 1000 })
  item = await probe('parent', { workspacePath: repo, cwd: repo, preset: 'workspace-write', title: 'Workbench actions' })
  await probe('hold', { id: item.id }); await probe('followup', { id: item.id, text: 'Offline workbench actions' })
  const group = page.locator(`[data-row-key="workspace:${item.workspaceId}"]`); await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.locator(`[data-row-key="session:${item.id}"]`).click()
  seen = (await probe('held', { id: item.id }))?.entries?.length ?? 0
  await probe('stop', { id: item.id }); await idle()
  if (!await card().isVisible().catch(() => false)) await page.locator('[data-fig-workbench-button]').click()
  await card().locator('[data-fig-workbench-sync]').waitFor({ timeout: 20_000 })
  await refresh()

  // ① 推送 with no upstream, then 创建 PR… as a draft into main.
  checks.sync = (await card().locator('[data-fig-workbench-sync]').innerText()).replace(/\s+/g, ' ')
  assert.match(checks.sync, /未推送/)
  await card().locator('[data-fig-workbench-push]').click(); await confirm('push')
  const push = await nextInstruction()
  assert.match(push, /git push -u origin feat/); assert.match(push, /不要 force push/); checks.push = true
  await card().locator('[data-fig-workbench-create-pull]').click()
  assert.equal(await dialog('pull').locator('[data-fig-action-base]').inputValue(), 'main')
  await dialog('pull').locator('[data-fig-action-draft]').check(); await page.screenshot({ path: join(evidence, 'create-pull-dialog.png') }); await confirm('pull')
  const pull = await nextInstruction()
  assert.match(pull, /gh pr create --base main --head feat --draft/); checks.createPull = true

  // ② The branch's pull request (failing CI) becomes this Session's. Pull requests found in the Session's own gh pr output
  // (e.g. another repository's) are unit tested: the probe's direct tool calls do not write Session history.
  await gh([pr7(H1, [run('COMPLETED', 'FAILURE')])], { [APP]: pr7(H1, [run('COMPLETED', 'FAILURE')]), [LIB]: lib9 })
  await refresh()
  const rows = card().locator('[data-fig-workbench-pulls] [data-fig-workbench-pull-row]')
  await rows.first().waitFor()
  checks.sessionPulls = await rows.evaluateAll(nodes => nodes.map(node => node.querySelector('[data-fig-workbench-pull]')?.innerText.replace(/\s+/g, ' ')))
  assert.equal(checks.sessionPulls.length, 1)
  assert.match(checks.sessionPulls[0], /Sidebar workbench app #7 · 检查失败/)
  assert.equal(await card().locator('[data-fig-pull-attention]').count(), 1, 'a red dot marks the pull request that needs handling')
  assert.equal(await card().locator('[data-fig-workbench-create-pull]').count(), 0, 'no second pull request for the same branch')
  await page.screenshot({ path: join(evidence, 'session-pulls.png') })

  // ③ 修复 CI.
  await menuItem(7, 'fix-ci'); await confirm('fix')
  const fix = await nextInstruction()
  assert.match(fix, new RegExp('PR：' + APP)); assert.match(fix, /gh run view --log-failed/); checks.fixCi = true

  // ④ 合并… locked to the head shown; a push after opening the dialog is refused.
  await gh([pr7(H2, [run('COMPLETED', 'SUCCESS')])], { [APP]: pr7(H2, [run('COMPLETED', 'SUCCESS')]), [LIB]: lib9 })
  await refresh()
  await menuItem(7, 'merge')
  await dialog('merge').locator('[data-fig-action-method="squash"]').waitFor()
  checks.mergeMethods = await dialog('merge').locator('[data-fig-action-method]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-fig-action-method')))
  assert.deepEqual(checks.mergeMethods, ['squash', 'merge'])
  assert.equal(await dialog('merge').locator('[data-fig-action-method="squash"]').isChecked(), true)
  await gh([pr7(H3, [run('COMPLETED', 'SUCCESS')])], { [APP]: pr7(H3, [run('COMPLETED', 'SUCCESS')]), [LIB]: lib9 })
  await dialog('merge').locator('[data-fig-action-send]').click()
  await dialog('merge').getByRole('alert').waitFor(); checks.mergeRefusedAfterNewPush = await dialog('merge').getByRole('alert').innerText()
  await dialog('merge').getByRole('button', { name: /^(取消|Cancel)$/ }).click()
  await refresh()
  await menuItem(7, 'merge')
  await dialog('merge').locator('[data-fig-action-delete]').check(); await page.screenshot({ path: join(evidence, 'merge-dialog.png') }); await confirm('merge')
  const merge = await nextInstruction()
  assert.match(merge, new RegExp(`gh pr merge ${APP} --squash --match-head-commit ${H3}`)); assert.match(merge, /git push origin --delete feat/); checks.merge = true

  // ⑤ 自动修复: on, one instruction for the failing commit, status on the card, then off.
  await gh([pr7(H3, [run('COMPLETED', 'FAILURE')])], { [APP]: pr7(H3, [run('COMPLETED', 'FAILURE')]), [LIB]: lib9 })
  await refresh()
  await menuItem(7, 'autofix'); await confirm('autofix')
  const auto = await nextInstruction()
  assert.match(auto, /自动修复第 1 次/); checks.autofixSent = true
  await refresh()
  assert.match(await card().locator('[data-fig-workbench-pull="7"]').innerText(), /自动修复/)
  // The count lives in PR 详情.
  await card().locator('[data-fig-workbench-pull="7"]').click()
  checks.autofixStatus = await page.locator('[data-fig-pull-detail] [data-fig-pull-autofix-status]').innerText()
  assert.match(checks.autofixStatus, /已发 1 次/)
  await page.screenshot({ path: join(evidence, 'autofix-on.png') })
  await page.locator('[data-fig-pull-detail] [data-fig-pull-autofix="7"]').click(); await confirm('autofix')
  await page.locator('[data-fig-pull-detail] [data-fig-pull-autofix-status]').waitFor({ state: 'detached' }); checks.autofixOff = true
  await page.locator('[data-sidebar-right-toggle]').click(); await card().waitFor()

  // ⑥ A diff line comment goes into the input as a quote, not sent.
  await writeFile(join(repo, 'a.txt'), 'one\ntwo changed\nthree\nfour\n')
  await refresh()
  await card().locator('[data-fig-workbench-open-diff="uncommitted"]').click()
  const numbers = page.locator('[data-fig-diff-file="a.txt"] [data-fig-diff-number="new"]')
  await numbers.first().waitFor()
  const added = page.locator('[data-fig-diff-file="a.txt"] tr[data-fig-diff-line]').filter({ hasText: '+ two changed' }).locator('[data-fig-diff-number="new"]')
  await added.click()
  await page.locator('[data-fig-diff-file="a.txt"] tr[data-fig-diff-line]').filter({ hasText: '+ four' }).locator('[data-fig-diff-number="new"]').click({ modifiers: ['Shift'] })
  checks.selectedLines = await page.locator('tr[data-selected]').count()
  await page.locator('[data-fig-diff-comment-text]').fill('为什么加第四行？')
  await page.screenshot({ path: join(evidence, 'diff-comment.png') })
  await page.locator('[data-fig-diff-comment-add]').click()
  await page.locator('[data-fig-diff-quoted="ok"]').waitFor(); checks.quoted = true
  const before = (await probe('held', { id: item.id }))?.entries?.length ?? 0
  await page.waitForTimeout(800)
  assert.equal((await probe('held', { id: item.id }))?.entries?.length ?? 0, before, 'a quote is not sent'); checks.quoteNotSent = true
  checks.quoteVisible = await page.getByText(/代码评论：a\.txt/).count()
  await page.screenshot({ path: join(evidence, 'diff-quoted.png') })
  checks.repositoryUntouchedByPlugin = git('log', '--oneline').trim().split('\n').length === 2 && git('status', '--porcelain=v1').trim() === 'M a.txt'
  assert.ok(checks.repositoryUntouchedByPlugin)
  passed = true
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ date: new Date().toISOString().slice(0, 10), status: 'pass', checks,
    scope: 'development-workbench push / create pull request / session pull requests / fix / merge / auto-fix / diff line comment; real isolated DSH, fake gh, held turns, no model or network',
    not_verified: ['session pull requests from the Session\'s own gh pr output, incl. other repositories (unit tested; probe tool calls write no history)', 'a real Agent carrying out the instructions', 'real GitHub (gh is faked)', 'auto-fix across many ticks or the 3-send limit in the UI (unit tested)', 'packaged app'] }, null, 2))
  console.log('PASS', JSON.stringify(checks))
} catch (error) { await page?.screenshot({ path: join(evidence, 'failure.png') }); throw error } finally { await app?.close(); await cleanUp(state.profile, passed) }
