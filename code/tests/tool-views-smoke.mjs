// Fig's own tool rows in the conversation (DSH's keyed `tool.call.toolview` slot): preview's thumbnails, the handed-off
// session's status and Open button, and the delegated review's findings. Offline: a synthetic model asks for each tool
// in a native turn, preview captures a local file, and a stand-in `codex` on PATH answers the delegation.
import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { isolatedProfile, launchFig, cleanUp, until } from '../scripts/isolated-fig.mjs'
import { evidenceDir, insertProbes, openWorkbench, writeResult } from './helpers/fig-smoke.mjs'

const evidence = await evidenceDir('tool-views')
const state = await isolatedProfile('tool-views', { extraEnv: root => ({ GROK_HOME: join(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok/auth.json'), CODEX_HOME: join(root, 'codex'),
  PATH: join(root, 'bin') + delimiter + process.env.PATH }) })
await insertProbes(state, ['handoff-probe', 'toolview-probe'])
await writeFile(join(state.dshHome, 'fig/next-step.json'), JSON.stringify({ enabled: false }))
// The stand-in external agent: writes a fixed review to the file `codex exec -o` names.
await mkdir(join(state.profile, 'bin'))
await writeFile(join(state.profile, 'bin/codex'), `#!/bin/sh
out=""
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done
cat > /dev/null
[ -n "$out" ] && printf 'Two problems.\\n\\nFINDINGS\\n[low] page.html - missing lang attribute\\n[high] page.html:3 - content is wider than the viewport\\n' > "$out"
exit 0
`)
await chmod(join(state.profile, 'bin/codex'), 0o755)
await mkdir(state.workspace, { recursive: true })
await writeFile(join(state.workspace, 'page.html'), '<!doctype html><meta charset="utf-8"><title>Tool view fixture</title>\n<body style="margin:0">\n<div style="width:2000px;height:40px;background:#c63">wide</div><p>Synthetic page</p>\n')

let app, page, passed = false
const checks = {}
const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({ prefix, endpoint, payload }) => (await fetch(prefix + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json(), { prefix, endpoint, payload }).then(result => {
  assert.ok(result.ok, JSON.stringify(result.error))
  return result.value
})
const probe = (endpoint, payload) => rpc('/handoff-probe', endpoint, payload)
try {
  app = await launchFig(state.env); page = await openWorkbench(app)
  await page.setViewportSize({ width: 1440, height: 900 })
  const parent = await probe('parent', { workspacePath: state.workspace, cwd: state.workspace, preset: 'workspace-write', title: 'Tool view probe', route: { provider: 'synthetic-toolview', model: 'offline' } })
  const turn = async (name, args, timeout = 60_000) => {
    await rpc('/toolview-probe', 'queue', { name, args })
    await probe('followup', { id: parent.id, text: 'Synthetic: call ' + name })
    await page.waitForTimeout(500)
    await until(async () => !(await probe('state', { id: parent.id })).running, { timeout, interval: 300, message: name + ' turn did not finish' })
  }
  await turn('preview', { target: 'page.html' })
  await turn('handoff_session', { title: 'Tool view child', prompt: 'Synthetic child. Reply only.' })
  await turn('delegate_agent', { agent: 'codex', task: 'Synthetic review of page.html.' })

  const group = page.locator(`[data-row-key="workspace:${parent.workspaceId}"]`); await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.locator(`[data-row-key="session:${parent.id}"]`).click()
  const row = tool => page.locator(`[data-conversation-session="${parent.id}"] [data-fig-tool-view="${tool}"]`)

  // DSH folds a finished turn's steps under 「已完成，用时…」; the rows are inside, so each turn is opened first.
  const folds = page.locator(`[data-conversation-session="${parent.id}"]`).getByText(/^(已完成，用时|Worked for)/)
  await until(async () => await folds.count() === 3, { timeout: 30_000, message: 'three finished turns expected' })
  checks.hiddenWhileFolded = !await row('preview').isVisible()
  for (let index = 0; index < 3; index++) await folds.nth(index).click()
  // Inside, a step's calls are grouped under 「已调用工具」, closed again.
  const groups = page.locator(`[data-conversation-session="${parent.id}"]`).getByText(/^(已调用工具|Called tools?|Used tools?)/)
  await until(async () => await groups.count() === 3, { timeout: 10_000, message: 'three tool groups expected' })
  for (let index = 0; index < 3; index++) await groups.nth(index).click()

  // preview: one thumbnail per default width, each a loaded image; the wide block is reported in the header.
  await row('preview').waitFor({ timeout: 30_000 })
  await until(async () => await row('preview').locator('[data-fig-preview-shot] img').count() === 2, { timeout: 20_000, message: 'preview thumbnails did not load' })
  checks.previewShots = await row('preview').locator('[data-fig-preview-shot] img').evaluateAll(images => images.map(image => image.complete && image.naturalWidth > 0))
  assert.deepEqual(checks.previewShots, [true, true])
  checks.previewSummary = await row('preview').locator('.fig-tool-summary').innerText()
  assert.match(checks.previewSummary, /^page\.html · /)
  assert.match(checks.previewSummary, /横向溢出/)
  await row('preview').locator('.fig-tool-toggle').click()
  checks.previewText = /HORIZONTAL OVERFLOW/.test(await row('preview').locator('.fig-tool-text').innerText())
  assert.ok(checks.previewText)

  // delegate: the stand-in's findings, high first, with the line in the link.
  await row('delegate_agent').locator('.fig-tool-toggle').click()
  checks.findings = await row('delegate_agent').locator('[data-fig-finding]').evaluateAll(items => items.map(item => item.getAttribute('data-fig-finding') + ' ' + item.querySelector('.fig-tool-link').textContent))
  assert.deepEqual(checks.findings, ['high page.html:3', 'low page.html'])
  checks.delegateSummary = await row('delegate_agent').locator('.fig-tool-summary').innerText()
  assert.match(checks.delegateSummary, /Codex · 2 条发现/)
  await page.screenshot({ path: join(evidence, 'rows-light.png') })

  // A finding opens its file in the right sidebar; a thumbnail opens the screenshot.
  await row('delegate_agent').locator('.fig-tool-link').first().click()
  checks.findingOpensFile = await page.getByText('page.html').count() > 1
  await row('preview').locator('[data-fig-preview-shot]').first().click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(evidence, 'screenshot-opened.png') })

  // handoff: the child's title, a settled status, and Open switches the conversation to it.
  const handoff = row('handoff_session')
  checks.handoffSummary = await handoff.locator('.fig-tool-summary').innerText()
  assert.match(checks.handoffSummary, /Tool view child/)
  const child = await handoff.locator('[data-fig-handoff-open]').getAttribute('data-fig-handoff-open')
  await until(async () => await handoff.locator('[data-fig-handoff-status]').getAttribute('data-fig-handoff-status') === 'stopped', { timeout: 30_000, message: 'the child did not settle' })
  await handoff.locator('[data-fig-handoff-open]').click()
  await page.locator(`[data-slot="main.conversation"] [data-conversation-session="${child}"]`).waitFor({ timeout: 20_000 })
  checks.handoffOpens = true

  passed = true
  await writeResult(evidence, { date: new Date().toISOString().slice(0, 10), scope: 'Fig tool rows for preview, handoff_session and delegate_agent in a native conversation; offline model, stand-in codex', status: 'pass', checks,
    not_verified: ['packaged app', 'real model turns', 'real Codex or Claude Code answers', 'dark theme and narrow width'] })
  console.log('PASS', JSON.stringify(checks))
} catch (error) { await page?.screenshot({ path: join(evidence, 'failure.png') }); throw error } finally { await app?.close(); await cleanUp(state.profile, passed) }
