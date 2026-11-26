// Interactive OS gate: commands are test control only; all notification/permission clicks are observed through CUA.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isolatedProfile, workbenchPage, cleanUp, until, emergencyReport, launchBundle } from '../scripts/isolated-fig.mjs'
const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11), bundle = process.argv.find(a => a.startsWith('--bundle='))?.slice(9)
assert.ok(evidence && bundle)
await mkdir(evidence)
const state = await isolatedProfile('notification-os', { attention: true, extraEnv: p => ({ GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json') }) })
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: state.documents } }, { insert: [{ id: 'probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url)) }] }
]))
const report = {
  status: 'running', scope: 'Signed isolated verification app, synthetic pending approval only, no model/credentials; OS observations are separately recorded', bundle, startedAt: new Date().toISOString(), commands: []
}
let app, page, id
emergencyReport(join(evidence, 'result.json'), report, { app: () => app })
const wait = fn => until(fn, { message: 'OS native fixture timeout' })
try {
  app = await launchBundle(bundle, state.env)
  page = await workbenchPage(app, 90000)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click()
  const rpc = async (prefix, endpoint, payload = {}) => {
    const r = await page.evaluate(async ({ prefix, endpoint, payload }) => (await fetch(prefix + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json(), { prefix, endpoint, payload })
    assert.ok(r.ok, JSON.stringify(r.error))
    return r.value
  }
  const probe = (e, p) => rpc('/handoff-probe', e, p)
  ;({ id } = await probe('parent', { workspacePath: state.workspace, preset: 'workspace-write', title: 'Synthetic notification target' }))
  await probe('hold', { id })
  await probe('followup', { id, text: 'Hold synthetic offline turn for notification gate.' })
  await wait(async () => (await probe('held', { id })).entries.length > 0)
  await app.evaluate(({ Notification, BrowserWindow }) => {
    globalThis.__notificationEvents = []
    const show = Notification.prototype.show
    Notification.prototype.show = function () {
      globalThis.__notificationEvents.push({ event: 'schedule', silent: this.silent })
      for (const event of ['show', 'failed', 'click'])
        this.on(event, () => globalThis.__notificationEvents.push({ event }))
      return show.call(this)
    }
    for (const window of BrowserWindow.getAllWindows()) window.minimize()
  })
  const snapshot = async () => ({
    sessionId: id, badge: await app.evaluate(({ app }) => app.dock.getBadge()), notifications: await app.evaluate(() => globalThis.__notificationEvents), target: await page.evaluate(() => ({
      sessionId: document.querySelector('[data-slot="main.conversation"] [data-conversation-session]')?.getAttribute('data-conversation-session'), context: window.__figAttentionContext?.()
    })), focused: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isFocused()))
  })
  await writeFile(join(evidence, 'ready.json'), JSON.stringify({ sessionId: id, profile: state.profile, bundle, readyAt: new Date().toISOString() }))
  console.log('READY')
  for (let seq = 1, end = Date.now() + 15 * 60000; Date.now() < end;) {
    const file = join(evidence, 'command-' + seq + '.json')
    let cmd
    try {
      cmd = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      await delay(150)
      continue
    }
    if (cmd.action === 'request') {
      await probe('attentionPending', { id, cancel: true })
      await delay(1300)
      await probe('attentionPending', { id })
      await wait(async () => (await rpc('/fig-attention', 'info')).rows.find(r => r.sessionId === id)?.pendingKinds.includes('approval'))
      await wait(async () => await app.evaluate(({ app }) => app.dock.getBadge()) === '1')
      await delay(1400)
    } else if (cmd.action === 'clear') {
      await probe('attentionPending', { id, cancel: true })
      await wait(async () => await app.evaluate(({ app }) => app.dock.getBadge()) === '')
    } else if (cmd.action === 'background') {
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.minimize()
      })
    } else if (!['snapshot', 'finish'].includes(cmd.action)) throw Error('Unknown fixture command')
    const value = { seq, action: cmd.action, at: new Date().toISOString(), ...await snapshot() }
    report.commands.push(value)
    await writeFile(join(evidence, 'response-' + seq + '.json'), JSON.stringify(value, null, 2))
    console.log('COMMAND', seq, cmd.action)
    seq++
    if (cmd.action === 'finish') {
      report.status = 'observed'
      break
    }
  }
  if (report.status === 'running') throw Error('OS observation fixture deadline reached')
  await probe('attentionPending', { id, cancel: true })
  await probe('cancel', { id })
} catch (e) {
  report.status = 'fail'
  report.error = String(e.stack ?? e)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
  await cleanUp(state.profile, report.status === 'observed')
}
