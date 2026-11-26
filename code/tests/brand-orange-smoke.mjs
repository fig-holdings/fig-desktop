import assert from 'node:assert/strict'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfile,launchFig,workbenchPage,cleanUp} from '../scripts/isolated-fig.mjs'
const evidence=fileURLToPath(new URL('../../work/verification/brand-orange/',import.meta.url))
await mkdir(evidence,{recursive:true})
const state=await isolatedProfile('brand-orange',{extraEnv:root=>({GROK_HOME:join(root,'grok'),GROK_AUTH_PATH:join(root,'grok/auth.json'),CODEX_HOME:join(root,'codex')})})
await writeFile(join(state.dshHome,'profiles/web/cordis.patch.yml'),JSON.stringify([{id:'workspace-controller',config:{documentsDirectory:state.documents}},{insert:['handoff-probe','activity-probe'].map(id=>({id,name:fileURLToPath(new URL('./fixtures/'+id+'.mjs',import.meta.url))}))}]))
let app,page,passed=false;const errors=[],checks=[]
const bg=el=>el.evaluate(n=>getComputedStyle(n).backgroundColor)
async function probe(endpoint,payload={}){const r=await page.evaluate(async({endpoint,payload})=>(await fetch('/handoff-probe/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json(),{endpoint,payload});assert.ok(r.ok,JSON.stringify(r));return r.value}
async function snapshot(name){await page.screenshot({path:join(evidence,name+'.png')});await writeFile(join(evidence,name+'.html'),await page.evaluate(()=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,link').forEach(n=>n.remove());const s=document.createElement('style');s.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n');clone.querySelector('head').append(s);return '<!doctype html>'+clone.outerHTML}))}
try{
 app=await launchFig(state.env);page=await workbenchPage(app);page.on('pageerror',e=>errors.push(e.message))
 await page.addStyleTag({content:await readFile(new URL('../app/main/workbench.css',import.meta.url),'utf8')})
 await page.getByRole('button',{name:/^(继续|Continue)$/}).click()
 const item=await probe('parent',{workspacePath:state.documents,preset:'workspace-write',route:{provider:'synthetic-activity',model:'offline'},title:'Brand verification'})
 await probe('hold',{id:item.id});await probe('followup',{id:item.id,text:'Offline brand state'})
 const group=page.locator(`[data-row-key="workspace:${item.workspaceId}"]`);await group.waitFor();if(await group.getAttribute('aria-expanded')!=='true')await group.click()
 await page.locator(`[data-row-key="session:${item.id}"]`).click()
 await page.locator('[data-fig-state-mark="running"]').first().waitFor()
 const sidebar=page.locator('[data-slot="sidebar"]').first()
 for(const theme of ['light','dark']){
  await page.setViewportSize({width:1440,height:900})
  await sidebar.locator('[data-slot="settings.launcher"] button[data-signed-out]').click()
  await page.getByRole('menuitem',{name:'主题外观'}).hover();await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
  await page.emulateMedia({colorScheme:theme,reducedMotion:'no-preference'})
  const fresh=sidebar.locator('button[class*="_newSession"]').first()
  await page.mouse.move(800,100);assert.equal(await bg(fresh),'rgb(255, 106, 26)')
  await fresh.hover();await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-slot="sidebar"] button[class*="_newSession"]')).backgroundColor!=='rgb(255, 106, 26)');assert.notEqual(await bg(fresh),'rgb(255, 106, 26)');checks.push(theme+' new-session hover')
  await page.waitForFunction(()=>document.querySelector('[data-chat-running]')?.textContent.includes('推理执行中'))
   assert.ok(!(await page.locator('[data-chat-running]').innerText()).includes('深度求索中'));checks.push(theme+' Chinese running label')
   const continuity=await page.evaluate(()=>new Promise(resolve=>{
    const started=performance.now(),values=new Set(),bad=[];let frames=0
    function sample(){const row=document.querySelector('[data-chat-running]');const visible=row?.querySelector('[class*="_runningText"]');const base=visible?.querySelector('[class*="_text_"]:not([data-shimmer-text])')?.textContent;const overlay=visible?.querySelector('[data-shimmer-text]');const shimmer=overlay?.getAttribute('data-shimmer-text');frames++;values.add(base);if(!base?.startsWith('推理执行中')||base!==shimmer||getComputedStyle(overlay,'::after').content.includes('深度求索中'))bad.push({base,shimmer});if(performance.now()-started<4200)requestAnimationFrame(sample);else resolve({frames,values:[...values],bad})}requestAnimationFrame(sample)
   }));assert.deepEqual(continuity.bad,[]);assert.ok(continuity.values.length>=3,JSON.stringify(continuity));checks.push(theme+' continuous clock/shimmer agreement '+continuity.frames+' frames')
   const mark=page.locator('[data-chat-running] [data-fig-state-mark]')
  assert.equal(await mark.locator('.fig-signal').evaluate(n=>getComputedStyle(n).animationDuration),'1.4s')
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});if(width===390){await page.keyboard.press('Escape');await page.locator('[data-sidebar-opener]').click();await page.keyboard.press('Escape')}await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0);await snapshot(`${theme}-${width}-running`)}
  await page.setViewportSize({width:1440,height:900})
  await page.waitForTimeout(300);if(!await page.locator('[data-fig-sidebar-settings]').isVisible())await page.locator('[data-fig-rail-toggle]:visible,[data-sidebar-opener]:visible').first().click()
  const execute=page.locator('[data-composer-seat] button[class*="_primary"]').first();assert.equal(await bg(execute),'rgb(255, 106, 26)');assert.equal(await execute.evaluate(n=>getComputedStyle(n).color),'rgb(255, 255, 255)');checks.push(theme+' execute orange and foreground')
  await probe('attentionPending',{id:item.id});await page.locator('[data-chat-running] [data-fig-state-mark="waiting"]').waitFor()
  assert.equal(await mark.locator('.fig-ripple').evaluate(n=>getComputedStyle(n).animationDuration),'1.6s')
  await snapshot(`${theme}-1440-waiting`)
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await mark.locator('.fig-ripple').evaluate(n=>getComputedStyle(n).animationName),'none');checks.push(theme+' running/waiting/reduced-motion')
  await probe('attentionPending',{id:item.id,cancel:true})
  await page.locator('[data-fig-sidebar-settings]').click();await page.getByRole('button',{name:'通用设置',exact:true}).click()
  const toggle=page.getByRole('switch').first();await page.mouse.move(800,100);if(await toggle.getAttribute('aria-checked')==='true')assert.equal(await bg(toggle),'rgb(255, 106, 26)');const before=await toggle.getAttribute('aria-checked');await toggle.click();await page.waitForFunction(before=>document.querySelector('[role="switch"]').getAttribute('aria-checked')!==before,before);await toggle.click();if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click();assert.equal(await toggle.locator(':scope > span').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(255, 255, 255)');checks.push(theme+' settings switch roundtrip and thumb foreground')
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});await snapshot(`${theme}-${width}-settings`)}
  await page.setViewportSize({width:1440,height:900});await page.locator('[data-shortcut-modal="settings"]').getByRole('button', { name: '关闭', exact: true }).click()
  await probe('stop',{id:item.id});await sidebar.getByRole('button',{name:'插件',exact:true}).click();const create=page.getByRole('button',{name:/新建插件|添加插件/}).first();await create.waitFor();await page.waitForFunction(()=>!document.querySelector('button[aria-label="添加插件"]').disabled);await page.mouse.move(800,100);assert.equal(await bg(create),'rgb(255, 106, 26)');await create.hover();await page.waitForTimeout(200);assert.notEqual(await bg(create),'rgb(255, 106, 26)');await snapshot(`${theme}-1440-plugins`);checks.push(theme+' create-plugin hover');await page.locator(`[data-row-key="session:${item.id}"]`).click();await probe('followup',{id:item.id,text:'Offline continue'});await page.locator('[data-chat-running] [data-fig-state-mark="running"]').waitFor()
 }
 await probe('stop',{id:item.id});assert.deepEqual(errors,[])
 passed=true;await writeFile(join(evidence,'result.json'),JSON.stringify({status:'pass',checks,themes:['light','dark'],widths:[1440,390],overflow:0,errors},null,2));console.log('PASS',evidence)
}catch(e){await page?.screenshot({path:join(evidence,'failure.png')});console.error(errors);console.error(await page?.getByRole('button',{name:/新建插件|添加插件/}).evaluateAll(nodes=>nodes.map(n=>({html:n.outerHTML,background:getComputedStyle(n).background,hover:n.matches(':hover'),disabled:n.disabled}))));throw e}finally{await app?.close();await cleanUp(state.profile,passed)}
