import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfile,launchFig,workbenchPage,cleanUp} from '../scripts/isolated-fig.mjs'
const evidence=fileURLToPath(new URL('../../work/verification/workbench-outputs/',import.meta.url));await mkdir(evidence,{recursive:true})
const state=await isolatedProfile('workbench-outputs',{extraEnv:root=>({GROK_HOME:join(root,'grok'),GROK_AUTH_PATH:join(root,'grok/auth.json'),CODEX_HOME:join(root,'codex')})})
await writeFile(join(state.dshHome,'profiles/web/cordis.patch.yml'),JSON.stringify([{id:'workspace-controller',config:{documentsDirectory:state.documents}},{insert:[{id:'handoff-probe',name:fileURLToPath(new URL('./fixtures/handoff-probe.mjs',import.meta.url))},{id:'outputs-probe',name:fileURLToPath(new URL('./fixtures/workbench-outputs-probe.mjs',import.meta.url))}]}]))
let app,page,passed=false;const checks=[]
async function probe(endpoint,payload){return page.evaluate(async({endpoint,payload})=>{const r=await(await fetch('/handoff-probe/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json();if(r.error)throw new Error(JSON.stringify(r));return r.value},{endpoint,payload})}
async function capture(name){await page.screenshot({path:join(evidence,name+'.png')});const shell=await readFile(new URL('../app/main/workbench.css',import.meta.url),'utf8');await writeFile(join(evidence,name+'.html'),await page.evaluate(shell=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,link,img').forEach(n=>n.remove());const style=document.createElement('style');style.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n')+'\n'+shell;clone.querySelector('head').append(style);return '<!doctype html>'+clone.outerHTML},shell))}
try{
 app=await launchFig(state.env);app.process().stderr?.on('data',chunk=>process.stderr.write(chunk));app.process().stdout?.on('data',chunk=>process.stdout.write(chunk));page=await workbenchPage(app);await page.getByRole('button',{name:/^(继续|Continue)$/}).click()
 const item=await probe('parent',{workspacePath:state.documents,preset:'workspace-write',title:'Session output documents'})
 await probe('hold',{id:item.id});await probe('followup',{id:item.id,text:'Offline output test'})
 for(let n=1;n<=6;n++)await probe('call',{id:item.id,name:'write',args:{file_path:join(state.documents,`output-document-${n}.md`),content:`# Output ${n}\nSession document preview.\n`}})
 await probe('call',{id:item.id,name:'write',args:{file_path:join(state.documents,'source.js'),content:'// not a document'}})
 await probe('call',{id:item.id,name:'edit',args:{file_path:join(state.documents,'output-document-1.md'),old_string:'Output 1',new_string:'Updated output 1'}})
 await page.evaluate(async({id,files})=>{const response=await fetch('/outputs-probe/declare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,files})});if(!response.ok)throw new Error(await response.text())},{id:item.id,files:Array.from({length:6},(_,i)=>({path:join(state.documents,`output-document-${i+1}.md`)}))})
 await probe('stop',{id:item.id})
 const group=page.locator(`[data-row-key="workspace:${item.workspaceId}"]`);await group.waitFor();if(await group.getAttribute('aria-expanded')!=='true')await group.click();await page.locator(`[data-row-key="session:${item.id}"]`).click()
 for(const theme of ['light','dark']){
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-slot="sidebar"]').first().locator('[data-slot="settings.launcher"] button[data-signed-out]').click();await page.getByRole('menuitem',{name:'主题外观',exact:true}).hover();await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});if(width===390){await page.locator('[data-sidebar-opener]').click();await page.keyboard.press('Escape');await page.waitForTimeout(300);await page.locator('[data-fig-workbench-button]').click()}
   const outputs=page.locator('[data-fig-workbench-outputs]');await outputs.waitFor();await outputs.locator('[data-fig-workbench-output]').first().waitFor();assert.equal(await outputs.locator('[data-fig-workbench-output]').count(),5)
   await outputs.getByRole('button',{name:'还有 1 个',exact:true}).click();assert.equal(await outputs.locator('[data-fig-workbench-output]').count(),6)
   assert.equal(await outputs.locator('[data-fig-workbench-output$="source.js"]').count(),0)
   const order=await outputs.evaluate(n=>Boolean(n.compareDocumentPosition(document.querySelector('[data-fig-workbench-tasks]'))&Node.DOCUMENT_POSITION_FOLLOWING));assert.equal(order,true)
   await capture(`${theme}-${width}`);checks.push({theme,width,count:6,overflow:await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)})
   await outputs.locator('[data-fig-workbench-output$="output-document-1.md"]').click();await page.getByText('Updated output 1',{exact:true}).waitFor();checks.push({theme,width,previewOpened:true})
   if(width===390)await page.keyboard.press('Escape')
   const close=page.locator('[data-sidebar-right-toggle]');if(await close.isVisible())await close.click()
   // Opening a preview unmounts a narrow card, resetting its Show more state; wide cards stay mounted.
   if(width===1440 && await outputs.getByRole('button',{name:'收起',exact:true}).isVisible())await outputs.getByRole('button',{name:'收起',exact:true}).click()
  }
 }
 passed=true;await writeFile(join(evidence,'result.json'),JSON.stringify({status:'pass',checks},null,2));console.log('PASS',evidence)
}catch(e){await page?.screenshot({path:join(evidence,'failure.png')});throw e}finally{await app?.close();await cleanUp(state.profile,passed)}
