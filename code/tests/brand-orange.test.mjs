import test from 'node:test'
import assert from 'node:assert/strict'
import {brandTokens,brandCss,installBrand,surfaceTokens,teamDarkTokens,teamCss} from '../harness/desktop-skin/client-brand.js'
test('VI v0.4 semantic orange overrides retain semantic success/error colors',()=>{
 assert.equal(brandTokens['--dsw-alias-brand-primary'].light,'#ff6a1a')
 assert.equal(brandTokens['--dsw-alias-brand-primary'].dark,'#ff6a1a')
 assert.equal(brandTokens['--dsw-alias-button-info-fill'].light,'#ff6a1a')
 assert.ok(!Object.keys(brandTokens).some(key=>/success|error|warn/.test(key)))
 assert.match(brandCss,/1\.4s/);assert.match(brandCss,/1\.6s/);assert.match(brandCss,/prefers-reduced-motion/)
})
test('brand adapter depends on public override and read-only session status',()=>{
 const source=String(installBrand)
 assert.match(source,/theme\.overrideTokens/);assert.match(source,/sessionStatus\.subscribe/)
 assert.match(source,/disposeTokens\(\)/);assert.match(source,/stopLabels\(\)/);assert.match(source,/stopButtons\(\)/)
})
test('dark keeps two surfaces and two text greys; light three surfaces and two text greys',()=>{
 for(const name of ['--dsw-alias-bg-layer-1','--dsw-alias-bg-layer-2','--dsw-specific-input-major'])assert.deepEqual(surfaceTokens[name],{light:'var(--dsw-static-neutral-bluish-00)',dark:'var(--dsw-specific-sidebar-fill)'})
 assert.equal(surfaceTokens['--dsw-alias-label-primary'].dark,'rgba(255, 255, 255, .95)')
 assert.equal(surfaceTokens['--dsw-alias-label-secondary'].dark,'rgba(255, 255, 255, .5)');assert.equal(surfaceTokens['--dsw-alias-label-tertiary'].dark,'rgba(255, 255, 255, .5)');assert.equal(surfaceTokens['--dsw-alias-label-caption'].dark,'rgba(255, 255, 255, .5)')
 assert.deepEqual(surfaceTokens['--dsw-alias-bg-base'],{light:'var(--dsw-static-neutral-bluish-60)',dark:'var(--dsw-static-neutral-bluish-950)'})
 for(const name of ['secondary','tertiary','caption'])assert.equal(surfaceTokens['--dsw-alias-label-'+name].light,'rgba(0, 0, 0, .6)')
 assert.equal(surfaceTokens['--dsw-alias-label-primary'].light,'rgba(0, 0, 0, .95)')
 assert.equal(Object.keys(surfaceTokens).length,8)
 assert.match(String(installBrand),/surfaceTokens/)
})
test('team Profiles take OpenLLM two layers in dark only; light and the personal edition are unchanged',()=>{
 const dark=Object.fromEntries(Object.entries(teamDarkTokens).map(([key,value])=>[key,value.dark]))
 assert.deepEqual(dark,{'--dsw-alias-bg-base':'#010101','--dsw-specific-sidebar-fill':'#09090b','--dsw-alias-bg-layer-2':'rgba(255, 255, 255, .05)',
  '--dsw-specific-input-major':'#18181b','--dsw-specific-selector':'#2c2c2e','--dsw-alias-border-l2':'rgba(255, 255, 255, .1)',
  '--dsw-alias-border-l3':'rgba(255, 255, 255, .14)','--dsw-alias-interactive-bg-hover':'rgba(255, 255, 255, .06)'})
 // Light: the values the personal edition sees (surfaceTokens) or DSH's own.
 for(const name of ['--dsw-alias-bg-base','--dsw-alias-bg-layer-2','--dsw-specific-input-major'])assert.equal(teamDarkTokens[name].light,surfaceTokens[name].light)
 assert.deepEqual(surfaceTokens['--dsw-alias-bg-layer-1'].dark,'var(--dsw-specific-sidebar-fill)')
 assert.match(teamCss,/:root\[data-fig-team\] \.fig-ui-card/);assert.match(teamCss,/6\.5%/)
 assert.doesNotMatch(brandCss,/data-fig-team/)
})
test('the team layer replaces the same override source once the Profile reads team',async()=>{
 const calls=[],root=new Map(),head=[]
 globalThis.document={head:{append:node=>head.push(node)},documentElement:{setAttribute:(k,v)=>root.set(k,v),removeAttribute:k=>root.delete(k)},
  createElement:()=>({textContent:'',dataset:{},setAttribute(){},remove(){}}),createTreeWalker:()=>({nextNode:()=>false}),querySelectorAll:()=>[],querySelector:()=>null}
 globalThis.MutationObserver=class{observe(){}disconnect(){}takeRecords(){return[]}};globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{}
 globalThis.ResizeObserver=class{observe(){}disconnect(){}}
 const ctx={theme:{overrideTokens:(source,tokens)=>{calls.push([source,tokens]);return()=>{}}},uiSession:{sessionStatus:{getSnapshot:()=>new Map(),subscribe:()=>()=>{}}}}
 try{
  for(const edition of ['personal','team']){
   calls.length=0;root.clear()
   const dispose=installBrand(ctx,{ready:Promise.resolve({edition})});await new Promise(r=>setTimeout(r,0))
   assert.equal(calls.length,edition==='team'?2:1);assert.ok(calls.every(([source])=>source==='@local/dsh-desktop-skin'))
   assert.equal(calls.at(-1)[1]['--dsw-alias-bg-base'].dark,edition==='team'?'#010101':'var(--dsw-static-neutral-bluish-950)')
   assert.equal(root.has('data-fig-team'),edition==='team');dispose();assert.equal(root.has('data-fig-team'),false)
  }
 }finally{delete globalThis.document;delete globalThis.MutationObserver;delete globalThis.requestAnimationFrame;delete globalThis.cancelAnimationFrame;delete globalThis.ResizeObserver}
})
