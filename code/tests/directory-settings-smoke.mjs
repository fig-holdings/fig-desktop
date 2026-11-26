import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, readFile, writeFile, readdir, realpath, rm, symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse} from 'yaml'
import {isolatedProfile, launchFig, workbenchPage, cleanUp, closeFig, until} from '../scripts/isolated-fig.mjs'
const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11)
assert.ok(evidence); await mkdir(evidence)
const state = await isolatedProfile('directory-settings', {extraEnv: p => ({GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json')})})
const startup = join(state.profile, 'new-startup'), workspace = join(state.profile, 'new-default'), target = join(state.profile, 'new-data'), failed = join(state.profile, 'failed-data'),
  skills = join(state.profile, 'extra-skills')
for (const path of [startup, workspace, target, failed]) await mkdir(path)
await mkdir(join(skills, 'synthetic-extra'), {recursive: true})
await writeFile(join(skills, 'synthetic-extra/SKILL.md'), '---\nname: synthetic-extra\ndescription: Synthetic extra skill folder probe\n---\nNo model call.\n')
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([{id: 'workspace-controller', config: {documentsDirectory: state.documents}},
  {insert: [{id: 'directory-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url))}]}]))
const report = {status: 'fail', scope: 'Real isolated DSH/Electron and filesystem; native chooser/confirmation APIs intercepted with synthetic selections; real model calls disabled', checks: {}, startedAt: new Date().toISOString()}
const mark = async key => {report.checks[key] = true; await writeFile(join(evidence, 'progress.json'), JSON.stringify(report, null, 2))}
let app, page
const wait = check => until(check, {timeout: 20000, interval: 60, message: 'directory smoke timeout'})
const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({prefix, endpoint, payload}) => {
  const r = await (await fetch(prefix + '/' + endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)})).json()
  if (!r.ok) throw Error('fixture RPC failed'); return r.value
}, {prefix, endpoint, payload})
const info = () => rpc('/fig-skin', 'settings/info')
const probe = (endpoint, payload) => rpc('/handoff-probe', endpoint, payload)
const messages = () => app.evaluate(() => globalThis.__directoryDialogs.messages)
// Right after DSH (re)starts, its own first navigation can close settings opened a moment earlier
// (seen after the failed-migration resume, where nothing else waits for the page to settle). Open again then.
async function openSettings() {
  await page.locator('[data-fig-sidebar-settings]').waitFor()
  for (let attempt = 1; ; attempt++) {
    await app.evaluate(({Menu}) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
    await page.getByRole('heading', {name: '运行环境', exact: true}).waitFor()
    try {
      await page.getByRole('button', {name: '设置启动目录', exact: true}).and(page.locator(':enabled')).waitFor({timeout: 10000})
      return
    } catch (error) {
      if (attempt === 3 || await page.getByRole('heading', {name: '运行环境', exact: true}).isVisible()) throw error
      report.settingsReopened = (report.settingsReopened ?? 0) + 1
    }
  }
}
async function launch() {
  app = await launchFig(state.env); page = await workbenchPage(app)
  const proceed = page.getByRole('button', {name: /^(继续|Continue)$/})
  await proceed.waitFor({state: 'visible', timeout: 1500}).then(() => proceed.click(), () => {})
  await page.locator('[data-slot="sidebar"]').waitFor()
  await app.evaluate(({app, dialog}) => {
    globalThis.__originalDirectoryQuit = app.quit.bind(app)
    globalThis.__directoryDialogs = {messages: [], choices: [], target: '', canceled: false, response: 1, restarted: 0, quit: 0}
    dialog.showOpenDialog = async (_window, options) => {const s = globalThis.__directoryDialogs; s.choices.push(options); return {canceled: s.canceled, filePaths: s.canceled ? [] : [s.target]}}
    dialog.showMessageBox = async (_window, options) => {const s = globalThis.__directoryDialogs; s.messages.push(options ?? _window); return {response: s.response, checkboxChecked: false}}
    app.relaunch = () => {globalThis.__directoryDialogs.restarted++}
    app.quit = () => {globalThis.__directoryDialogs.quit++}
  })
  await openSettings()
}
async function close() {
  if (!app) return
  // Restore only a saved quit: when the workbench never opened, none was saved and Fig could not quit.
  await app.evaluate(({app}) => {if (globalThis.__originalDirectoryQuit) app.quit = globalThis.__originalDirectoryQuit}).catch(() => {})
  const closing = app; app = undefined
  await closeFig(closing)
}
async function select(name, path, response = 0, canceled = false) {
  await app.evaluate((_electron, {path, response, canceled}) => {Object.assign(globalThis.__directoryDialogs, {target: path, response, canceled})}, {path, response, canceled})
  await page.getByRole('button', {name, exact: true}).click()
}
async function restarted() {await wait(async () => (await app.evaluate(() => globalThis.__directoryDialogs.restarted)) === 1); await close(); await launch()}
try {
  await launch()
  assert.equal(await page.getByRole('button', {name: '设置目录…', exact: true}).count(), 0) // accessible names are specific per row
  assert.equal(await page.locator('[data-fig-runtime-settings] button').filter({hasText: '设置目录…'}).count(), 4)
  const initial = await info(), originalRegistry = JSON.parse(await readFile(join(state.dshHome, 'storages/workspace.json'), 'utf8'))
  const oldId = originalRegistry.global.defaultWorkspaceId
  await select('设置启动目录', startup, 0, true)
  await wait(async () => (await app.evaluate(() => globalThis.__directoryDialogs.choices.length)) === 1)
  await page.getByRole('button', {name: '设置启动目录', exact: true}).and(page.locator(':enabled')).waitFor()
  assert.deepEqual((await messages()), []); await mark('cancelChooserNoChange')
  await select('设置DSH数据目录', target, 1)
  await wait(async () => (await messages()).length === 1)
  const warning = (await messages())[0]
  assert.equal(warning.type, 'warning'); assert.equal(warning.defaultId, 1); assert.match(warning.detail, /旧目录保留/)
  report.migrationWarning = warning
  await page.getByRole('button', {name: '设置DSH数据目录', exact: true}).and(page.locator(':enabled')).waitFor()
  assert.equal((await info()).dshHome, initial.dshHome); assert.deepEqual(await readdir(target), [])
  await mark('migrationWarningAndCancel')
  const {id} = await probe('parent', {workspacePath: state.workspace, preset: 'workspace-write', title: 'Synthetic directory survival'})
  await probe('hold', {id}); await probe('followup', {id, text: 'Hold synthetic turn without a model call.'})
  await wait(async () => !(await probe('idle')))
  const choices = await app.evaluate(() => globalThis.__directoryDialogs.choices.length), beforeMessages = (await messages()).length
  await select('设置启动目录', startup)
  await wait(async () => (await messages()).length > beforeMessages)
  assert.match((await messages()).at(-1).message, /仍有会话或后台任务/)
  assert.equal(await app.evaluate(() => globalThis.__directoryDialogs.choices.length), choices)
  await probe('cancel', {id}); await wait(async () => (await probe('idle')))
  await mark('runningSessionRefusedBeforeChooser')
  const job = await probe('call', {id, name: 'bash', args: {command: 'sleep 30', description: 'Synthetic directory migration guard', run_in_background: true}})
  assert.equal(job.result.isError, false); assert.ok(job.result.value.jobId)
  await wait(async () => !(await probe('idle')))
  const beforeJobMessages = (await messages()).length
  await select('设置启动目录', startup)
  await wait(async () => (await messages()).length > beforeJobMessages)
  assert.match((await messages()).at(-1).message, /仍有会话或后台任务/)
  assert.equal(await app.evaluate(() => globalThis.__directoryDialogs.choices.length), choices)
  await probe('call', {id, name: 'job_kill', args: {job_id: job.result.value.jobId}})
  await probe('cancel', {id}); await wait(async () => (await probe('idle')))
  await mark('runningBackgroundJobRefusedBeforeChooser')
  await select('设置默认工作区目录', workspace)
  await restarted()
  assert.equal((await info()).defaultWorkspace, await realpath(workspace))
  const registry = JSON.parse(await readFile(join(state.dshHome, 'storages/workspace.json'), 'utf8'))
  assert.equal(registry.tables.workspaces[oldId].path, originalRegistry.tables.workspaces[oldId].path)
  assert.ok(registry.tables.workspaces[oldId].sessionIds.includes(id))
  assert.ok((await readdir(join(state.dshHome, 'fig/directory-backups'))).length > 0)
  await mark('nativeDefaultWorkspaceAndOldSessionPreserved')
  await select('设置启动目录', startup)
  await restarted()
  assert.equal((await info()).startup, await realpath(startup))
  await mark('startupPersistsAcrossLaunch')
  await select('设置额外技能目录', skills)
  await restarted()
  assert.equal((await info()).skillDirectory, await realpath(skills))
  assert.deepEqual(JSON.parse(await readFile(join(state.profile, 'skill-directory.json'), 'utf8')), {schema: 1, path: await realpath(skills)})
  assert.ok(!('skillDirectory' in JSON.parse(await readFile(join(state.profile, 'directory-settings.json'), 'utf8'))), 'directory-settings.json keeps its earlier schema')
  await page.getByRole('button', {name: '打开额外技能目录', exact: true}).and(page.locator(':enabled')).waitFor()
  await mark('extraSkillFolderPersistsAcrossLaunch')
  await select('清除额外技能目录', skills)
  await wait(async () => (await app.evaluate(() => globalThis.__directoryDialogs.restarted)) === 1)
  assert.equal((await messages()).at(-1).buttons[0], '清除并重启')
  await restarted()
  assert.equal((await info()).skillDirectory, undefined)
  assert.ok((await readdir(skills)).includes('synthetic-extra'), 'clearing never touches the folder')
  await mark('extraSkillFolderClearedWithoutDeleting')
  const sentinel = join(state.dshHome, 'migration-sentinel.bin')
  await writeFile(sentinel, 'SYNTHETIC-HIDDEN-DATA')
  const shared = join(state.profile, 'shared-asset.txt')
  await writeFile(shared, 'KEEP-SYNTHETIC-SHARED-ASSET')
  await symlink('../shared-asset.txt', join(state.dshHome, 'shared-link'))
  await writeFile(join(state.dshHome, '.credentials.yaml'), JSON.stringify({version: 1, records: {'synthetic/migration': {kind: 'grant', payload: {token: 'SYNTHETIC-NO-REAL-AUTH'}}}}), {mode: 0o600})
  execFileSync('/usr/bin/mkfifo', [join(state.dshHome, 'unsupported-pipe')])
  await select('设置DSH数据目录', failed)
  await wait(async () => (await messages()).some(message => /特殊文件/.test(message.message)))
  page = await workbenchPage(app)
  await openSettings()
  assert.equal(await realpath((await info()).dshHome), await realpath(state.dshHome))
  assert.equal(await app.evaluate(() => globalThis.__directoryDialogs.restarted), 0)
  await rm(join(state.dshHome, 'unsupported-pipe'))
  await mark('failedMigrationResumesOriginalService')
  await select('设置DSH数据目录', target)
  await restarted()
  assert.equal((await info()).dshHome, await realpath(target))
  assert.equal(await readFile(join(target, 'migration-sentinel.bin'), 'utf8'), 'SYNTHETIC-HIDDEN-DATA')
  assert.equal(await readFile(sentinel, 'utf8'), 'SYNTHETIC-HIDDEN-DATA')
  const targetRegistry = JSON.parse(await readFile(join(target, 'storages/workspace.json'), 'utf8'))
  assert.ok(targetRegistry.tables.workspaces[oldId].sessionIds.includes(id))
  const credentials = parse(await readFile(join(target, '.credentials.yaml'), 'utf8'))
  assert.equal(credentials.records['synthetic/migration'].payload.token, 'SYNTHETIC-NO-REAL-AUTH')
  assert.equal(await realpath(join(target, 'shared-link')), await realpath(shared))
  await page.getByRole('button', {name: '恢复旧目录…', exact: true}).waitFor()
  await page.screenshot({path: join(evidence, 'migrated-runtime.png')})
  await mark('migrationPersistsCredentialsAndSessionsAndRetainsSource')
  await writeFile(join(target, 'post-migration-sentinel'), 'KEEP-NEWER-DATA')
  await app.evaluate(() => {globalThis.__directoryDialogs.response = 0})
  await page.getByRole('button', {name: '恢复旧目录…', exact: true}).click()
  await wait(async () => (await app.evaluate(() => globalThis.__directoryDialogs.restarted)) === 1)
  report.restoreWarning = (await messages()).at(-1)
  await restarted()
  assert.equal(await realpath((await info()).dshHome), await realpath(state.dshHome))
  assert.equal(await readFile(join(target, 'post-migration-sentinel'), 'utf8'), 'KEEP-NEWER-DATA')
  await mark('restoreOldSnapshotPreservesNewerFolder')
  report.status = 'pass'
} catch (error) {report.error = String(error.stack ?? error); await page?.screenshot({path: join(evidence, 'failure.png')}).catch(() => {}); process.exitCode = 1}
finally {report.finishedAt = new Date().toISOString(); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2)); await close().catch(() => {}); await cleanUp(state.profile, report.status === 'pass')}
