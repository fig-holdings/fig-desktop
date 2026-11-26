import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isolatedProfile, launchFig, workbenchPage, cleanUp, until, emergencyReport, launchBundle } from '../scripts/isolated-fig.mjs'

const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11)
assert.ok(evidence); await mkdir(evidence)
const state = await isolatedProfile('attention-native', {attention: true, extraEnv: profile => ({GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: join(profile, 'grok/auth.json')})})
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  {id: 'workspace-controller', config: {documentsDirectory: state.documents}},
  {insert: [{id: 'attention-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url))}]}
]))
const report = {status: 'fail', startedAt: new Date().toISOString(), checks: {}}
let app
emergencyReport(join(evidence, 'result.json'), report, {app: () => app})
try {
  const bundle = process.argv.find(arg => arg.startsWith('--bundle='))?.slice(9)
  app = bundle ? await launchBundle(bundle, state.env) : await launchFig(state.env)
  report.bundle = bundle ?? null
  const page = await workbenchPage(app, 90000)
  await page.getByRole('button', {name: /^(Continue|继续)$/}).click()
  const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({prefix, endpoint, payload}) => {
    return (await fetch(prefix + '/' + endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)})).json()
  }, {prefix, endpoint, payload}).then(r => { assert.ok(r.ok, JSON.stringify(r.error)); return r.value })
  const probe = (endpoint, payload) => rpc('/handoff-probe', endpoint, payload)
  const info = () => rpc('/fig-attention', 'info')
  const wait = check => until(check, {message: 'attention fixture timeout'})
  const {id} = await probe('parent', {workspacePath: state.workspace, preset: 'workspace-write', title: 'Synthetic attention fixture'})
  await probe('followup', {id, text: 'Initialize local fixture only.'})
  await page.getByText('Synthetic attention fixture', {exact: true}).first().click()
  await probe('cancel', {id})
  await wait(async () => (await info()).rows.some(r => r.sessionId === id))
  const audit = await probe('environmentAudit')
  assert.ok(Object.values(audit).every(Boolean)); report.checks.environment = audit
  assert.deepEqual(await probe('credentialAtomic'), {deleted: true}); report.checks.realCredentialSerialization = true
  const isolation = await page.evaluate(() => ({node: typeof window.require, preload: typeof window.fig, capability: 'FIG_ATTENTION_CAPABILITY' in window}))
  assert.deepEqual(isolation, {node: 'undefined', preload: 'undefined', capability: false}); report.checks.rendererIsolation = isolation
  const navigationId = 'synthetic-navigation'
  const ack = await page.evaluate(({id, navigationId}) => window.__figAttentionNavigate({sessionId: id, navigationId, eventIdentity: 'synthetic'}), {id, navigationId})
  assert.deepEqual(ack, {navigationId, accepted: true}); report.checks.publicNavigation = true
  await probe('hold', {id})
  await probe('followup', {id, text: 'Hold native turn without model call.'})
  await wait(async () => (await probe('held', {id})).entries.length > 0)
  if (process.argv.includes('--os-observe')) {
    await app.evaluate(({Notification, BrowserWindow}) => {
      globalThis.__figNotificationEvidence = []
      const original = Notification.prototype.show
      Notification.prototype.show = function () {
        globalThis.__figNotificationEvidence.push({event: 'scheduled', silent: this.silent})
        for (const kind of ['show', 'failed', 'click']) this.on(kind, (_event, error) => globalThis.__figNotificationEvidence.push({event: kind, error: error ? String(error).slice(0, 200) : undefined}))
        return original.call(this)
      }
      BrowserWindow.getAllWindows()[0].minimize()
    })
  }
  await probe('attentionPending', {id})
  await wait(async () => (await info()).rows.find(r => r.sessionId === id)?.pendingKinds.includes('approval'))
  await wait(async () => await app.evaluate(({app}) => app.dock.getBadge()) === '1')
  report.checks.nativeApprovalDock = true
  if (process.argv.includes('--os-observe')) {
    await delay(2200)
    report.systemNotification = {status: 'blocked', reason: 'System UI automation unavailable; permission denial/grant and actual click not visually verified', events: await app.evaluate(() => globalThis.__figNotificationEvidence)}
    await app.evaluate(({BrowserWindow}) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); window.focus() })
  }
  await probe('attentionPending', {id, cancel: true})
  await wait(async () => await app.evaluate(({app}) => app.dock.getBadge()) === '')
  await probe('cancel', {id})
  await app.evaluate(({Menu}) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('button', {name: '通用设置', exact: true}).click()
  const toggle = page.getByRole('switch', {name: '后台重要变化通知', exact: true})
  await wait(() => toggle.isEnabled())
  assert.equal(await toggle.isChecked(), true)
  await toggle.uncheck()
  await wait(async () => !(await info()).preferences.notifications)
  const saved = JSON.parse(await readFile(join(state.dshHome, 'fig/attention/preferences.json'), 'utf8'))
  assert.equal(saved.notifications, false); report.checks.preferencePersisted = true
  const suppression = await page.evaluate(() => window.__figAttentionContext())
  assert.equal(suppression.visible, false); report.checks.settingsNotForegroundConversation = true
  await page.screenshot({path: join(evidence, 'attention-settings-light.png')})
  await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('[data-slot="sidebar"]').getByRole('button', {name: /^(登录|Sign in)$/}).click()
  await page.getByRole('menuitem', {name: '主题外观'}).hover()
  await page.getByRole('menuitemradio', {name: '深色'}).click()
  await app.evaluate(({Menu}) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('button', {name: '通用设置', exact: true}).click()
  await page.screenshot({path: join(evidence, 'attention-settings-dark.png')})
  report.checks.darkThemeRendered = true
  report.status = 'pass'
} catch (error) { report.error = String(error.stack ?? error); throw error }
finally {
  report.finishedAt = new Date().toISOString(); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  if (app) await app.close().catch(() => {})
  await cleanUp(state.profile, report.status === 'pass')
}
