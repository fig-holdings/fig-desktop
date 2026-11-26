// The next-step hint: after a turn, composer asks the session's model for the user's likely next message, with the
// earlier exchanges as context, and shows it greyed in the empty composer in place of the placeholder; Tab fills it in;
// an empty answer shows nothing; turned off in settings, nothing is asked. Offline: a synthetic model returns fixed
// replies and a fixed suggestion. How good real models' suggestions are is not covered.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolatedProfile, launchFig, cleanUp, until } from '../scripts/isolated-fig.mjs'
import { evidenceDir, insertProbes, openWorkbench, writeResult } from './helpers/fig-smoke.mjs'

const evidence = await evidenceDir('next-step')
const state = await isolatedProfile('next-step', { extraEnv: root => ({ GROK_HOME: join(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok/auth.json'), CODEX_HOME: join(root, 'codex') }) })
await insertProbes(state, ['handoff-probe', 'activity-probe'])

let app, page, passed = false
const checks = {}
const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({ prefix, endpoint, payload }) => (await fetch(prefix + '/' + endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json(), { prefix, endpoint, payload }).then(result => {
  assert.ok(result.ok, JSON.stringify(result.error))
  return result.value
})
try {
  app = await launchFig(state.env); page = await openWorkbench(app)
  await page.setViewportSize({ width: 1440, height: 900 })
  const parent = await rpc('/handoff-probe', 'parent', { workspacePath: state.workspace, cwd: state.workspace, preset: 'workspace-write', title: 'Next step probe', route: { provider: 'synthetic-activity', model: 'offline' } })
  const turn = async (reply, suggest = '') => {
    await rpc('/activity-probe', 'configure', { text: reply, suggest })
    await rpc('/handoff-probe', 'followup', { id: parent.id, text: 'Synthetic turn' })
    await page.waitForTimeout(500)
    await until(async () => !(await rpc('/handoff-probe', 'state', { id: parent.id })).running, { timeout: 30_000, interval: 200, message: 'the turn did not finish' })
  }

  // A session appears in the sidebar with its first message, so the first turn runs before it is opened.
  await turn('先热身一轮。', '')
  await turn('已改好登录页。要我跑一下测试吗？', '跑一下测试')
  const group = page.locator(`[data-row-key="workspace:${parent.workspaceId}"]`); await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.locator(`[data-row-key="session:${parent.id}"]`).click()
  const conversation = page.locator(`[data-slot="main.conversation"] [data-conversation-session="${parent.id}"]`)
  await conversation.waitFor()
  const editor = conversation.locator('[data-lexical-editor="true"]').last()
  const hint = conversation.locator('[data-composer-placeholder][data-fig-next-step]')
  // Lexical ignores fill(''); the draft is cleared the way a user clears it.
  const clear = async () => { await editor.click(); await editor.press('Meta+A'); await editor.press('Backspace') }
  // The generated suggestion replaces the placeholder text, with no Tab label; the call saw the earlier exchange.
  await hint.waitFor({ timeout: 15_000 })
  checks.hint = await hint.getAttribute('data-fig-next-step')
  assert.equal(checks.hint, '跑一下测试')
  checks.shownText = await hint.evaluate(element => getComputedStyle(element, '::before').content)
  assert.equal(checks.shownText, '"跑一下测试"')
  const prompt = await rpc('/activity-probe', 'suggestPrompt')
  checks.earlierInPrompt = /Earlier exchange 1:[\s\S]*先热身一轮。[\s\S]*User's last message:[\s\S]*要我跑一下测试吗？/.test(prompt)
  assert.ok(checks.earlierInPrompt, prompt)
  checks.replyClean = !await conversation.getByText(/建议回复/).count()
  assert.ok(checks.replyClean)
  await page.screenshot({ path: join(evidence, 'hint.png') })
  await editor.click()
  await editor.press('Tab')
  checks.tabFills = (await editor.innerText()).trim()
  assert.equal(checks.tabFills, '跑一下测试')
  assert.equal(await hint.count(), 0, 'taken once')
  await clear()

  // An empty suggestion shows nothing.
  await turn('已跑完测试，全部通过。', '')
  await page.waitForTimeout(1500)
  checks.noLineNoHint = await hint.count() === 0
  assert.ok(checks.noLineNoHint)

  // A later reply's suggestion replaces the earlier one.
  await turn('Done. Shall I commit?', 'Commit the change')
  await hint.waitFor({ timeout: 15_000 })
  await editor.click(); await editor.press('Tab')
  checks.englishFills = (await editor.innerText()).trim()
  assert.equal(checks.englishFills, 'Commit the change')
  await clear()

  // Turned off: the same reply shows nothing.
  assert.deepEqual(await rpc('/fig-composer', 'next-step/enable', { enabled: false }), { enabled: false })
  await turn('好了。', '继续')
  await page.waitForTimeout(1500)
  checks.offNoHint = await hint.count() === 0
  assert.ok(checks.offNoHint)

  passed = true
  await writeResult(evidence, { date: new Date().toISOString().slice(0, 10), scope: 'composer: generated next-step hint with earlier exchanges as context, in the empty input; Tab, empty answer, switch off. Offline synthetic model', status: 'pass', checks,
    not_verified: ['quality of real models\' suggestions', 'packaged app', 'dark theme and narrow width'] })
  console.log('PASS', JSON.stringify(checks))
} catch (error) { await page?.screenshot({ path: join(evidence, 'failure.png') }); throw error } finally { await app?.close(); await cleanUp(state.profile, passed) }
