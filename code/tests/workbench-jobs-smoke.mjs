// 研发工作台 against the real DSH job list: 「查看输出」 opens DSH's own header list (a local adaptation, see the technical
// notes' ledger), a job stops from the card, and the ⋯ menu holds no duplicate of the path menu and closes on Escape.
// Offline, temporary Profile, no model; the repository is only read.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedProfile, launchFig, cleanUp } from '../scripts/isolated-fig.mjs'
import { evidenceDir, insertProbes, openWorkbench } from './helpers/fig-smoke.mjs'
import { initRepo } from './helpers/git-fixture.mjs'
const evidence = await evidenceDir('workbench-jobs')
const state = await isolatedProfile('workbench-jobs', { extraEnv: root => ({ GROK_HOME: join(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok/auth.json'), CODEX_HOME: join(root, 'codex') }) })
await insertProbes(state, ['handoff-probe'])
// A repository whose remote was added after init (no origin/HEAD), on main with nothing of its own, one file partly staged.
const repo = join(state.documents, 'p0repo')
const git = await initRepo(repo, { remote: join(repo, 'no-such-remote') })
await writeFile(join(repo, 'a.txt'), 'a\n'); await writeFile(join(repo, 'b.txt'), 'b\n')
git('add', '.'); git('commit', '-q', '-m', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD')
await writeFile(join(repo, 'a.txt'), 'a\nstaged\n'); git('add', 'a.txt'); await writeFile(join(repo, 'a.txt'), 'a\nstaged\nunstaged\n')
await writeFile(join(repo, 'b.txt'), 'b\nchanged\n')
let app, page, passed = false
const checks = {}
const probe = (endpoint, payload) => page.evaluate(async ({ endpoint, payload }) => (await (await fetch('/handoff-probe/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json()).value, { endpoint, payload })
try {
  app = await launchFig(state.env); page = await openWorkbench(app)
  await page.setViewportSize({ width: 1600, height: 900 })
  const item = await probe('parent', { workspacePath: repo, cwd: repo, preset: 'workspace-write', title: 'Workbench jobs' })
  await probe('hold', { id: item.id }); await probe('followup', { id: item.id, text: 'Offline P0 check' })
  const group = page.locator(`[data-row-key="workspace:${item.workspaceId}"]`); await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.locator(`[data-row-key="session:${item.id}"]`).click()
  await probe('stop', { id: item.id })
  for (let i = 0; i < 50 && !await probe('idle', {}); i++) await page.waitForTimeout(200)
  const card = page.locator('[data-fig-workbench="docked"]')
  if (!await card.isVisible().catch(() => false)) await page.locator('[data-fig-workbench-button]').click()
  await card.locator('[data-fig-workbench-repository]').waitFor({ timeout: 20_000 })
  // ⋯ menu: copy path lives in the path row only.
  await card.getByRole('button', { name: /^(更多|More)$/ }).click()
  checks.moreMenu = await card.locator('[role="menu"] [role="menuitem"]').allInnerTexts()
  assert.deepEqual(checks.moreMenu, ['复制分支名', '在新工作树中开新会话…'])
  // Escape closes it, as it closes the path and pull request menus.
  await page.keyboard.press('Escape')
  checks.moreMenuClosed = await card.locator('[role="menu"]').count() === 0
  assert.ok(checks.moreMenuClosed)
  // A real background job: 查看输出 opens DSH's own job list through the trigger holding the job count.
  const job = await probe('call', { id: item.id, name: 'bash', args: { command: 'sleep 30', description: 'Workbench P1 job', run_in_background: true } })
  checks.jobStarted = Boolean(job)
  const view = card.locator('[data-fig-workbench-jobs] button').filter({ hasText: /查看输出|View output/ })
  await view.waitFor({ timeout: 20_000 })
  await view.click()
  await page.waitForTimeout(400)
  // The expanded header button is DSH's job list (its label is the job count).
  const opened = page.locator('[data-slot="conversation.session.header.actions"] button[aria-expanded="true"]')
  checks.openedLabel = await opened.first().getAttribute('aria-label')
  assert.match(checks.openedLabel ?? '', /后台任务|job/i)
  assert.equal(await card.locator('[data-fig-workbench-output-missing]').count(), 0)
  await page.screenshot({ path: join(evidence, 'job-list-open.png') })
  await page.keyboard.press('Escape')
  // Stop it from the card (two presses), as before.
  const stop = card.locator('[data-fig-workbench-jobs] button').filter({ hasText: /^(停止|Stop)$/ })
  await stop.click(); await card.locator('[data-fig-workbench-jobs] button').filter({ hasText: /确认停止|Confirm/ }).click()
  await card.getByText(/没有运行中的任务|Nothing running/).waitFor({ timeout: 20_000 }); checks.jobStopped = true
  checks.repositoryUntouched = git('status', '--porcelain=v1') === 'MM a.txt\n M b.txt\n'
  assert.ok(checks.repositoryUntouched)
  passed = true
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ date: new Date().toISOString().slice(0, 10), scope: 'development-workbench: View output against the real DSH job list, stop from the card, ⋯ menu', status: 'pass', checks,
    not_verified: ['packaged app', 'job output contents (DSH renders them)'] }, null, 2))
  console.log('PASS', JSON.stringify(checks))
} catch (error) { await page?.screenshot({ path: join(evidence, 'failure.png') }); throw error } finally { await app?.close(); await cleanUp(state.profile, passed) }
