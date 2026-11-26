// Reading a long conversation: earlier history loads by itself as the reader scrolls up (no 「加载更早」 click), and
// DSH's turn rail shows at the left edge in Fig's usual layout (right sidebar open), clear of the text, with its
// hover preview to its right. Offline: a synthetic model answers 60 turns; Fig restarts so only the newest page loads.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolatedProfile, launchFig, workbenchPage, cleanUp, until } from '../scripts/isolated-fig.mjs'
import { evidenceDir, insertProbes, openWorkbench, writeResult } from './helpers/fig-smoke.mjs'

const evidence = await evidenceDir('transcript-reading')
const state = await isolatedProfile('transcript-reading', { extraEnv: root => ({ GROK_HOME: join(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok/auth.json'), CODEX_HOME: join(root, 'codex') }) })
await insertProbes(state, ['handoff-probe', 'activity-probe'])
const turns = 60
let app, page, passed = false
const checks = {}
const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({ prefix, endpoint, payload }) => (await fetch(prefix + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json(), { prefix, endpoint, payload }).then(result => {
  assert.ok(result.ok, JSON.stringify(result.error))
  return result.value
})
try {
  app = await launchFig(state.env); page = await openWorkbench(app)
  const parent = await rpc('/handoff-probe', 'parent', { workspacePath: state.workspace, cwd: state.workspace, preset: 'workspace-write', title: 'Long conversation', route: { provider: 'synthetic-activity', model: 'offline' } })
  for (let i = 1; i <= turns; i++) {
    await rpc('/activity-probe', 'configure', { text: `Reply ${i}\n\n` + 'Lorem ipsum dolor sit amet. '.repeat(30) })
    await rpc('/handoff-probe', 'followup', { id: parent.id, text: `Question ${i}` })
    await page.waitForTimeout(100)
    await until(async () => !(await rpc('/handoff-probe', 'state', { id: parent.id })).running, { timeout: 20_000, interval: 100, message: `turn ${i}` })
  }
  // A fresh page loads only the newest window of the session.
  await app.close(); app = await launchFig(state.env); page = await workbenchPage(app)
  await page.setViewportSize({ width: 1440, height: 900 })
  const row = page.locator(`[data-row-key="session:${parent.id}"]`)
  await page.waitForTimeout(1500)
  if (!await row.isVisible()) await page.locator(`[data-row-key="workspace:${parent.workspaceId}"]`).click()
  await row.click()
  const main = page.locator('[data-slot="main.conversation"]')
  const scroller = main.locator('[data-conversation-scroll]').first()
  const older = main.locator('[class*="_older"] > button')
  const questions = () => main.getByText(/^Question \d+$/).allInnerTexts().then(list => list.map(item => Number(item.split(' ')[1])))
  await main.getByText(`Question ${turns}`, { exact: true }).waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1500)

  // Opened at the end and following it: nothing loads by itself.
  const first = await questions()
  checks.initialEarliest = Math.min(...first)
  assert.ok(checks.initialEarliest > 1, 'the first window must not already hold the whole session')
  await page.waitForTimeout(1500)
  checks.noLoadWhileFollowing = Math.min(...await questions()) === checks.initialEarliest
  assert.ok(checks.noLoadWhileFollowing)

  // The rail: shown at the left edge, clear of the text, preview to its right on hover.
  const rail = main.locator('nav[class*="_frame"]')
  await rail.waitFor({ timeout: 10_000 })
  const box = await page.evaluate(() => {
    const conv = document.querySelector('[data-slot="main.conversation"]')
    const rect = el => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right) } }
    const marks = [...conv.querySelectorAll('nav[class*="_frame"] button[class*="_mark"]')].map(mark => {
      const before = getComputedStyle(mark, '::before'), b = mark.getBoundingClientRect()
      return Math.round(b.left + parseFloat(before.left) + parseFloat(before.width))
    })
    return { scroller: rect(conv.querySelector('[data-conversation-scroll]')), rail: rect(conv.querySelector('nav[class*="_frame"]')),
      marksRight: Math.max(...marks), text: rect(conv.querySelector('[data-chat-node-key]')) }
  })
  checks.rail = box
  assert.ok(box.rail.left - box.scroller.left < 20, 'the rail sits at the left edge')
  assert.ok(box.marksRight <= box.text.left, 'the marks stay clear of the text')
  const mark = rail.locator('button[class*="_mark"]').last()
  await mark.hover()
  const preview = rail.getByRole('tooltip')
  await preview.waitFor({ timeout: 5_000 })
  const previewBox = await preview.boundingBox()
  checks.previewRightOfRail = previewBox.x >= box.rail.right
  assert.ok(checks.previewRightOfRail)
  checks.previewText = (await preview.innerText()).split('\n')[0]
  assert.match(checks.previewText, /^Question \d+$/)
  // Past DSH's 120ms enter animation, the card is opaque over the text.
  await page.waitForTimeout(400)
  checks.previewOpaque = await preview.evaluate(card => getComputedStyle(card).opacity === '1')
  assert.ok(checks.previewOpaque)
  await page.screenshot({ path: join(evidence, 'rail-preview.png') })
  await page.mouse.move(700, 450)

  // Scrolling up loads every earlier page without the button being pressed.
  let clicked = false
  await page.exposeFunction('figOlderClicked', () => { clicked = true })
  await page.evaluate(() => document.querySelector('[data-slot="main.conversation"] [class*="_older"] > button')?.addEventListener('click', event => { if (event.isTrusted) window.figOlderClicked() }))
  await until(async () => {
    await scroller.hover(); await page.mouse.wheel(0, -4000)
    // At the first turn DSH keeps the row, disabled, as 「已到会话开头」.
    return await older.isDisabled() && (await questions()).includes(1)
  }, { timeout: 90_000, interval: 400, message: 'earlier history did not load by scrolling' })
  checks.reachedFirstTurn = true
  checks.noManualClick = !clicked
  assert.ok(checks.noManualClick)
  await page.screenshot({ path: join(evidence, 'top.png') })

  // Narrow conversation (right sidebar open, small window): the rail still clears the text, or is hidden.
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.waitForTimeout(800)
  checks.narrow = await page.evaluate(() => {
    const conv = document.querySelector('[data-slot="main.conversation"]')
    const nav = conv.querySelector('nav[class*="_frame"]'), text = conv.querySelector('[data-chat-node-key]')
    if (!nav || getComputedStyle(nav).display === 'none') return { shown: false }
    return { shown: true, clear: nav.getBoundingClientRect().left + 26 <= text.getBoundingClientRect().left }
  })
  assert.ok(!checks.narrow.shown || checks.narrow.clear, JSON.stringify(checks.narrow))
  await page.screenshot({ path: join(evidence, 'narrow.png') })

  passed = true
  await writeResult(evidence, { date: new Date().toISOString().slice(0, 10), scope: 'auto-loading earlier history on scroll and the left turn rail with preview; 60 offline turns, right sidebar open', status: 'pass', checks,
    not_verified: ['packaged app', 'dark theme', 'trackpad momentum scrolling', 'very long real sessions'] })
  console.log('PASS', JSON.stringify(checks))
} catch (error) { await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined); throw error } finally { await app?.close(); await cleanUp(state.profile, passed) }
