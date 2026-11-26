import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedProfile, launchFig, workbenchPage, cleanUp, until } from '../scripts/isolated-fig.mjs'
const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11); assert.ok(evidence); await mkdir(evidence)
const state = await isolatedProfile('rules-native', {extraEnv: p => ({GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json')})})
const project = join(state.documents, 'projects/probe')
await mkdir(join(project, '.git'), {recursive: true})
await writeFile(join(state.documents, 'AGENTS.md'), 'SYNTHETIC-BROAD')
await writeFile(join(state.documents, 'projects/AGENTS.md'), 'SYNTHETIC-MIDDLE')
await writeFile(join(project, 'AGENTS.md'), 'SYNTHETIC-PROJECT')
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([{id: 'workspace-controller', config: {documentsDirectory: state.documents}}, {insert: [{id: 'probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url))}]}]))
const report = {status: 'fail', startedAt: new Date().toISOString()}; let app, page
try {
  app = await launchFig(state.env); page = await workbenchPage(app)
  await page.getByRole('button', {name: /^(继续|Continue)$/}).click()
  const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({prefix, endpoint, payload}) => (await fetch(prefix + '/' + endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)})).json(), {prefix, endpoint, payload}).then(r => {assert.ok(r.ok, JSON.stringify(r.error)); return r.value})
  const probe = (e, p) => rpc('/handoff-probe', e, p)
  const {id} = await probe('parent', {workspacePath: project, cwd: project, preset: 'workspace-write', title: 'Synthetic rules fixture'})
  await probe('followup', {id, text: 'Initialize local fixture; no real model.'})
  if (!await page.getByText('Synthetic rules fixture', {exact: true}).isVisible().catch(() => false)) await page.getByText('probe', {exact: true}).first().click()
  await page.getByText('Synthetic rules fixture', {exact: true}).first().click()
  const info = () => rpc('/fig-rule-sources', 'info', {sessionId: id})
  const wait = fn => until(fn, {timeout: 15000, message: 'rules fixture timeout'})
  await wait(async () => (await info()).status === 'matching')
  const before = await info(); assert.equal(before.injected.length, 2); assert.equal(before.nativeProject, 'unknown')
  const opener = page.locator('[class*="viewsMoreAnchor"] button').first()
  await opener.click()
  await page.getByRole('menuitem', {name: '规则来源', exact: true}).click()
  const modal = page.getByRole('dialog', {name: '规则来源', exact: true})
  await modal.getByText('Fig共享规则与最近注入版本一致。', {exact: true}).waitFor()
  await modal.getByText('来源无法结构化确认；此清单不推测项目层是否已注入。', {exact: true}).waitFor()
  await page.screenshot({path: join(evidence, 'rules-matching.png')})
  await writeFile(join(state.documents, 'AGENTS.md'), 'SYNTHETIC-CHANGED')
  await modal.getByRole('button', {name: '刷新清单'}).click()
  await modal.getByText(/当前文件已变化/).waitFor()
  assert.equal((await info()).injected[0].contentDigest, before.injected[0].contentDigest)
  await page.screenshot({path: join(evidence, 'rules-changed.png')})
  await page.keyboard.press('Escape'); await modal.waitFor({state: 'hidden'})
  await wait(() => opener.evaluate(e => e === document.activeElement))
  report.status = 'pass'; report.checks = {structuredSource: true, staleVersionShown: true, nativeUnknown: true, keyboardCloseAndFocus: true}
} catch (error) {report.error = String(error.stack ?? error); await page?.screenshot({path: join(evidence, 'failure.png')}).catch(() => {}); process.exitCode = 1}
finally {report.finishedAt = new Date().toISOString(); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2)); await app?.close().catch(() => {}); await cleanUp(state.profile, report.status === 'pass')}
