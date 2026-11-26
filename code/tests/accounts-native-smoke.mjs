import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { delimiter, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isolatedProfile, launchFig, workbenchPage, cleanUp } from '../scripts/isolated-fig.mjs'
const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11); assert.ok(evidence); await mkdir(evidence)
const state = await isolatedProfile('accounts-native', {extraEnv: p => ({GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json'), PATH: join(p, 'bin') + delimiter + process.env.PATH, FAKE_GROK_RECORD: join(p, 'cli-calls.log')})})
await mkdir(state.env.GROK_HOME); await mkdir(join(state.profile, 'bin'))
// Keep the synthetic bin first even after Fig resolves its real Node/npx/npm set (all three, or Fig skips the folder).
await symlink(process.execPath, join(state.profile, 'bin/node'))
await symlink(join(dirname(process.execPath), 'npx'), join(state.profile, 'bin/npx'))
await symlink(join(dirname(process.execPath), 'npm'), join(state.profile, 'bin/npm'))
const scope = 'https://auth.x.ai::00000000-0000-4000-8000-000000000000'
await writeFile(state.env.GROK_AUTH_PATH, JSON.stringify({[scope]: {auth_mode: 'oidc', key: 'x'.repeat(40), expires_at: '2099-01-01T00:00:00Z', email: 'model@example.invalid', first_name: 'Synthetic', last_name: 'Fixture'}}))
await writeFile(join(state.env.GROK_HOME, 'config.toml'), 'KEEP-SYNTHETIC-CONFIG')
const fake = fileURLToPath(new URL('./fixtures/fake-grok.mjs', import.meta.url)), executable = join(state.profile, 'bin/grok')
await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); await chmod(executable, 0o755)
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([{id: 'workspace-controller', config: {documentsDirectory: state.documents}}, {insert: [{id: 'account-probe', name: fileURLToPath(new URL('./fixtures/account-probe.mjs', import.meta.url))}]}]))
const report = {status: 'fail', startedAt: new Date().toISOString(), scope: 'Synthetic account UI; Grok Host/file logout via fake CLI; ChatGPT account/limits UI transport mocked; external Host fetch denied; native official logout is a separate OS-sandbox test'}
let app, page, held
try {
  app = await launchFig(state.env); page = await workbenchPage(app)
  await page.getByRole('button', {name: /^(继续|Continue)$/}).click()
  const billing = {usedPercent: 2, period: 'weekly', periodEnd: '2099-01-01T00:00:00Z', source: 'live', fetchedAt: new Date().toISOString()}
  await page.route('**/fig-grok/billing', route => route.fulfill({json: {ok: true, value: {billing}}}))
  await app.evaluate(({Menu}) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('button', {name: 'Grok 账号', exact: true}).click()
  await page.getByText('model@example.invalid').first().waitFor()
  await page.locator('[data-fig-grok-symbol]').waitFor()
  assert.equal(await page.getByText(/^(登录通道|模型账号)$/).count(), 0)
  await page.screenshot({path: join(evidence, 'grok-signed-in.png')})
  const initial = await page.evaluate(async () => (await (await fetch('/fig-grok/account', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).json()).value)
  assert.equal(initial.signedIn, true)
  let intercepted = false
  await page.route('**/fig-grok/account', route => {
    if (intercepted) return route.continue()
    intercepted = true
    return new Promise(resolve => {held = {route, resolve}})
  })
  await page.getByRole('button', {name: '刷新', exact: true}).click()
  for (const end = Date.now() + 3000; !held && Date.now() < end; await delay(30)) {}
  assert.ok(held)
  await page.getByRole('button', {name: '退出登录', exact: true}).click()
  await page.getByText('未登录 Grok', {exact: true}).waitFor({timeout: 10000})
  await held.route.fulfill({json: {ok: true, value: initial}}); held.resolve(); held = undefined
  await delay(300)
  assert.equal(await page.getByText('未登录 Grok', {exact: true}).isVisible(), true)
  assert.deepEqual(JSON.parse(await readFile(state.env.GROK_AUTH_PATH, 'utf8')), {})
  assert.equal(await readFile(join(state.env.GROK_HOME, 'config.toml'), 'utf8'), 'KEEP-SYNTHETIC-CONFIG')
  assert.match(await readFile(state.env.FAKE_GROK_RECORD, 'utf8'), /logout --leader-socket/)
  report.grok = {logoutFileVerified: true, otherConfigPreserved: true, lateAccountIgnored: true, dedicatedSymbol: true}
  await page.screenshot({path: join(evidence, 'grok-signed-out.png')})
  await page.route('**/fig-chatgpt/account', route => route.fulfill({json: {ok: true, value: {signedIn: true, signingIn: false, checkedAt: new Date().toISOString()}}}))
  await page.route('**/fig-chatgpt/limits', route => route.fulfill({json: {ok: true, value: {source: 'live', email: 'limit-source@example.invalid', fetchedAt: new Date().toISOString(), windows: [{usedPercent: 3, minutes: 10080, resetsAt: '2099-01-01T00:00:00Z'}]}}}))
  await page.getByRole('button', {name: 'ChatGPT 账号', exact: true}).click()
  await page.getByText('已登录 ChatGPT', {exact: true}).waitFor()
  await page.getByText(/额度来源：Codex；来源账号：limit-source@example.invalid；可能不是当前模型登录账号/).waitFor()
  assert.equal(await page.getByText(/^(登录通道|模型账号)$/).count(), 0)
  await page.screenshot({path: join(evidence, 'chatgpt-source-boundary.png')})
  report.chatgpt = {removedAccountRowsAbsent: true, limitSourceExplicitAndSeparate: true}
  report.status = 'pass'
} catch (error) {report.error = String(error.stack ?? error); await page?.screenshot({path: join(evidence, 'failure.png')}).catch(() => {}); process.exitCode = 1}
finally {if (held) {await held.route.abort().catch(() => {}); held.resolve()} report.finishedAt = new Date().toISOString(); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2)); await app?.close().catch(() => {}); await cleanUp(state.profile, report.status === 'pass')}
