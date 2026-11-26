import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfile,launchFig,workbenchPage,cleanUp} from '../scripts/isolated-fig.mjs'
const evidence=fileURLToPath(new URL('../../work/verification/rightbar-header/',import.meta.url));await mkdir(evidence,{recursive:true})
const state=await isolatedProfile('rightbar-header',{extraEnv:root=>({GROK_HOME:join(root,'grok'),GROK_AUTH_PATH:join(root,'grok/auth.json'),CODEX_HOME:join(root,'codex')})})
await writeFile(join(state.dshHome,'profiles/web/cordis.patch.yml'),JSON.stringify([{id:'workspace-controller',config:{documentsDirectory:state.documents}},{insert:[{id:'handoff-probe',name:fileURLToPath(new URL('./fixtures/handoff-probe.mjs',import.meta.url))},{id:'outputs-probe',name:fileURLToPath(new URL('./fixtures/workbench-outputs-probe.mjs',import.meta.url))}]}]))
let app,page,passed=false;const checks=[],errors=[]
async function probe(endpoint,payload){return page.evaluate(async({endpoint,payload})=>{const r=await(await fetch('/handoff-probe/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json();if(r.error)throw new Error(JSON.stringify(r));return r.value},{endpoint,payload})}
async function capture(name){await page.screenshot({path:join(evidence,name+'.png')});const shell=await readFile(new URL('../app/main/workbench.css',import.meta.url),'utf8');await writeFile(join(evidence,name+'.html'),await page.evaluate(shell=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,link,img').forEach(n=>n.remove());const style=document.createElement('style');style.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n')+'\n'+shell;clone.querySelector('head').append(style);return '<!doctype html>'+clone.outerHTML},shell))}
try{
 app=await launchFig(state.env);app.process().stderr?.on('data',c=>process.stderr.write(c));app.process().stdout?.on('data',c=>process.stdout.write(c));page=await workbenchPage(app);page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:/^(继续|Continue)$/}).click()
 const item=await probe('parent',{workspacePath:state.documents,preset:'workspace-write',title:'Right sidebar header regression'})
 await probe('hold',{id:item.id});await probe('followup',{id:item.id,text:'Offline right sidebar test'})
 await probe('call',{id:item.id,name:'write',args:{file_path:join(state.documents,'task-activity-redesign-mock-with-a-very-long-document-title.html'),content:'<!doctype html><html><body><h1>Right sidebar preview fixture</h1></body></html>'}})
 await page.evaluate(async({id,path})=>{await fetch('/outputs-probe/declare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,files:[{path}]})})},{id:item.id,path:join(state.documents,'task-activity-redesign-mock-with-a-very-long-document-title.html')})
 await probe('stop',{id:item.id})
 const group=page.locator(`[data-row-key="workspace:${item.workspaceId}"]`);await group.waitFor();if(await group.getAttribute('aria-expanded')!=='true')await group.click();await page.locator(`[data-row-key="session:${item.id}"]`).click()
 await page.setViewportSize({width:1440,height:900});await page.locator('[data-fig-workbench-output]').first().click();await page.locator('[data-rightbar-col] [data-dockkit-pane]').first().waitFor()
 await page.waitForFunction(()=>!document.querySelector('[data-sidebar-right-opening]'))
 for(const theme of ['light','dark']){
  await page.setViewportSize({width:1440,height:900});await page.locator('[data-sidebar-right-toggle]').click()
  await page.locator('[data-slot="sidebar"]').first().locator('[data-slot="settings.launcher"] button[data-signed-out]').click();await page.getByRole('menuitem',{name:'主题外观',exact:true}).hover();await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
  await page.locator('[data-sidebar-right-expand]').click()
  for(const width of [1440,900,600,390]){
   await page.setViewportSize({width,height:900});await page.waitForTimeout(400)
   const pane=page.locator('[data-rightbar-col] [data-dockkit-pane]').first()
   const layout=await pane.evaluate(n=>{const path=n.querySelector('[data-textpreview-path]'),title=n.querySelector('[data-dockkit-tab-title]'),text=path.firstElementChild;const rect=path.getBoundingClientRect();return {mask:getComputedStyle(path).maskImage,titleMask:getComputedStyle(title).maskImage,ellipsis:getComputedStyle(text).textOverflow,directoryHidden:getComputedStyle(text.firstElementChild).display==='none',pathWidth:rect.width,overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),buttons:[...n.querySelectorAll('[data-dockkit-add-tab], [data-dockkit-split-button], [data-sidebar-right-toggle], [data-textpreview-tool="reload"], [data-document-viewer-menu], [data-files-navigator-toggle]')].map(b=>({label:b.getAttribute('aria-label'),left:b.getBoundingClientRect().left,right:b.getBoundingClientRect().right,width:b.getBoundingClientRect().width}))}})
   assert.equal(layout.mask,'none');assert.equal(layout.titleMask,'none');assert.equal(layout.ellipsis,'ellipsis');assert.equal(layout.directoryHidden,true);assert.ok(layout.pathWidth>30);assert.equal(layout.overflow,0)
   for(const b of layout.buttons)assert.ok(b.left>=0&&b.right<=width+1&&b.width>=20,JSON.stringify({width,b}))
   await capture(`${theme}-${width}`);checks.push({theme,width,...layout})
   await pane.locator('[data-textpreview-tool="reload"]').click();await pane.locator('[data-document-viewer-menu]').click();await page.getByRole('menu').waitFor();await page.keyboard.press('Escape')
  }
 }
 assert.deepEqual(errors,[]);passed=true;await writeFile(join(evidence,'result.json'),JSON.stringify({status:'pass',checks,errors,interactions:['document preview opened','reload clicked','viewer menu opened and Escape closed','rightbar collapsed and expanded'],scope:'isolated synthetic documents, no real accounts or external app launch'},null,2));console.log('PASS',evidence)
}catch(e){await page?.screenshot({path:join(evidence,'failure.png')});throw e}finally{await app?.close();await cleanUp(state.profile,passed)}
