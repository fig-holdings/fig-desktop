import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {isolatedProfile,launchFig,cleanUp} from '../scripts/isolated-fig.mjs'
import {evidenceDir,insertProbes,openWorkbench,writeResult} from './helpers/fig-smoke.mjs'
const evidence=await evidenceDir('workbench-align')
const state=await isolatedProfile('workbench-align',{extraEnv:root=>({GROK_HOME:join(root,'grok'),GROK_AUTH_PATH:join(root,'grok/auth.json'),CODEX_HOME:join(root,'codex')})})
await insertProbes(state,['handoff-probe'])
let app,page,passed=false;const checks=[]
async function probe(endpoint,payload){return page.evaluate(async({endpoint,payload})=>(await(await fetch('/handoff-probe/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json()).value,{endpoint,payload})}
async function capture(name){await page.screenshot({path:join(evidence,name+'.png')});const shell=await readFile(new URL('../app/main/workbench.css',import.meta.url),'utf8');await writeFile(join(evidence,name+'.html'),await page.evaluate(shell=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,link,img').forEach(n=>n.remove());const style=document.createElement('style');style.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n')+'\n'+shell;clone.querySelector('head').append(style);return '<!doctype html>'+clone.outerHTML},shell))}
try{
 app=await launchFig(state.env);page=await openWorkbench(app)
 const item=await probe('parent',{workspacePath:state.documents,preset:'workspace-write',title:'Workbench alignment'})
 await probe('hold',{id:item.id});await probe('followup',{id:item.id,text:'Offline alignment test'})
 const group=page.locator(`[data-row-key="workspace:${item.workspaceId}"]`);await group.waitFor();if(await group.getAttribute('aria-expanded')!=='true')await group.click();await page.locator(`[data-row-key="session:${item.id}"]`).click()
 for(const theme of ['light','dark']){
  await page.setViewportSize({width:1200,height:900});await page.locator('[data-slot="sidebar"]').first().locator('[data-slot="settings.launcher"] button[data-signed-out]').click();await page.getByRole('menuitem',{name:'主题外观',exact:true}).hover();await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
  for(const width of [900,390]){
   await page.setViewportSize({width,height:900});if(width===390){await page.locator('[data-sidebar-opener]').click();await page.keyboard.press('Escape');await page.waitForTimeout(500)}
   const pop=page.locator('[data-fig-workbench="popover"]');await page.locator('[data-fig-workbench-button]').click();await pop.waitFor()
   await page.waitForTimeout(200)
   const metric=await pop.evaluate(n=>{const b=n.getBoundingClientRect(),content=document.querySelector('[data-conversation-content]'),edge=content.parentElement.getBoundingClientRect();return {right:b.right,edge:edge.right,overflow:document.documentElement.scrollWidth-innerWidth}})
   assert.ok(Math.abs(metric.edge-metric.right-12)<2,JSON.stringify(metric));assert.equal(metric.overflow,0);checks.push({theme,width,...metric});await capture(`${theme}-${width}`)
   await page.keyboard.press('Escape');await pop.waitFor({state:'hidden'})
  }
  await page.setViewportSize({width:1200,height:900});await page.locator('[data-sidebar-right-expand]').click();await page.waitForTimeout(400);await page.locator('[data-fig-workbench-button]').click();await page.locator('[data-fig-workbench="popover"]').waitFor();await capture(`${theme}-1200-right-sidebar`);await page.keyboard.press('Escape');await page.locator('[data-sidebar-right-toggle]').click()
 }
 await probe('stop',{id:item.id});passed=true;await writeResult(evidence,{status:'pass',checks});console.log('PASS',evidence)
}catch(e){await page?.screenshot({path:join(evidence,'failure.png')});throw e}finally{await app?.close();await cleanUp(state.profile,passed)}
