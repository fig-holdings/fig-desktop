import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfile,launchFig,workbenchPage,cleanUp} from '../scripts/isolated-fig.mjs'
import {shapePulls} from '../harness/development-workbench/pulls.js'
import {insertProbes} from './helpers/fig-smoke.mjs'
const packaged=process.argv.includes('--packaged')
const appPath=packaged?fileURLToPath(new URL('../../outputs/Fig Desktop.app/Contents/Resources/app/',import.meta.url)):undefined
const evidence=fileURLToPath(new URL(packaged?'../../work/verification/workbench-ci-package-0.1.77/':'../../work/verification/workbench-ci/',import.meta.url));await mkdir(evidence,{recursive:true})
const state=await isolatedProfile('workbench-ci',{extraEnv:root=>({GROK_HOME:join(root,'grok'),GROK_AUTH_PATH:join(root,'grok/auth.json'),CODEX_HOME:join(root,'codex')})})
await insertProbes(state,['handoff-probe'])
let app,page,passed=false,requests=0,mode='active',lastBody;const checks=[]
async function probe(endpoint,payload){return page.evaluate(async({endpoint,payload})=>(await(await fetch('/handoff-probe/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json()).value,{endpoint,payload})}
const fixture=()=>shapePulls(JSON.stringify([{number:42,title:'CI progress fixture',url:'https://github.com/fig-fixture/ci/pull/42',headRefName:'feature/ci',statusCheckRollup:[
 {name:'Typecheck',status:'COMPLETED',conclusion:'SUCCESS',startedAt:'2026-11-17T10:00:00Z',completedAt:'2026-11-17T10:00:18Z',detailsUrl:'https://example.com/log/1'},
 {name:'Integration test with a very long descriptive check name',status:mode==='active'?'IN_PROGRESS':'COMPLETED',conclusion:mode==='active'?null:'SUCCESS',startedAt:new Date(Date.now()-72000).toISOString(),completedAt:mode==='active'?null:new Date().toISOString()},
 {name:'Security scan',status:mode==='active'?'QUEUED':'COMPLETED',conclusion:mode==='active'?null:'SKIPPED'},
 {name:'Cancelled job',status:'COMPLETED',conclusion:'CANCELLED'}]}]),'feature/ci')
async function capture(name){await page.screenshot({path:join(evidence,name+'.png')});const shell=await readFile(new URL('../app/main/workbench.css',import.meta.url),'utf8');await writeFile(join(evidence,name+'.html'),await page.evaluate(shell=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,link,img').forEach(n=>n.remove());const style=document.createElement('style');style.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n')+'\n'+shell;clone.querySelector('head').append(style);return '<!doctype html>'+clone.outerHTML},shell))}
try{
 app=await launchFig(state.env,{appPath});page=await workbenchPage(app)
 await page.route('**/fig-development-workbench/pulls',async route=>{requests++;lastBody=route.request().postDataJSON();await route.fulfill({json:{ok:true,value:mode==='error'?{problem:'failed'}:{session:fixture(),pulls:[],readAt:Date.now()}}})})
 await page.getByRole('button',{name:/^(继续|Continue)$/}).click()
 const item=await probe('parent',{workspacePath:state.documents,preset:'workspace-write',title:'CI progress test'});await probe('hold',{id:item.id});await probe('followup',{id:item.id,text:'Offline CI fixture'})
 const group=page.locator(`[data-row-key="workspace:${item.workspaceId}"]`);await group.waitFor();if(await group.getAttribute('aria-expanded')!=='true')await group.click();await page.locator(`[data-row-key="session:${item.id}"]`).click()
 // A fixture repository is unnecessary: render PR section using the same mocked status contract.
 await page.route('**/fig-development-workbench/status',route=>route.fulfill({json:{ok:true,value:{repository:{name:'fixture',display:'/fixture',root:'/fixture',branch:'feature/ci',uncommitted:{files:0},remote:{path:'example/fixture',web:'https://example.com/fixture'}}}}}))
 await page.setViewportSize({width:1440,height:1000})
 await page.getByRole('button',{name:'刷新',exact:true}).last().click()
 for(const theme of ['light','dark']){
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-slot="sidebar"]').first().locator('[data-slot="settings.launcher"] button[data-signed-out]').click();await page.getByRole('menuitem',{name:'主题外观',exact:true}).hover();await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000})
   // CI details live in PR 详情, opened from the card's compact row.
   if(!await page.locator('[data-fig-pull-detail] [data-fig-ci-toggle]').isVisible().catch(()=>false)){
    if(!await page.locator('[data-fig-workbench-pull="42"]').isVisible().catch(()=>false))await page.locator('[data-fig-workbench-button]').click()
    await page.locator('[data-fig-workbench-pull="42"]').click()
   }
   const toggle=page.locator('[data-fig-pull-detail] [data-fig-ci-toggle]');await toggle.waitFor();if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click()
   await page.locator('[data-fig-ci-state="running"]').waitFor();assert.equal(await page.locator('[data-fig-ci-state]').count(),4)
   assert.equal(await page.locator('[data-fig-ci-state="passed"]').getAttribute('href'),'https://example.com/log/1')
   await capture(`${theme}-${width}`);checks.push({theme,width,expanded:true,overflow:await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)})
  }
 }
 await page.setViewportSize({width:1440,height:1000});await page.locator('[data-fig-ci-toggle]').waitFor();await page.waitForTimeout(300)
 const before=requests;await page.waitForTimeout(16500);assert.ok(requests>before)
 // While checks run the poll re-reads only that pull request, not the whole list.
 assert.deepEqual([lastBody.force,lastBody.checks],[false,['https://github.com/fig-fixture/ci/pull/42']]);checks.push({automaticPoll:true,realTimeWaitMs:16500,pollAsksOnlyActive:lastBody.checks})
 await page.clock.install()
 mode='error';await page.getByRole('button',{name:'刷新',exact:true}).last().click();await page.getByText('更新失败，显示上次结果',{exact:true}).waitFor();assert.equal(await page.locator('[data-fig-pull-detail="https://github.com/fig-fixture/ci/pull/42"]').count(),1);checks.push({stalePreserved:true})
 mode='complete';await page.getByRole('button',{name:'刷新',exact:true}).last().click();await page.locator('[data-fig-ci-toggle]').filter({hasText:'4/4'}).waitFor();checks.push({progressUpdated:true})
 const settled=requests;await page.clock.fastForward(16000);await page.waitForTimeout(100);assert.equal(requests,settled);checks.push({settledSlowsPolling:true})
 // Nothing shows the pull requests any more: PR 详情 closed (the card docks again) and the card closed.
 await page.locator('[data-sidebar-right-toggle]').click();await page.waitForTimeout(300)
 if(await page.locator('[data-fig-workbench="docked"]').isVisible().catch(()=>false))await page.locator('[data-fig-workbench-button]').click()
 // Docking the card again reads once; let that settle before counting.
 await page.waitForTimeout(1500);const closed=requests;await page.clock.fastForward(180000);await page.waitForTimeout(100);assert.equal(requests,closed);checks.push({closedStopsPolling:true})
 await page.clock.resume();await probe('stop',{id:item.id});passed=true;await writeFile(join(evidence,'result.json'),JSON.stringify({status:'pass',checks,requests,scope:packaged?'exact installed package payload in isolated dev host; mocked PR transport, no credentials':'mocked PR transport; real isolated UI, no credentials'},null,2));console.log('PASS',evidence)
}catch(e){await page?.screenshot({path:join(evidence,'failure.png')});throw e}finally{await app?.close();await cleanUp(state.profile,passed)}
