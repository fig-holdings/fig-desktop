import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isolatedProfile, launchFig, workbenchPage, cleanUp, until, emergencyReport } from '../scripts/isolated-fig.mjs'
import { isolatedDevEnvironment } from '../scripts/dev-isolation.mjs'
const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11)
assert.ok(evidence)
await mkdir(evidence)
const state = await isolatedProfile('activity-native', { base: isolatedDevEnvironment(),
  extraEnv: p => ({ GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json'), CODEX_HOME: join(p, 'codex') }) })
await writeFile(join(state.dshHome, 'fig/attention/preferences.json'), JSON.stringify({ schema: 1, notifications: false, dock: true }))
await writeFile(join(state.dshHome, 'fig/next-step.json'), JSON.stringify({ enabled: false }))
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: state.documents } }, {
    insert: [
      { id: 'handoff-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url)) }, { id: 'activity-probe', name: fileURLToPath(new URL('./fixtures/activity-probe.mjs', import.meta.url)) }
    ]
  }
]))
const expected = [
  'four-groups', 'project-global-count', 'batch-identity-race', 'pending-running-overlap', 'failure-dock-ack', 'restart-persistence', 'card-not-read', 'foreground-result-read', 'overlay-not-read',
  'structured-quota', 'known-undo-new-event', 'covered-window-not-read', 'snooze-write-failure', 'snooze-restart-expiry', 'archive-membership', 'light-dark-narrow'
]
const report = {
  status: 'fail', expectedScenarioIds: expected, results: [], scope: 'Deterministic offline adapter; actual native turns, approval, public slots/navigation, Host persistence and Electron Dock', startedAt: new Date().toISOString()
}
let app, page, first = true
emergencyReport(join(evidence, 'result.json'), report, {
  app: () => app,
  prepare: () => {
    for (const id of expected)
      if (!report.results.some(r => r.id === id))
        report.results.push({ id, status: 'fail', reason: 'Uncaught test failure' })
  }
})
const wait = (fn, ms = 15000) => until(fn, { timeout: ms, interval: 80, message: 'activity native timeout' })
const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({ prefix, endpoint, payload }) => (await fetch(prefix + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json(), { prefix, endpoint, payload }).then(r => {
  assert.ok(r.ok, JSON.stringify(r.error))
  return r.value
})
const probe = (e, p) => rpc('/handoff-probe', e, p), fixture = (e, p) => rpc('/activity-probe', e, p), info = () => rpc('/fig-attention', 'dynamics')
const record = async (id, fn) => {
  try {
    await fn()
    report.results.push({ id, status: 'pass' })
    console.log('PASS', id)
  } catch (e) {
    report.results.push({ id, status: 'fail', error: String(e.message) })
    throw e
  }
}
const panel = () => page.getByRole('button', { name: '任务动态', exact: true }).first().click()
const nav = async (id) => {
  await page.evaluate(id => window.__figAttentionNavigate({ sessionId: id, navigationId: 'synthetic-activity', eventIdentity: 'synthetic' }), id)
  await page.locator('[data-slot="main.conversation"] [data-conversation-session="' + id + '"]').waitFor()
}
const launch = async () => {
  app = await launchFig(state.env)
  page = await workbenchPage(app)
  if (first) {
    await page.getByRole('button', { name: /^(继续|Continue)$/ }).click()
    first = false
  }
  await panel()
  await page.locator('[data-fig-activity]').waitFor()
}
let a, b
try {
  await launch()
  await mkdir(join(state.documents, 'project-a'))
  await mkdir(join(state.documents, 'project-b'))
  a = await probe('parent', {
    workspacePath: join(state.documents, 'project-a'), preset: 'workspace-write', title: 'Synthetic task A', route: { provider: 'synthetic-activity', model: 'offline' }
  })
  b = await probe('parent', {
    workspacePath: join(state.documents, 'project-b'), preset: 'workspace-write', title: 'Synthetic task B', route: { provider: 'synthetic-activity', model: 'offline' }
  })
  await probe('followup', { id: a.id, text: 'Synthetic offline A' })
  await wait(async () => !(await probe('state', { id: a.id })).running)
  await probe('followup', { id: b.id, text: 'Synthetic offline B' })
  await wait(async () => !(await probe('state', { id: b.id })).running)
  await wait(async () => (await info()).rows.filter(r => r.results.length).length === 2)
  await record('four-groups', async () => {
    for (const name of ['待处理', '运行中', '新结果', '异常'])
      await page.getByRole('region', { name, exact: true }).waitFor()
    assert.equal((await info()).rows.filter(r => [a.id, b.id].includes(r.sessionId)).length, 2)
  })
  await record('project-global-count', async () => {
    await page.getByLabel('筛选项目').selectOption(a.workspaceId)
    await wait(() => page.getByRole('region', { name: '新结果', exact: true }).locator('article').count().then(n => n === 1))
    await wait(async () => await page.locator('[data-fig-activity-badge]').getAttribute('data-fig-activity-badge') === '2')
  })
  await record('batch-identity-race', async () => {
    let intercepted, release
    const held = new Promise(r => release = r)
    await page.route('**/fig-attention/acknowledge', async (route) => {
      intercepted = route.request().postDataJSON()
      await held
      await route.continue()
    })
    await page.getByRole('button', { name: '将这些结果标为已读', exact: true }).click()
    await wait(() => intercepted)
    const old = intercepted.identities[0]
    await fixture('configure', { text: 'SYNTHETIC-NEW-RESULT' })
    await probe('followup', { id: a.id, text: 'Second offline result' })
    await wait(async () => (await info()).rows.find(r => r.sessionId === a.id)?.results.length === 2)
    release()
    await wait(async () => {
      const row = (await info()).rows.find(r => r.sessionId === a.id)
      return row.results.length === 1 && row.results[0].identity !== old
    })
    await page.unroute('**/fig-attention/acknowledge')
  })
  await record('pending-running-overlap', async () => {
    await probe('hold', { id: a.id })
    await probe('followup', { id: a.id, text: 'Hold offline turn' })
    await wait(async () => (await probe('held', { id: a.id })).entries.length)
    await probe('attentionPending', { id: a.id })
    await wait(async () => {
      const r = (await info()).rows.find(r => r.sessionId === a.id)
      return r.running && r.pendingKinds.includes('approval') && r.results.length === 1
    })
    await wait(async () => await app.evaluate(({ app }) => app.dock.getBadge()) === '1')
  })
  await page.getByLabel('筛选项目').selectOption('')
  await fixture('configure', { fail: true })
  await probe('followup', { id: b.id, text: 'Fail offline turn' })
  await wait(async () => (await info()).rows.find(r => r.sessionId === b.id)?.failures.length === 1)
  await page.screenshot({ path: join(evidence, 'activity-active.png') })
  await record('failure-dock-ack', async () => {
    await wait(async () => await app.evaluate(({ app }) => app.dock.getBadge()) === '2')
    const card = page.getByRole('region', { name: '异常', exact: true }).locator('article').filter({ hasText: 'Synthetic task B' })
    await card.getByRole('button', { name: '知晓异常', exact: true }).click()
    await card.waitFor({state: 'hidden'})
    const known = page.getByRole('region', {name:'已知晓', exact:true}).locator('article').filter({hasText: 'Synthetic task B'})
    await page.locator('.fa-known > summary').click()
    await known.waitFor()
    assert.equal(await known.locator('details').getAttribute('open'), null)
    assert.equal(await known.getByRole('button', {name:'结束异常关注'}).isVisible(), false)
    await wait(async () => await app.evaluate(({ app }) => app.dock.getBadge()) === '1')
    const r = (await info()).rows.find(r => r.sessionId === b.id)
    assert.equal(r.failures.length, 1)
    assert.equal(r.failures[0].known, true)
  })
  await probe('attentionPending', { id: a.id, cancel: true })
  await probe('cancel', { id: a.id })
  await wait(async () => !(await probe('state', { id: a.id })).running)
  const before = (await info()).rows.map(r => ({ id: r.sessionId, results: r.results, failures: r.failures }))
  await app.close()
  app = undefined
  await launch()
  await record('restart-persistence', async () => {
    await wait(async () => (await info()).rows.filter(r => [a.id, b.id].includes(r.sessionId)).length === 2)
    const after = (await info()).rows.map(r => ({ id: r.sessionId, results: r.results, failures: r.failures }))
    assert.deepEqual(after.sort((a, b) => a.id.localeCompare(b.id)), before.sort((a, b) => a.id.localeCompare(b.id)))
    const saved = JSON.parse(await readFile(join(state.dshHome, 'fig/attention/reading-state.json'), 'utf8'))
    assert.equal(saved.schema, 1)
    report.persisted = saved
  })
  await record('card-not-read', async () => {
    await delay(1200)
    assert.equal((await info()).rows.find(r => r.sessionId === a.id).results.length, 1)
  })
  await record('foreground-result-read', async () => {
    await app.evaluate(({ app, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.show()
      w.focus()
      app.focus({ steal: true })
    })
    await nav(a.id)
    await page.getByText('SYNTHETIC-NEW-RESULT', { exact: true }).first().waitFor()
    await wait(async () => (await info()).rows.find(r => r.sessionId === a.id).results.length === 0)
  })
  await record('overlay-not-read', async () => {
    await panel()
    const previous = (await info()).rows.find(r => r.sessionId === b.id).results.length
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
    await delay(1400)
    assert.equal((await info()).rows.find(r => r.sessionId === b.id).results.length, previous)
    assert.equal(await page.evaluate(() => window.__figAttentionContext().visible), false)
    await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '关闭', exact: true }).click()
  })
  await panel()
  const cWorkspace = join(state.documents, 'project-c')
  await mkdir(cWorkspace)
  const c = await probe('parent', {workspacePath: cWorkspace, preset:'workspace-write', title:'Synthetic task C',
    route:{provider:'synthetic-activity',model:'offline'}})
  const task = async () => (await info()).rows.find(row => row.sessionId === c.id)
  const card = name => page.getByRole('region', {name, exact:true}).locator('[data-fig-activity-session]').filter({hasText:'Synthetic task C'})
  const result = filename => join(state.dshHome, 'fig/attention', filename)
  const saved = async () => JSON.parse(await readFile(result('reading-state.json'), 'utf8')).records.find(row => row.sessionId === c.id)
  const badge = () => app.evaluate(({app}) => app.dock.getBadge())
  const turn = async (settings, label) => {
    await fixture('configure', settings)
    await probe('followup', {id:c.id, text:label})
  }
  const apply = (action, identities) => rpc('/fig-attention', 'acknowledge', {sessionId:c.id, action, identities})
  let quota, deferredResult
  await record('structured-quota', async () => {
    await turn({fail:true, code:'CHATGPT_USAGE_LIMIT'}, 'Synthetic quota failure')
    await wait(async () => (await task())?.failures.some(item => item.category === 'quota'))
    await card('异常').getByText(/额度已用尽/).waitFor()
    assert.equal(await card('异常').count(), 1)
    quota = (await task()).failures[0].identity
    await card('异常').locator('.fa-more summary').click()
    await card('异常').getByRole('button', {name:'稍后提醒', exact:true}).click()
    await card('异常').waitFor({state:'hidden'})
    await wait(async () => !await badge())
    const record = (await saved()).failures.find(item => item.identity === quota)
    assert.ok(record.snoozedUntil - Date.now() > 3590_000)
  })
  await record('known-undo-new-event', async () => {
    await turn({fail:true, code:'SYNTHETIC_AUTH', status:401}, 'Synthetic authorization failure')
    await card('异常').waitFor()
    const original = (await task()).failures[0]
    assert.equal(original.category,'failure')
    await card('异常').getByRole('button', {name:'知晓异常', exact:true}).click()
    await page.locator('.fa-known > summary').click()
    await card('已知晓').waitFor()
    const receipt = page.getByText('已知晓异常 · Synthetic task C', {exact:true}).locator('..')
    await turn({fail:true}, 'New failure during undo')
    await wait(async () => (await task()).failures.some(item => item.identity !== original.identity && !item.known))
    const newcomer = (await task()).failures.find(item => item.identity !== original.identity)
    await receipt.getByRole('button', {name:'撤销', exact:true}).click()
    await wait(async () => (await task()).failures.length === 2 && (await task()).failures.every(item => !item.known))
    assert.deepEqual((await task()).failures.map(item => item.identity), [original.identity, newcomer.identity])
    await card('异常').locator('.fa-more summary').click()
    await card('异常').getByRole('button', {name:'结束异常关注', exact:true}).click()
    await card('异常').waitFor({state:'hidden'})
    const ended = page.getByText('已结束异常关注 · Synthetic task C', {exact:true}).locator('..')
    await ended.getByRole('button', {name:'撤销', exact:true}).click()
    await card('异常').waitFor()
    await apply('end', [original.identity, newcomer.identity])
  })
  await record('covered-window-not-read', async () => {
    await turn({text:'SYNTHETIC-COVERED-RESULT'}, 'Result for covered-window check')
    await card('新结果').waitFor()
    const count = (await task()).results.length
    assert.ok(count > 0)
    try {
      await app.evaluate(async ({BrowserWindow}) => {
        const main = BrowserWindow.getAllWindows()[0]
        const cover = new BrowserWindow({...main.getBounds(),alwaysOnTop:true,show:false})
        globalThis.__figSyntheticCover = cover
        await cover.loadURL('about:blank')
        cover.show(); cover.focus()
      })
      await wait(async () => await page.evaluate(() => window.__figWorkbenchForeground()) === false)
      await nav(c.id)
      await page.getByText('SYNTHETIC-COVERED-RESULT', {exact:true}).first().waitFor()
      await app.evaluate(() => globalThis.__figSyntheticCover?.focus())
      await wait(async () => await page.evaluate(() => window.__figWorkbenchForeground()) === false)
      await delay(1200)
      assert.equal((await task()).results.length, count)
      await page.getByRole('button', {name:'任务动态', exact:true}).first().evaluate(button => button.click())
      await page.locator('[data-fig-activity]').waitFor()
    } finally {
      await app.evaluate(() => globalThis.__figSyntheticCover?.close())
    }
  })
  await record('snooze-write-failure', async () => {
    await card('新结果').waitFor()
    deferredResult = (await task()).results[0].identity
    const path = result('reading-state.json')
    await rename(path, path + '.test-copy')
    await mkdir(path)
    try {
      await card('新结果').locator('.fa-more summary').click()
      await card('新结果').getByRole('button', {name:'稍后提醒', exact:true}).click()
      await page.getByRole('alert').filter({hasText:'无法保存稍后提醒'}).waitFor()
      assert.ok((await task()).results.some(item => item.identity === deferredResult))
    } finally {
      await rmdir(path)
      await rename(path + '.test-copy', path)
    }
  })
  await record('snooze-restart-expiry', async () => {
    await card('新结果').locator('.fa-more summary').click()
    await card('新结果').getByRole('button', {name:'稍后提醒', exact:true}).click()
    await card('新结果').waitFor({state:'hidden'})
    const postpone = page.getByText('已推迟 1 小时 · Synthetic task C', {exact:true}).last().locator('..')
    await postpone.getByRole('button', {name:'撤销', exact:true}).click()
    await card('新结果').waitFor()
    const receipt = (await apply('snooze', [deferredResult])).undo
    await card('新结果').waitFor({state:'hidden'})
    await delay(5100)
    const rejection = await page.evaluate(async token => (await fetch('/fig-attention/undo', {method:'POST',
      headers:{'content-type':'application/json'}, body:JSON.stringify({token})})).json(), receipt.token)
    assert.equal(rejection.error.code,'ATTENTION_UNDO_EXPIRED')
    await app.close(); app = undefined
    await launch()
    await wait(async () => (await task()) !== undefined)
    assert.equal((await task()).results.length, 0)
    assert.equal((await task()).failures.length, 0)
    assert.ok((await saved()).results.some(item => item.identity === deferredResult && item.snoozedUntil))
    await app.evaluate(({Notification, BrowserWindow}) => {
      globalThis.__figSyntheticReminders = []
      Notification.isSupported = () => true
      Notification.prototype.show = function () {globalThis.__figSyntheticReminders.push(this.title)}
      BrowserWindow.getAllWindows()[0].minimize()
    })
    await rpc('/fig-attention', 'preferences', {notifications:true})
    await delay(1300)
    assert.equal(await badge(), '')
    assert.deepEqual(await app.evaluate(() => globalThis.__figSyntheticReminders), [])
    // Only the fixture's clock advances; production always uses a one-hour interval.
    await fixture('clock', {offset:3600_100})
    await wait(async () => await badge() === '1')
    await wait(async () => (await app.evaluate(() => globalThis.__figSyntheticReminders)).length === 2)
    await app.evaluate(({BrowserWindow}) => {const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.show(); w.focus()})
    await card('异常').waitFor()
    await card('新结果').waitFor()
    assert.equal((await task()).results[0].identity, deferredResult)
    await fixture('archive', {id:c.id})
    await fixture('clock', {offset:0})
    await rpc('/fig-attention', 'preferences', {notifications:false})
  })
  await record('archive-membership', async () => {
    await fixture('archive', { id: b.id })
    await wait(async () => !(await info()).rows.some(r => r.sessionId === b.id))
    await delay(1200)
    assert.ok(!(await info()).rows.some(r => r.sessionId === b.id))
  })
  await record('light-dark-narrow', async () => {
    // The extra restart leaves this older Session cold until the UI explicitly opens it.
    await nav(a.id)
    await panel()
    await fixture('configure', { text: 'SYNTHETIC-VISUAL-RESULT', fail: false })
    await probe('followup', { id: a.id, text: 'Offline result for visual checks' })
    await wait(async () => (await info()).rows.find(r => r.sessionId === a.id)?.results.length === 1)
    await wait(async () => await page.getByRole('region', { name: '新结果', exact: true }).locator('article').count() === 1)
    await page.screenshot({ path: join(evidence, 'activity-light.png') })
    await page.locator('[data-slot="sidebar"]').getByRole('button', { name: /^(登录|Sign in)$/ }).click()
    await page.getByRole('menuitem', { name: '主题外观' }).hover()
    await page.getByRole('menuitemradio', { name: '深色' }).click()
    await page.screenshot({ path: join(evidence, 'activity-dark.png') })
    await page.setViewportSize({ width: 390, height: 780 })
    await wait(() => page.locator('[data-fig-activity]').evaluate(e => {
      const r = e.getBoundingClientRect()
      return document.querySelector('[data-sidebar-drawer][data-sidebar-collapsed]') && r.left >= -1 && r.width >= innerWidth - 2
    }))
    await page.screenshot({ path: join(evidence, 'activity-narrow.png'), animations: 'disabled' })
    assert.ok(await page.locator('[data-fig-activity]').evaluate(e => e.scrollWidth <= e.clientWidth + 1))
  })
  assert.equal(report.results.length, expected.length)
  report.status = 'pass'
} catch (e) {
  report.error = String(e.stack ?? e)
  process.exitCode = 1
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
  for (const id of expected)
    if (!report.results.some(r => r.id === id))
      report.results.push({ id, status: 'skipped', reason: 'Earlier assertion failed' })
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
  await cleanUp(state.profile, report.status === 'pass')
}
