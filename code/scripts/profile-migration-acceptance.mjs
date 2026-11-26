import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedDevEnvironment } from './dev-isolation.mjs'
import { launchFig, until, workbenchPage } from './isolated-fig.mjs'
import { appProcesses, exited, servicePid } from './verification-lifecycle.mjs'
import { fixtureHashes, fixtureSource, legacyAlerts, legacySettings, preferencesPath,
  prepareLegacyProfile, readingPath, webPatch, workspacePath } from './profile-migration-fixture.mjs'

const json = async path => JSON.parse(await readFile(path, 'utf8'))
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const wait = (fn, message) => until(fn, {interval:80, timeout:20_000, message})

/** @typedef {import('playwright').Page} Page */
/**
 * @typedef {object} MigrationApp
 * @property {(fn: any, arg?: any) => Promise<any>} evaluate
 * @property {() => Promise<Page>} workbench
 * @property {() => Promise<number|undefined>} service
 * @property {() => Promise<void>} close
 */
/** Launch exact JS from the build or packaged Resources/app in the development host. */
async function launchPayload(profile, appPath) {
  const env = { ...isolatedDevEnvironment(process.env, profile), npm_config_offline: 'true' }
  const app = await launchFig(env, {appPath})
  const pid = app.process().pid
  assert.ok(pid)
  /** @type {MigrationApp} */
  const run = {
    evaluate:(callback,arg) => app.evaluate(callback,arg),
    workbench:() => workbenchPage(app),
    service:() => servicePid(app),
    async close() {
      const dsh = await servicePid(app).catch(()=>undefined)
      await app.close()
      assert.ok(await exited(appProcesses(pid,dsh)), 'Fig and its isolated DSH must exit')
    }
  }
  return run
}

/**
 * @param {{evidence:string, appPath?:string, profile?:string, launch?:(profile:string)=>Promise<MigrationApp>,
 *   scope?:string}} options
 */
