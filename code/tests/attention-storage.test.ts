import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createServer,request} from 'node:http'
import {randomBytes,randomUUID} from 'node:crypto'
// @ts-expect-error Host JS is checked separately by tsconfig.plugins.json.
import {apply} from '../harness/attention/index.js'
// @ts-expect-error Host JS is checked separately by tsconfig.plugins.json.
import {apply as applyShellBridge} from '../harness/shell-bridge/index.js'
import {DesktopAttention,readAttention} from '../app/main/attention'
import { tempDir } from './helpers/temp-dir.mjs'

test('F1 reading write failure and recovery never stop the actual notification bridge or Dock',async t=>{
 const home=await tempDir(t, 'fig-attention-storage-'),saved=process.env.DSH_HOME
 const capability=randomBytes(32).toString('hex'),generation=randomUUID(),routes:any[]=[],disposers:(()=>void)[]=[]
 const key=Symbol.for('fig.attention.bootstrap');(globalThis as any)[key]={capability,generation};process.env.DSH_HOME=home
 let handler:any,kinds:string[]=[],seq=0
 let cold:any[]=[]
 const effect=(run:any)=>{const dispose=run();if(typeof dispose==='function')disposers.push(dispose)}
 const scope={effect,connection:{requestRejection:()=>undefined},webServer:{register:(route:any)=>{routes.push(route);return()=>{}}}}
 // The task activity package offers its state as `figAttention`; Fig's shell-bridge serves it to main.
 const services:any={},provide=(name:string,value:any)=>{services[name]=value},get=(name:string)=>services[name]
 const ctx:any={on:(_name:string,fn:any)=>{handler=fn},effect,provide,get,inject:(_deps:any,run:any)=>run(scope),sessionController:{list:async()=>({items:[...cold,{sessionId:'root',running:false,agentAvailable:true}]}),state:async()=>({running:false,pendingInput:kinds,cursor:seq})},workspaceRegistry:{list:()=>[{id:'w',path:'/synthetic',sessionIds:['root']}],archivedSessionIds:[]}}
 const server=createServer((req,res)=>{const route=routes.find(r=>req.url?.startsWith(r.path+'/'));if(route)void route.handler(req,res);else{res.writeHead(404);res.end()}})
 let main:DesktopAttention|undefined
 const wait=async(fn:()=>Promise<any>)=>{for(let end=Date.now()+5000;Date.now()<end;await new Promise(r=>setTimeout(r,25)))if(await fn())return;throw Error('storage fixture timeout')}
 try{
  await apply(ctx)
  applyShellBridge({effect,provide,inject:(deps:string[],run:any)=>{assert.deepEqual(deps,['figAttention']);run({...scope,figAttention:services.figAttention,inject:(_d:any,r:any)=>r(scope)})}})
  assert.equal(services.shellCapabilities.alerts,true,'started with the desktop channel, the shell lends alerts')
  assert.equal((globalThis as any)[key],undefined,'the bootstrap is read once')
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const c={origin:`http://127.0.0.1:${(server.address() as any).port}`,capability,generation}
  const page=(endpoint:string):Promise<any>=>new Promise((resolve,reject)=>{const req=request(c.origin+'/fig-attention/'+endpoint,{method:'POST'},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve(JSON.parse(data).value))});req.on('error',reject);req.end('{}')})
  await wait(async()=>(await readAttention(c)).synced)
  const shown:any[]=[],badges:string[]=[]
  main=new DesktopAttention(home,{connection:()=>c,foreground:()=>false,execute:async()=>undefined,activate(){},badge:b=>badges.push(b),show:e=>shown.push(e)});await main.start()
  const path=join(home,'fig/attention/reading-state.json');await mkdir(path,{recursive:true})
  kinds=['approval'];handler({id:'root',header:{}},{seq:++seq,type:'turn/end',data:{turn:1,reason:{kind:'error'}}})
  await wait(async()=>(await page('dynamics')).readingHealthy===false || (await page('dynamics')).synced===false)
  assert.equal((await readAttention(c)).synced,true,'P1 disk failure must not stop P0 sampling')
  await wait(async()=>(await readAttention(c)).rows.some(r=>r.pendingKinds.includes('approval')))
  // An interval poll may be in flight; the badge is only set again when it changes.
  await wait(async()=>{await main!.poll();return badges.at(-1)==='1'&&shown.some(e=>e.kind==='failure')})
  await rm(path,{recursive:true,force:true})
  handler({id:'root',header:{}},{seq:++seq,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}})
  await wait(async()=>(await page('dynamics')).readingHealthy===true)
  assert.equal((await page('dynamics')).rows.find((r:any)=>r.sessionId==='root').failures.length,1,'failed write stays in memory and is persisted on recovery')
  cold=Array.from({length:1501},(_,i)=>({sessionId:'cold-'+i,running:false,agentAvailable:false}))
  await wait(async()=>(await page('dynamics')).rows.some((r:any)=>r.sessionId==='cold-0'))
  assert.equal((await readAttention(c)).synced,true,'G6 cold list growth must not stop input sampling')
  assert.equal((await readAttention(c)).rows.filter(r=>r.pendingKinds.length).length,1)
 }finally{main?.stop();for(const dispose of disposers.reverse())dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));delete(globalThis as any)[key];if(saved===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=saved }
})

test('preferences that can be neither read nor set aside fall back to defaults with a warning',async t=>{
 const home=await tempDir(t, 'fig-attention-prefs-'),saved=process.env.DSH_HOME,dir=join(home,'fig/attention'),disposers:(()=>void)[]=[],warnings:string[]=[]
 const {chmod,writeFile}=await import('node:fs/promises')
 process.env.DSH_HOME=home
 try{
  await mkdir(dir,{recursive:true});await writeFile(join(dir,'preferences.json'),'{"schema":1,"notifications":false,"dock":false}');await chmod(join(dir,'preferences.json'),0o000);await chmod(dir,0o555)
  const effect=(run:any)=>{const dispose=run();if(typeof dispose==='function')disposers.push(dispose)}
  const routes:any[]=[],scope={effect,connection:{requestRejection:()=>undefined},webServer:{register:(route:any)=>{routes.push(route);return()=>{}}}}
  const ctx:any={on(){},effect,provide(){},get(){},inject:(_deps:any,run:any)=>run(scope),logger:{warn:(m:string)=>warnings.push(m)},sessionController:{list:async()=>({items:[]}),state:async()=>({running:false,pendingInput:[]})},workspaceRegistry:{list:()=>[],archivedSessionIds:[]}}
  await apply(ctx)
  assert.equal(warnings.length,1);assert.match(warnings[0],/preferences unreadable, using defaults: EACCES/)
  assert.ok(routes.some(r=>r.path==='/fig-attention'),'the plugin still loads its routes')
 }finally{for(const dispose of disposers.reverse())dispose();await chmod(dir,0o755).catch(()=>{});if(saved===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=saved }
})
