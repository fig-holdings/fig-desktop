import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedProfile, launchFig, workbenchPage, cleanUp, until } from '../scripts/isolated-fig.mjs'
const evidence=fileURLToPath(new URL('../../work/verification/project-navigation-v2/',import.meta.url))
await mkdir(evidence,{recursive:true})
const state=await isolatedProfile('project-navigation',{extraEnv:root=>({GROK_HOME:join(root,'grok'),GROK_AUTH_PATH:join(root,'grok/auth.json'),CODEX_HOME:join(root,'codex')})})
await writeFile(join(state.dshHome,'profiles/web/cordis.patch.yml'),JSON.stringify([
  {id:'workspace-controller',config:{documentsDirectory:state.documents}},
  {insert:['handoff-probe','activity-probe'].map(id=>({id,name:fileURLToPath(new URL('./fixtures/'+id+'.mjs',import.meta.url))}))}
]))
let app,page,passed=false
const errors=[]
async function rpc(prefix,endpoint,payload={}) { const r=await page.evaluate(async ({prefix,endpoint,payload})=>(await fetch('/'+prefix+'/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json(),{prefix,endpoint,payload});assert.ok(r.ok,JSON.stringify(r));return r.value }
const probe=(endpoint,payload)=>rpc('handoff-probe',endpoint,payload)
const model={provider:'synthetic-activity',model:'offline'}
async function snapshot(name) {
  await page.screenshot({path:join(evidence,name+'.png')})
  await writeFile(join(evidence,name+'.html'),await page.evaluate(()=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,link').forEach(n=>n.remove());const style=document.createElement('style');style.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n');clone.querySelector('head').append(style);return '<!doctype html>'+clone.outerHTML}))
}
try {
  app=await launchFig(state.env);app.process().stderr?.on('data',data=>console.error(String(data)));page=await workbenchPage(app)
  page.on('pageerror',e=>errors.push(e.message))
  await page.getByRole('button',{name:/^(继续|Continue)$/}).click()
  const workspace=join(state.documents,'navigation-project');await mkdir(workspace,{recursive:true})
  const sessions=[];let workspaceId
  for(let i=0;i<11;i++) {
    const item=await probe('parent',{workspacePath:workspace,preset:'workspace-write',route:model,title:`Navigation session ${i+1}`})
    workspaceId=item.workspaceId;sessions.push(item.id)
    await probe('followup',{id:item.id,text:`Offline message ${i+1}`})
    await until(async()=>!(await probe('state',{id:item.id})).running)
  }
  await page.locator('[data-row-key^="workspace:"]').first().waitFor()
  await page.locator(`[data-row-key="workspace:${workspaceId}"]`).click({button:'right'})
  await page.getByRole('menuitem',{name:'图标与颜色…',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'图标与颜色'})
  assert.equal(await dialog.locator('.fig-nav-icons button').count(),60)
  assert.deepEqual(await dialog.locator('.fig-nav-colors button').evaluateAll(nodes=>nodes.slice(0,5).map(n=>n.getAttribute('aria-label'))),['红色','绿色','蓝色','橙色','黄色'])
  await dialog.getByRole('button',{name:'绿色',exact:true}).click();await dialog.getByRole('button',{name:'flask',exact:true}).click();await snapshot('light-editor');await dialog.getByRole('button',{name:'保存',exact:true}).click()
  await dialog.waitFor({state:'hidden'})
  assert.deepEqual((await rpc('fig-project-navigation','list'))[workspaceId],{icon:'flask',color:'green'})
  await page.locator('[data-fig-project-icon] [data-fig-nav-host] svg').waitFor()
  assert.equal(await page.locator('[data-fig-project-icon] [data-fig-nav-host] svg').getAttribute('width'),'16')
  const group=page.locator(`[data-row-key="workspace:${workspaceId}"]`)
  if(await group.getAttribute('aria-expanded')!=='true')await group.click()
  await page.locator('[data-fig-project-cell]').first().waitFor()
  await page.locator('[data-fig-project-cell] [data-fig-nav-host]').first().hover()
  assert.match(await page.locator('.fig-nav-tooltip').innerText(),/navigation-project/)
  await snapshot('light-grouped')
  await page.reload();await page.locator('[data-fig-project-icon] [data-fig-nav-host] svg').waitFor()
  const sidebar=page.locator('[data-slot="sidebar"]').first()
  await sidebar.getByRole('button',{name:'视图选项',exact:true}).click()
  await page.getByRole('menu').getByText('单列表',{exact:true}).click()
  await page.locator('[data-fig-project-cell]').first().waitFor()
  await page.locator('[data-fig-project-cell] [data-fig-nav-host]').first().hover();await page.locator('.fig-nav-tooltip').waitFor()
  assert.match(await page.locator('.fig-nav-tooltip').innerText(),/navigation-project/)
  await probe('hold',{id:sessions[10]});await probe('followup',{id:sessions[10],text:'Hold offline'})
  const running=page.locator(`[data-row-key="session:${sessions[10]}"] [data-fig-nav-host] [data-state="running"]`)
  await running.waitFor()
  await sidebar.getByRole('button',{name:'视图选项',exact:true}).click()
  await page.getByRole('menu').getByText('按工作区',{exact:true}).click()
  if(await group.getAttribute('aria-expanded')!=='true')await group.click()
  await running.waitFor()
  await sidebar.getByRole('button',{name:'视图选项',exact:true}).click()
  await page.getByRole('menu').getByText('单列表',{exact:true}).click()
  await sidebar.getByRole('button',{name:'收起左侧栏',exact:true}).click()
  await page.locator('.fig-nav-rail').waitFor();assert.equal(await page.locator('.fig-nav-rail [data-fig-recent-session]').count(),5)
  const searchBox=await sidebar.getByRole('button',{name:'搜索会话',exact:true}).boundingBox(),railBox=await page.locator('.fig-nav-rail').boundingBox()
  assert.ok(searchBox.y+searchBox.height<=railBox.y,'recent dots are below search')
  await page.locator('[data-fig-recent-more]').click();assert.equal(await page.locator('.fig-nav-menu [data-fig-recent-session]').count(),5)
  await page.keyboard.press('Escape');assert.equal(await page.locator('.fig-nav-menu').count(),0)
  await page.locator('[data-fig-recent-more]').click();const target=await page.locator('.fig-nav-menu [data-fig-recent-session]').first().getAttribute('data-fig-recent-session');await page.keyboard.press('Enter')
  await page.locator(`[data-slot="main.conversation"] [data-conversation-session="${target}"]`).waitFor()
  assert.equal(await page.locator('.fig-nav-rail').count(),1)
  for(const theme of ['light','dark']) {
    await sidebar.locator('[data-slot="settings.launcher"] button[data-signed-out]').click()
    await page.getByRole('menuitem',{name:'主题外观'}).hover();await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900})
      if(width===390) {
        await page.getByRole('button',{name:'展开左侧栏',exact:true}).first().click()
        await page.locator('[data-fig-project-cell]').first().waitFor()
      } else {
        await page.locator('[data-fig-recent-more]').click();await page.locator('.fig-nav-menu').waitFor()
      }
      assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0)
      await snapshot(`${theme}-${width}-${width===390?'drawer':'rail'}`)
      await page.keyboard.press('Escape')
    }
    await page.setViewportSize({width:1440,height:900})
  }
  await probe('attentionPending',{id:sessions[10]})
  await page.getByRole('button',{name:'展开左侧栏',exact:true}).first().click()
  await page.locator(`[data-row-key="session:${sessions[10]}"] [data-state="waiting"]`).waitFor()
  assert.equal(await page.locator(`[data-row-key="session:${sessions[10]}"] [data-fig-project-cell]`).getAttribute('data-fig-project-cell'),'preserve')
  await probe('attentionPending',{id:sessions[10],cancel:true})
  await probe('stop',{id:sessions[10]})
  await page.locator(`[data-row-key="session:${sessions[10]}"] [data-state="idle"]`).waitFor()
  await sidebar.getByRole('button',{name:'视图选项',exact:true}).click()
  await page.getByRole('menu').getByText('按工作区',{exact:true}).click()
  for(const theme of ['light','dark']) {
    await sidebar.locator('[data-slot="settings.launcher"] button[data-signed-out]').click()
    await page.getByRole('menuitem',{name:'主题外观'}).hover()
    await page.getByRole('menuitemradio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900})
      if(width===390)await page.getByRole('button',{name:'展开左侧栏',exact:true}).first().click()
      await group.waitFor({state:'visible'})
      if(await group.getAttribute('aria-expanded')!=='true')await group.click()
      await page.locator('[data-fig-project-cell]').first().waitFor()
      await snapshot(`${theme}-${width}-grouped`)
      await group.click({button:'right'})
      const appearance = page.getByRole('menuitem',{name:'图标与颜色…',exact:true})
      const glyph = appearance.locator('svg')
      await glyph.waitFor({state:'visible'})
      assert.equal(await glyph.getAttribute('aria-hidden'),'true')
      const box=await appearance.boundingBox()
      assert.ok(box && box.x>=0 && box.x+box.width<=width,'appearance menu item fits in the viewport')
      assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0)
      await snapshot(`${theme}-${width}-appearance-menu`)
      await appearance.click()
      await dialog.waitFor()
      assert.equal(await dialog.locator('.fig-nav-colors button').count(),16)
      await dialog.getByRole('button',{name:'浅蓝',exact:true}).click()
      await dialog.getByRole('button',{name:'robot',exact:true}).click()
      await snapshot(`${theme}-${width}-editor`)
      assert.equal(await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth)),0)
      await dialog.getByRole('button',{name:'取消',exact:true}).click()
      if(width===390)await page.keyboard.press('Escape')
    }
    await page.setViewportSize({width:1440,height:900})
  }
  await sidebar.getByRole('button',{name:'插件',exact:true}).click()
  // Since 0.1.54 Fig's own packages are listed under the 个人版插件 tab (自定义插件 before 0.1.103).
  await page.getByRole('tab',{name:'个人版插件',exact:true}).click()
  const toggle=page.getByRole('switch',{name:'启用 项目导航',exact:true})
  await toggle.click()
  await until(async()=>await toggle.getAttribute('aria-checked')==='false')
  await page.waitForFunction(()=>document.querySelectorAll('[data-fig-project-cell]').length===0)
  assert.equal(await page.locator('[data-fig-nav-host]').count(),0)
  await toggle.click()
  await until(async()=>await toggle.getAttribute('aria-checked')==='true',{timeout:30000})
  await page.getByRole('button',{name:'展开左侧栏',exact:true}).count().then(async n=>{if(n)await page.getByRole('button',{name:'展开左侧栏',exact:true}).first().click()})
  await page.locator('[data-fig-project-cell]').first().waitFor()
  assert.deepEqual(errors,[])
  passed=true
  await writeFile(join(evidence,'result.json'),JSON.stringify({status:'pass',themes:['light','dark'],widths:[1440,390],errors,interactions:['60 icons at 16px','16 colors / primary-first order','grouped dots / hover / running','grouped and editor light/dark 1440/390','project menu','icon/color/save','reload persistence','flat dots/hover','native running','native pending approval preserved','stop becomes idle','rail below search','rail 5 + menu 5','Escape/keyboard navigation','open without expansion','disable restores original / re-enable'],overflow:0},null,2))
} catch(error) {await page?.screenshot({path:join(evidence,'failure.png')});console.error(await page?.locator('[data-slot="sidebar"]').innerText());throw error}
finally {await app?.close();await cleanUp(state.profile,passed)}
