import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfile,launchFig,workbenchPage,cleanUp,until} from '../scripts/isolated-fig.mjs'
const evidence=fileURLToPath(new URL('../../work/verification/activity-layout/',import.meta.url));await mkdir(evidence,{recursive:true})
const state=await isolatedProfile('activity-layout',{extraEnv:p=>({GROK_HOME:join(p,'grok'),GROK_AUTH_PATH:join(p,'grok/auth.json'),CODEX_HOME:join(p,'codex')})})
await writeFile(join(state.dshHome,'profiles/web/cordis.patch.yml'),JSON.stringify([{id:'workspace-controller',config:{documentsDirectory:state.documents}},{insert:[{id:'handoff-probe',name:fileURLToPath(new URL('./fixtures/handoff-probe.mjs',import.meta.url))},{id:'activity-probe',name:fileURLToPath(new URL('./fixtures/activity-probe.mjs',import.meta.url))}]}]))
let app,page,passed=false;const checks=[]
async function rpc(prefix,endpoint,payload={}){return page.evaluate(async({prefix,endpoint,payload})=>{const r=await(await fetch(prefix+'/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json();if(!r.ok)throw new Error(JSON.stringify(r.error));return r.value},{prefix,endpoint,payload})}
const probe=(e,p)=>rpc('/handoff-probe',e,p),fixture=(e,p)=>rpc('/activity-probe',e,p),info=()=>rpc('/fig-attention','dynamics')
const panel=()=>page.getByRole('button',{name:'任务动态',exact:true}).first().click()
const region=name=>page.getByRole('region',{name,exact:true})
async function capture(name){const shell=await readFile(new URL('../app/main/workbench.css',import.meta.url),'utf8');await writeFile(join(evidence,name+'.html'),await page.evaluate(shell=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,link,img').forEach(n=>n.remove());const style=document.createElement('style');style.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n')+'\n'+shell;clone.querySelector('head').append(style);return '<!doctype html>'+clone.outerHTML},shell));await page.screenshot({path:join(evidence,name+'.png')})}
try{
 app=await launchFig(state.env);page=await workbenchPage(app);await page.getByRole('button',{name:/^(继续|Continue)$/}).click();await panel()
 const a=await probe('parent',{workspacePath:state.documents,preset:'workspace-write',title:'界面简化方案',route:{provider:'synthetic-activity',model:'offline'}})
 await probe('followup',{id:a.id,text:'Offline layout result'});await until(async()=>!(await probe('state',{id:a.id})).running,{timeout:15000});await until(async()=>(await info()).rows.some(r=>r.results.length),{timeout:15000})
 const b=await probe('parent',{workspacePath:state.documents,preset:'workspace-write',title:'模型额度检查',route:{provider:'synthetic-activity',model:'offline'}})
 await fixture('configure',{fail:true,code:'CHATGPT_USAGE_LIMIT'});await probe('followup',{id:b.id,text:'Offline quota'});await until(async()=>(await info()).rows.some(r=>r.failures.length),{timeout:15000})
 await region('异常').getByText('额度已用尽',{exact:false}).waitFor();assert.equal(await region('额度受限').count(),0)
 const c=await probe('parent',{workspacePath:state.documents,preset:'workspace-write',title:'依赖修复确认',route:{provider:'synthetic-activity',model:'offline'}})
 await probe('hold',{id:c.id});await probe('followup',{id:c.id,text:'Hold offline'});await probe('attentionPending',{id:c.id});await until(async()=>{const row=(await info()).rows.find(r=>r.sessionId===c.id);return row?.running&&row.pendingKinds.length},{timeout:15000})
 await region('待处理').getByText('依赖修复确认',{exact:true}).waitFor();await region('运行中').getByText('依赖修复确认',{exact:true}).waitFor();checks.push({pendingRunningOverlap:true})
 const beforeUsage=await page.locator('[data-fig-usage]').innerHTML()
 await region('异常').locator('.fa-more summary').click();await region('异常').getByRole('button',{name:'稍后提醒',exact:true}).click();await until(async()=>!(await info()).rows.find(r=>r.sessionId===b.id).failures.length,{timeout:15000})
 await page.getByRole('button',{name:'撤销',exact:true}).click();await until(async()=>(await info()).rows.find(r=>r.sessionId===b.id).failures.length===1,{timeout:15000});checks.push({snoozeUndo:true,usageUnchanged:beforeUsage===await page.locator('[data-fig-usage]').innerHTML()});assert.ok(checks.at(-1).usageUnchanged)
 for(const theme of ['light','dark']){
  await page.setViewportSize({width:1200,height:1000});await page.locator('[data-slot="sidebar"]').first().locator('[data-slot="settings.launcher"] button[data-signed-out]').click();await page.getByRole('menuitem',{name:'主题外观',exact:true}).hover();await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
  for(const width of [1050,800,390]){await page.setViewportSize({width,height:1000});await page.locator('[data-fig-activity]').waitFor();await capture(`${theme}-${width}`);checks.push({theme,width,overflow:await page.locator('[data-fig-activity]').evaluate(n=>n.scrollWidth-n.clientWidth),columns:await page.locator('.fa-board').evaluate(n=>getComputedStyle(n).gridTemplateColumns)});assert.equal(checks.at(-1).overflow,0)}
 }
 await page.setViewportSize({width:1050,height:1000});await page.getByLabel('筛选项目').selectOption(a.workspaceId);assert.equal(await region('新结果').locator('article').count(),1);checks.push({projectFilter:true})
 await region('新结果').getByRole('button',{name:'已读',exact:true}).click();await until(async()=>(await info()).rows.find(r=>r.sessionId===a.id).results.length===0,{timeout:15000});checks.push({read:true})
 await region('异常').getByRole('button',{name:'知晓异常',exact:true}).click();await until(async()=>(await info()).rows.find(r=>r.sessionId===b.id).failures.every(f=>f.known),{timeout:15000});checks.push({quotaAcknowledge:true})
 await page.locator('.fa-known>summary').click();await region('已知晓').getByText('模型额度检查',{exact:true}).waitFor();checks.push({knownExpanded:true})
 passed=true;await writeFile(join(evidence,'result.json'),JSON.stringify({status:'pass',checks},null,2));console.log('PASS',evidence)
}finally{await app?.close();await cleanUp(state.profile,passed)}
