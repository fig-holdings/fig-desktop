import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isolatedProfile, launchFig, workbenchPage, cleanUp, until } from '../scripts/isolated-fig.mjs'

const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
assert.ok(evidence, 'Require a new --evidence directory')
await mkdir(evidence)
const state = await isolatedProfile('queue-native', { extraEnv: profile => ({ GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: join(profile, 'grok/auth.json') }) })
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: state.documents } },
  { insert: [{ id: 'queue-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url)) }] }
]))
const report = { startedAt: new Date().toISOString(), status: 'fail', cases: [] }
let app
try {
  app = await launchFig(state.env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  const rpc = (endpoint, payload) => page.evaluate(async ({ endpoint, payload }) => {
    const result = await (await fetch('/handoff-probe/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json()
    return result
  }, { endpoint, payload }).then(result => { assert.ok(result.ok, `[${result.error?.code}] ${result.error?.message}`); return result.value })
  const wait = check => until(check, { interval: 30, message: 'queue fixture timed out' })
  const { id } = await rpc('parent', { workspacePath: state.workspace, preset: 'workspace-write', title: 'Synthetic queue fixture' })
  // Admit one native input so the ordinary sidebar indexes the session. The catalog-only local
  // placeholder cannot call a real model; cancel it before installing the controlled step gate.
  await rpc('followup', { id, text: 'Initialize the synthetic native UI fixture.' })
  const row = page.getByText('Synthetic queue fixture', { exact: true }).first()
  if (!await row.isVisible().catch(() => false)) await page.getByText('默认工作区', { exact: true }).first().click()
  await row.click({ timeout: 10000 })
  await rpc('cancel', { id })
  await wait(async () => !(await rpc('state', { id })).running)
  await rpc('hold', { id })
  const prompt = (text, requestId = randomUUID(), mode = 'queue') => rpc('prompt', { id, requestId, mode, content: [{ type: 'text', text }] })
  await prompt('CLAIMED-FIRST')
  await wait(async () => (await rpc('held', { id })).entries.length > 0)
  const claimed = (await rpc('held', { id })).entries[0].find(message => JSON.stringify(message.content).includes('CLAIMED-FIRST'))
  await assert.rejects(rpc('updateQueue', { id, itemId: claimed.id, action: { kind: 'remove' } }), /queue-item-not-found|no longer pending/)
  const requestId = randomUUID()
  await prompt('QUEUED-SYNTHETIC', requestId)
  await prompt('QUEUED-SYNTHETIC', requestId)
  let snapshot = await rpc('state', { id })
  const item = snapshot.queue.find(item => item.rpcId === requestId)
  assert.ok(item)
  assert.equal(snapshot.queue.filter(item => item.rpcId === requestId).length, 1)
  await rpc('updateQueue', { id, itemId: item.id, action: { kind: 'edit', content: [{ type: 'text', text: 'EDITED-SYNTHETIC' }] } })
  await assert.rejects(rpc('updateQueue', { id, itemId: item.id, action: { kind: 'edit', content: [{ type: 'text', text: ' ' }] } }))
  await rpc('updateQueue', { id, itemId: item.id, action: { kind: 'steer' } })
  snapshot = await rpc('state', { id })
  assert.equal(snapshot.queue.find(q => q.id === item.id).placement, 'steering')
  const removeId = randomUUID()
  await prompt('REMOVABLE-SYNTHETIC', removeId)
  const removable = (await rpc('state', { id })).queue.find(q => q.rpcId === removeId)
  await rpc('updateQueue', { id, itemId: removable.id, action: { kind: 'remove' } })
  await assert.rejects(rpc('updateQueue', { id, itemId: removable.id, action: { kind: 'remove' } }), /queue-item-not-found|no longer pending/)
  const editor = page.locator('[data-lexical-editor="true"][contenteditable="true"]').last()
  await editor.fill('UI-QUEUE-BY-ENTER')
  await editor.press('Shift+Enter')
  assert.match(await editor.innerText(), /UI-QUEUE-BY-ENTER/)
  await page.getByRole('button', { name: '排队发送', exact: true }).and(page.locator('button[aria-busy]')).waitFor()
  await editor.press('Enter')
  await wait(async () => (await rpc('state', { id })).queue.some(q => q.placement === 'queued' && JSON.stringify(q.content).includes('UI-QUEUE-BY-ENTER')))
  await page.locator('[data-fig-stop-queue-note]').waitFor({ timeout: 5000 })
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('button', { name: '通用设置', exact: true }).click()
  await page.getByRole('button', { name: '排队发送', exact: true }).click()
  await page.getByText('插话发送', { exact: true }).click()
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '关闭', exact: true }).click()
  await editor.fill('UI-STEER-BY-ENTER')
  await page.getByRole('button', { name: '插话发送', exact: true }).and(page.locator('button[aria-busy]')).waitFor()
  await editor.press('Enter')
  await wait(async () => (await rpc('state', { id })).queue.some(q => q.placement === 'steering' && JSON.stringify(q.content).includes('UI-STEER-BY-ENTER')))
  await editor.fill('UI-QUEUE-BY-ACCELERATED')
  await editor.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  await wait(async () => (await rpc('state', { id })).queue.some(q => q.placement === 'queued' && JSON.stringify(q.content).includes('UI-QUEUE-BY-ACCELERATED')))
  await page.locator('input[type="file"]').last().setInputFiles({ name: 'queue-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('SYNTHETIC-ATTACHMENT') })
  await page.getByText('queue-fixture.txt', { exact: true }).first().waitFor({ timeout: 10000 })
  await editor.fill('FAILED-DRAFT-WITH-ATTACHMENT')
  const primary = page.getByRole('button', { name: '插话发送', exact: true }).and(page.locator('button[aria-busy]'))
  await primary.waitFor({ timeout: 10000 })
  await wait(() => primary.isEnabled())
  await rpc('rejectNext', { id })
  await primary.click()
  await wait(async () => (await rpc('rejectedPrompts', {})) === 1)
  await wait(async () => (await editor.innerText()).trim() === 'FAILED-DRAFT-WITH-ATTACHMENT')
  assert.ok(await page.getByText('queue-fixture.txt', { exact: true }).count() > 0, 'failed submit must retain the attachment chip')
  await editor.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  await wait(async () => (await rpc('state', { id })).queue.some(q => JSON.stringify(q.content).includes('FAILED-DRAFT-WITH-ATTACHMENT')))
  const attached = (await rpc('state', { id })).queue.find(q => JSON.stringify(q.content).includes('FAILED-DRAFT-WITH-ATTACHMENT'))
  assert.ok(attached.content.some(part => part.type !== 'text'), 'accepted retry must carry the actual attachment reference')
  const dock = page.locator('[data-queue-dock]')
  const collapsed = dock.locator('button[aria-expanded="false"]')
  if (await collapsed.count()) await collapsed.click()
  const attachedRow = dock.getByRole('listitem').filter({ has: page.getByText('queue-fixture.txt', { exact: true }) })
  assert.equal(await attachedRow.count(), 1)
  assert.equal(await attachedRow.getByRole('button', { name: '编辑排队消息', exact: true }).isDisabled(), true, 'attachment rows must not offer the native text-only replacement action')
  report.ui = { enterQueue: true, shiftNewline: true, preferenceSteer: true, acceleratedQueue: true, failedDraftAndAttachmentRetained: true, attachedQueueEditDisabled: true }
  await page.screenshot({ path: join(evidence, 'queue-ui.png') })
  const keepId = randomUUID()
  await prompt('KEEP-AFTER-CANCEL', keepId)
  const beforeCancel = await rpc('state', { id })
  await rpc('cancel', { id })
  await delay(200)
  const afterCancel = await rpc('state', { id }), held = await rpc('held', { id })
  assert.ok(afterCancel.queue.some(q => q.rpcId === keepId) || held.entries.some(messages => messages.some(m => m.source?.rpcId === keepId)), 'cancel must retain queued input, whether still pending or already admitted to the next native turn')
  report.beforeCancel = beforeCancel; report.afterCancel = afterCancel; report.held = held
  report.cases.push({ id: 'request-idempotency-edit-steer-remove-race', status: 'pass' }, { id: 'cancel-keeps-inbox-and-reports-actual-state', status: 'pass' })
  report.cases.push({ id: 'native-keyboard-preference-failure-and-attachments', status: 'pass' })
  report.status = 'pass'
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  await app?.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  await cleanUp(state.profile, report.status === 'pass')
  console.log(report.status + ': native queue controller; no real model calls')
}
