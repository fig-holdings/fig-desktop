import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {randomBytes,randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
test('one-use bootstrap pipe hides capability from original exec environment and preserves NODE_OPTIONS',async()=>{
 const capability=randomBytes(32).toString('hex'),generation=randomUUID()
 const child=spawn(process.execPath,['--import',fileURLToPath(new URL('../harness/shell-bridge/bootstrap.js',import.meta.url)),'--input-type=module','-e',`const key=Symbol.for('fig.attention.bootstrap');console.log(JSON.stringify({present:!!globalThis[key],options:process.env.NODE_OPTIONS,environment:!!process.env.FIG_ATTENTION_CAPABILITY}));setInterval(()=>{},1000)`],{env:{...process.env,NODE_OPTIONS:'--no-warnings'},stdio:['ignore','pipe','pipe','pipe']})
 let text='';child.stdout.on('data',c=>text+=c);child.stderr.on('data',c=>text+=c)
 child.stdio[3].end(JSON.stringify({capability,generation}))
 try{
  for(let end=Date.now()+5000;!text.includes('\n')&&Date.now()<end;)await new Promise(r=>setTimeout(r,10))
  assert.deepEqual(JSON.parse(text.split('\n')[0]),{present:true,options:'--no-warnings',environment:false})
  if(process.platform==='darwin'){const original=execFileSync('/bin/ps',['eww','-p',String(child.pid),'-o','command='],{encoding:'utf8'});assert.ok(!original.includes(capability));assert.ok(!original.includes(generation))}
 }finally{child.kill('SIGTERM');await once(child,'exit')}
})

test('truncated bootstrap never prints a capability in its parse error',async()=>{
 const capability=randomBytes(32).toString('hex')
 const child=spawn(process.execPath,['--import',fileURLToPath(new URL('../harness/shell-bridge/bootstrap.js',import.meta.url)),'-e',''],{stdio:['ignore','pipe','pipe','pipe']})
 let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c)
 child.stdio[3].end(JSON.stringify({capability}).slice(0,-1))
 const [code]=await once(child,'close');assert.notEqual(code,0);assert.match(output,/Invalid attention bootstrap/);assert.ok(!output.includes(capability))
})