export async function acceptProfileMigration({evidence, appPath, profile: supplied, launch, scope}) {
  await mkdir(evidence, {recursive:true})
  const profile = supplied ?? await realpath(await mkdtemp(join(tmpdir(),'fig-profile-migration-')))
  const fixture = join(evidence, 'legacy-fixture')
  const target = join(profile,'new-dsh'), failed = join(profile,'failed-dsh')
  const {source, sessions, records, workspaceId} = await prepareLegacyProfile(profile, fixture)
  const original = await fixtureHashes(fixture)
  await mkdir(target); await mkdir(failed)
  await writeJson(join(evidence,'fixture-manifest.json'),{source:fixtureSource, sha256:original})
  /** @type {{status:string, scope:string, fixture:object, cases:Record<string,unknown>, error?:string,
   *   isolation:string, actualSignedBinary:string}} */
  const report = {status:'fail', scope:scope ?? (appPath ? 'Application JS payload in isolated development host' : 'Production build in isolated development host'),
    fixture:fixtureSource, cases:{}, isolation:profile, actualSignedBinary:'not-run'}
  /** @type {MigrationApp|undefined} */
  let app
  /** @type {Page | null} */
  let page = null
  const journal = join(profile,'directory-migration.json')
  const selection = join(profile,'directory-settings.json')
  /** @param {string} key @param {unknown} [value] */
  const record = async (key, value = true) => {
    report.cases[key] = value
    await writeJson(join(evidence,'migration.json'), report)
  }
  async function open() {
    app = await (launch ? launch(profile) : launchPayload(profile, appPath))
    assert.equal(await realpath(await app.evaluate(({app})=>app.getPath('userData'))),profile)
    page = await app.workbench()
    const proceed = page.getByRole('button',{name:/^(继续|Continue)$/})
    await proceed.waitFor({state:'visible',timeout:1300}).then(()=>proceed.click(),()=>{})
    await page.locator('[data-slot="sidebar"]').waitFor()
    await app.evaluate(({app,dialog})=>{
      const quit = app.quit.bind(app)
      globalThis.__figMigrationAcceptance = {quit, target:'', relaunches:0, messages:[]}
      dialog.showOpenDialog = async () => ({canceled:false,filePaths:[globalThis.__figMigrationAcceptance.target]})
      dialog.showMessageBox = async (window, options) => {
        globalThis.__figMigrationAcceptance.messages.push(options ?? window)
        return {response:0,checkboxChecked:false}
      }
      app.relaunch = () => {globalThis.__figMigrationAcceptance.relaunches++}
      app.quit = () => {}
    })
  }
  async function close() {
    const current = app; app = undefined
    if (!current) return
    await current.evaluate(({app})=>{if(globalThis.__figMigrationAcceptance) app.quit=globalThis.__figMigrationAcceptance.quit}).catch(()=>{})
    await current.close()
  }
  async function rpc(prefix, endpoint) {
    assert.ok(page)
    return page.evaluate(async url=>{
      const response = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
      if (!response.ok) throw Error(url + ' returned HTTP ' + response.status)
      const result = await response.json()
      if(!result.ok) throw Error(JSON.stringify(result.error))
      return result.value
    },prefix+'/'+endpoint)
  }
  async function snapshot(home) {
    assert.ok(page)
    const workbench = page
    await wait(async()=> {
      const patch = parse(await readFile(join(home,webPatch),'utf8'))
      return patch.find(entry=>entry.id==='ui-theme')?.config?.fontSize===18
    },'Legacy theme settings were not imported')
    await page.waitForFunction(() => document.documentElement.style.colorScheme === 'dark'
      && document.body.style.getPropertyValue('--dsh-content-font-size') === '18px')
    const patch = parse(await readFile(join(home,webPatch),'utf8'))
    assert.equal(patch.find(entry=>entry.id==='ui-theme')?.config.preference,'dark')
    assert.equal(patch.find(entry=>entry.id==='ui-settings-general')?.config.welcomeNoticeVersion,'2026-09-28.1')
    assert.equal(await readFile(join(home,'settings.yaml.imported'),'utf8'),legacySettings)
    await assert.rejects(readFile(join(home,'settings.yaml')), {code:'ENOENT'})
    // Importing the legacy sections can recompose the Web host while its page is already visible.
    await wait(async () => (await rpc('/fig-skin','settings/info').catch(()=>undefined))?.dshHome === home,
      'The sandbox did not open the expected data directory')
    const registry = await json(join(home,workspacePath))
    assert.equal(registry.global.defaultWorkspaceId,workspaceId)
    assert.deepEqual(registry.global.pinnedSessionIds,[sessions[1].id])
    const fixtureIds = sessions.map(session=>session.id)
    assert.deepEqual(registry.tables.workspaces[workspaceId].sessionIds.filter(id=>fixtureIds.includes(id)),fixtureIds)
    assert.deepEqual(await json(join(home,readingPath)),{schema:1,records})
    assert.deepEqual(await json(join(home,preferencesPath)), legacyAlerts)
    let readout = ''
    const rows = await wait(async()=>{
      const data=await rpc('/fig-attention','dynamics').catch(error=>{readout=String(error); return undefined})
      if (data) readout=JSON.stringify(data)
      return data?.synced && data.readingHealthy && sessions.every(({id})=>data.rows.some(row=>row.sessionId===id)) && data.rows
    },'Migrated reading state did not appear through the Host').catch(async error => {
      await writeFile(join(evidence,'attention-readout.log'), readout+'\n')
      throw error
    })
    const summary = await rpc('/fig-attention','info')
    assert.equal(summary.preferences.notifications,false)
    assert.equal(summary.preferences.dock,true)
    for (const [index, session] of sessions.entries()) {
      const row = rows.find(row=>row.sessionId===session.id), expected = records[index]
      assert.equal(row.readThrough,expected.readThrough)
      assert.deepEqual(row.results,expected.results)
      assert.deepEqual(row.failures,expected.failures)
      assert.equal(summary.rows.find(row=>row.sessionId===session.id).unknownFailure,session.known===false)
      const encoded = await readFile(join(home,session.path))
      const historical = await readFile(join(fixture,session.path))
      // Opening a Session can append native initialization events. Its committed history must stay intact.
      assert.ok(encoded.subarray(0,historical.length).equals(historical),session.id+' historical bytes changed')
    }
    await page.evaluate(id=>globalThis.__figAttentionNavigate({sessionId:id,navigationId:'synthetic-profile-migration',eventIdentity:'synthetic'}),sessions[1].id)
    const conversation = page.locator('[data-slot="main.conversation"] [data-conversation-session="'+sessions[1].id+'"]')
    await conversation.getByText(sessions[1].reply,{exact:true}).waitFor()
    await page.getByRole('button',{name:'任务动态',exact:true}).first().click()
    const group = name=>workbench.getByRole('region',{name,exact:true})
    const card = (name,index) => group(name).locator('[data-fig-activity-session="'+sessions[index].id+'"]')
    await card('新结果',0).waitFor()
    assert.equal(await card('新结果',1).count(),0)
    const acknowledged = group('已知晓').locator('.fa-known')
    if (!await acknowledged.evaluate(node=>node.hasAttribute('open'))) await acknowledged.locator(':scope > summary').click()
    await card('已知晓',2).waitFor()
    await card('异常',3).waitFor()
    assert.equal(await group('额度受限').locator('article').count(),0)
    return {home, reading:records.map(row=>({id:row.sessionId,readThrough:row.readThrough,
      results:row.results.length,known:row.failures[0]?.known})), workspaceId, theme: 'dark', fontSize:18}
  }
  async function migrate(path) {
    assert.ok(app)
    assert.ok(page)
    await app.evaluate(({Menu}, path)=>{
      globalThis.__figMigrationAcceptance.target=path
      Menu.getApplicationMenu().getMenuItemById('fig-settings').click()
    },path)
    await page.getByRole('heading',{name:'运行环境',exact:true}).waitFor()
    await page.getByRole('button',{name:'设置DSH数据目录',exact:true}).click()
  }
  const selected = async()=>await json(selection).catch(error=>{
    if(error.code==='ENOENT') return {schema:1}
    throw error
  })
  try {
    await open()
    await record('legacyImportAndSourceReadable',await snapshot(source))
    const settingsFiles = [readingPath,preferencesPath,'settings.yaml.imported',webPatch]
    const protectedFiles = [...settingsFiles,workspacePath,...sessions.map(item=>item.path)]
    const bytes = (home,files) => Promise.all(files.map(name=>readFile(join(home,name))))
    const before = await bytes(source,settingsFiles)
    const fifo = join(source,'synthetic-unsupported-pipe')
    const priorPid = await app?.service()
    assert.ok(priorPid)
    execFileSync('/usr/bin/mkfifo',[fifo])
    try {
      await migrate(failed)
      const dialogs = await wait(async()=>{
        const value = await app?.evaluate(()=>globalThis.__figMigrationAcceptance)
        return value?.messages.some(item=>/特殊文件/.test(item.message)) && value
      },'Migration error did not surface')
      assert.equal(dialogs.relaunches,0)
      assert.equal((await selected()).dshHome,undefined)
      assert.deepEqual(await readdir(failed),[])
      const interrupted = (await readdir(profile)).filter(name=>name.startsWith('directory-migration-interrupted-'))
      assert.equal(interrupted.length,1)
      await assert.rejects(readFile(journal),{code:'ENOENT'})
      const failure = await json(join(profile,interrupted[0]))
      assert.equal(failure.status,'copying')
      assert.equal(failure.from,source)
      assert.equal(failure.to,failed)
      assert.ok(await exited([priorPid,-priorPid]), 'Failed migration must stop the first DSH before reopening it')
      await wait(async()=>{const pid=await app?.service(); return pid && pid!==priorPid},'Original data service did not restart')
      assert.ok(app)
      page=await app.workbench()
      const recovered = await snapshot(source)
      assert.deepEqual(await bytes(source,settingsFiles),before)
      await record('failedMigrationRestoresOriginalService',{...recovered,journal:failure})
    } finally {await rm(fifo)}
    await migrate(target)
    await wait(()=>app?.evaluate(()=>globalThis.__figMigrationAcceptance.relaunches===1),'Migration did not request restart')
    const committed=await json(journal)
    assert.equal(committed.status,'committed')
    assert.equal(committed.to,target)
    assert.equal((await selected()).dshHome,target)
    assert.equal((await selected()).previousDshHome,source)
    const sourceAtSwitch = await bytes(source,protectedFiles)
    assert.deepEqual(await bytes(target,protectedFiles),sourceAtSwitch)
    assert.deepEqual(await bytes(source,settingsFiles),before)
    await close()
    await open()
    const migrated=await snapshot(target)
    await record('migratedData',{...migrated, transaction:committed})
    const state = await selected()
    await close()
    await open()
    assert.deepEqual(await snapshot(target),migrated)
    assert.deepEqual(await selected(),state)
    assert.deepEqual(await json(journal),committed)
    assert.deepEqual(await bytes(source,protectedFiles),sourceAtSwitch)
    assert.deepEqual(await fixtureHashes(fixture),original)
    await record('relaunchIdempotentAndOriginalUnchanged')
    await close()
    report.status='pass'
    return report
  } catch(error) {
    report.error=error instanceof Error ? error.stack ?? error.message : String(error)
    const startup=await app?.evaluate(async ({BrowserWindow})=>BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('window.fig?.getState()')).catch(()=>undefined)
    if (startup) await writeJson(join(evidence,'startup-diagnostics.json'), startup)
    const workbench = /** @type {Page | null} */ (page)
    await workbench?.screenshot({path:join(evidence,'failure.png'),timeout:2500}).catch(()=>{})
    const visible = await workbench?.locator('[data-slot="main.conversation"]').innerText({timeout:1500}).catch(()=>undefined)
    if (visible) await writeFile(join(evidence,'conversation.log'),visible)
    throw error
  } finally {
    try {await close()} finally {
      await writeJson(join(evidence,'migration.json'),report)
      if (!supplied && report.status==='pass') await rm(profile,{recursive:true})
    }
  }
}
