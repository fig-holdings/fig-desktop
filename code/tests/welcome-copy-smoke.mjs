import assert from 'node:assert/strict'
import {mkdir, writeFile, readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isolatedProfile, launchFig, workbenchPage, cleanUp} from '../scripts/isolated-fig.mjs'
const evidence=fileURLToPath(new URL('../../work/verification/welcome-copy/',import.meta.url))
await mkdir(evidence,{recursive:true})
const state=await isolatedProfile('welcome-copy',{extraEnv:root=>({GROK_HOME:join(root,'grok'),GROK_AUTH_PATH:join(root,'grok/auth.json'),CODEX_HOME:join(root,'codex')})})
let app,page,passed=false
const checks=[],errors=[]
async function snapshot(name){
 // Electron insertCSS is user-origin; include it explicitly for standalone browser previews.
 const shellCss=await readFile(new URL('../app/main/workbench.css',import.meta.url),'utf8')
 await page.screenshot({path:join(evidence,name+'.png')})
 await writeFile(join(evidence,name+'.html'),await page.evaluate(shellCss=>{
  const clone=document.documentElement.cloneNode(true)
  clone.querySelectorAll('script,link').forEach(n=>n.remove())
  const style=document.createElement('style')
  style.textContent=[...document.styleSheets,...document.adoptedStyleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch{return []}}).join('\n')
  clone.querySelector('head').append(style)
  const shell=document.createElement('style');shell.textContent=shellCss;clone.querySelector('head').append(shell)
  return '<!doctype html>'+clone.outerHTML
 },shellCss))
}
async function language(english){
 await app.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
 await page.getByRole('button',{name:english?'通用设置':'General',exact:true}).click()
 await page.locator('button[aria-haspopup="menu"]',{hasText:english?'中文':'English'}).first().click()
 await page.getByRole('menu').last().getByRole('menuitem',{name:english?'English':'中文',exact:true}).click()
 await page.locator('[data-shortcut-modal="settings"]').getByRole('button',{name:english?'Close':'关闭',exact:true}).click()
}
try{
 app=await launchFig(state.env);page=await workbenchPage(app);page.on('pageerror',e=>errors.push(e.message))
 await page.getByRole('button',{name:/^(继续|Continue)$/}).click()
 await page.locator('[data-fig-welcome]').waitFor()
 const variant=await page.locator('[data-fig-welcome]').getAttribute('data-fig-welcome')
 const expected={zh:[['今天，从哪件事开始？','继续手头的项目，或开始一件新事。'],['有个想法？一起试试。','从一个问题、一份材料或一个项目开始。']],en:[['Where would you like to start today?','Pick up a project, or start something new.'],['Have an idea? Let’s try it out.','Start with a question, a document, or a project.']]}
 for(const lang of ['zh','en']){
  if(lang==='en')await language(true)
  assert.equal(await page.locator('[data-fig-welcome]').getAttribute('data-fig-welcome'),variant)
  assert.equal(await page.locator('[data-fig-welcome-headline]').innerText(),expected[lang][Number(variant)][0])
  assert.equal(await page.locator('[data-fig-welcome-subtitle]').innerText(),expected[lang][Number(variant)][1])
  for(const theme of ['light','dark']){
   await page.setViewportSize({width:1440,height:900})
   await page.locator('[data-slot="sidebar"]').first().locator('[data-slot="settings.launcher"] button[data-signed-out]').click()
   await page.getByRole('menuitem',{name:lang==='zh'?'主题外观':'Appearance',exact:true}).hover()
   await page.getByRole('menuitemradio',{name:lang==='zh'?(theme==='dark'?'深色':'浅色'):(theme==='dark'?'Dark':'Light'),exact:true}).click()
   for(const width of [1440,390]){
    await page.setViewportSize({width,height:900})
    if(width===390){await page.keyboard.press('Escape');await page.locator('[data-sidebar-opener]').click();await page.keyboard.press('Escape');await page.waitForTimeout(500)}
    const metrics=await page.locator('[data-fig-welcome]').evaluate(n=>{const h=n.querySelector('[data-fig-welcome-headline]'),b=n.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect();return {font:getComputedStyle(h).fontSize,align:getComputedStyle(n.parentElement).alignItems,center:Math.abs(b.x+b.width/2-p.x-p.width/2),overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth)}})
    assert.equal(metrics.font,width===390?'24px':'28px');assert.equal(metrics.align,'center');assert.ok(metrics.center<2,JSON.stringify(metrics));assert.equal(metrics.overflow,0)
    assert.equal(await page.locator('[data-fig-brand="hero-mark"]').isVisible(),false)
    assert.equal(await page.locator('[data-fig-welcome] > :not([data-fig-welcome-headline]):not([data-fig-welcome-subtitle])').evaluateAll(nodes=>nodes.some(n=>n.checkVisibility())),false)
    await snapshot(`${lang}-${theme}-${width}`);checks.push({lang,theme,width,variant,markVisible:false,badgeVisible:false,...metrics})
   }
  }
 }
 await page.setViewportSize({width:1440,height:900})
 await page.locator('[data-lexical-editor="true"]').first().fill('Draft stability check')
 assert.equal(await page.locator('[data-fig-welcome]').getAttribute('data-fig-welcome'),variant)
 checks.push('draft input retains variant; language and theme changes retain variant')
 assert.deepEqual(errors,[]);passed=true
 await writeFile(join(evidence,'result.json'),JSON.stringify({status:'pass',checks,errors},null,2));console.log('PASS',evidence)
}catch(error){await page?.screenshot({path:join(evidence,'failure.png')});throw error}finally{await app?.close();await cleanUp(state.profile,passed)}
