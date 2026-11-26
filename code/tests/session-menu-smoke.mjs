import assert from 'node:assert/strict'
import {writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {isolatedProfile,launchFig,workbenchPage,cleanUp} from '../scripts/isolated-fig.mjs'
import {evidenceDir,insertProbes,writeResult} from './helpers/fig-smoke.mjs'
const evidence=await evidenceDir('session-menu')
const state=await isolatedProfile('session-menu',{extraEnv:root=>({GROK_HOME:join(root,'grok'),GROK_AUTH_PATH:join(root,'grok/auth.json'),CODEX_HOME:join(root,'codex')})})
await insertProbes(state,['handoff-probe'])
let app,page,passed=false;const errors=[],checks=[],launches=[]
async function snap(name){const icons=await page.evaluate(async()=>Object.fromEntries(await Promise.all([...new Set([...document.images].map(n=>n.src).filter(src=>src.includes('/open-in-app/icon/')))].map(async src=>{const blob=await(await fetch(src)).blob();return [src,await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob)})]}))));await page.screenshot({path:join(evidence,name+'.png')});const shell=await readFile(new URL('../app/main/workbench.css',import.meta.url),'utf8');await writeFile(join(evidence,name+'.html'),await page.evaluate(({shell,icons})=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('img').forEach(img=>{if(icons[img.src])img.src=icons[img.src]});clone.querySelectorAll('script,link').forEach(n=>n.remove());const style=document.createElement('style');style.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n')+'\n'+shell;clone.querySelector('head').append(style);return '<!doctype html>'+clone.outerHTML},{shell,icons}))}
try{
 app=await launchFig(state.env);page=await workbenchPage(app);page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')console.error('BROWSER',msg.text())})
 await page.route('**/open-in-app/apps',route=>route.fulfill({json:{apps:['sublimetext','finder']}}))
 await page.route('**/open-in-app/open',route=>{launches.push(route.request().postDataJSON());return route.fulfill({json:{kind:'opened'}})})
 await page.getByRole('button',{name:/^(继续|Continue)$/}).click()
 const item=await page.evaluate(async workspacePath=>(await(await fetch('/handoff-probe/parent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspacePath,preset:'workspace-write',title:'Session menu offline check'})})).json()).value,state.documents)
 await page.evaluate(async id=>{await fetch('/handoff-probe/followup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,text:'Offline menu check'})})},item.id)
 const group=page.locator(`[data-row-key="workspace:${item.workspaceId}"]`);await group.waitFor();if(await group.getAttribute('aria-expanded')!=='true')await group.click()
 await page.locator(`[data-row-key="session:${item.id}"]`).click()
 await page.getByRole('button',{name:'更多会话视图'}).waitFor()
 for(const theme of ['light','dark']){
  await page.setViewportSize({width:1440,height:900})
  await page.locator('[data-slot="sidebar"]').first().locator('[data-slot="settings.launcher"] button[data-signed-out]').click()
  await page.getByRole('menuitem',{name:'主题外观',exact:true}).hover();await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:900});if(width===390){await page.locator('[data-sidebar-opener]').click();await page.keyboard.press('Escape');await page.waitForTimeout(500)}
   assert.equal(await page.locator('[data-slot="conversation.session.header.utilities"] [data-open-target="directory"]').isVisible(),false)
   await page.getByRole('button',{name:'更多会话视图'}).click()
   await page.getByRole('menuitem',{name:'规则来源',exact:true}).waitFor()
   const local=page.getByRole('menuitem',{name:/^(在本地打开|在应用中打开) ›$/});await local.click()
   await page.getByRole('menuitem',{name:/^Sublime Text/}).waitFor()
   await snap(`${theme}-${width}-local`)
   assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0)
   await page.keyboard.press('Escape');await page.keyboard.press('Escape')
   await page.getByRole('button',{name:'更多会话视图'}).click();await page.getByRole('menuitem',{name:'规则来源',exact:true}).click()
   await page.getByRole('dialog').filter({hasText:'规则来源'}).waitFor();await snap(`${theme}-${width}-rules`)
   await page.getByRole('button',{name:'关闭',exact:true}).click();checks.push({theme,width})
  }
 }
 await page.setViewportSize({width:1440,height:900});await page.getByRole('button',{name:'更多会话视图'}).click();await page.getByRole('menuitem',{name:/^(在本地打开|在应用中打开) ›$/}).click();await page.getByRole('menuitem',{name:/^Sublime Text/}).click()
 assert.equal(launches.length,1);assert.equal(launches[0].app,'sublimetext')
 assert.deepEqual(errors,[]);passed=true;await writeResult(evidence,{status:'pass',checks,launches,scope:'isolated UI with intercepted local application launch; no external app opened',errors});console.log('PASS',evidence)
}catch(e){console.error('PAGE ERRORS',errors);console.error(await page?.locator('[data-fig-open-local]').count());await page?.screenshot({path:join(evidence,'failure.png')});throw e}finally{await app?.close();await cleanUp(state.profile,passed)}
