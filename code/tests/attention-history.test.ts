import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {AttentionHistory} from '../harness/attention/history'
import { tempDir } from './helpers/temp-dir.mjs'
test('exact persisted reading/failure identities survive a new turn and restart; acknowledgement never swallows later results', async t => {
  const root = await tempDir(t, 'fig-reading-'), path = join(root,'reading-state.json')
  const end = (seq: number, kind = 'completed') => ({seq, time: seq * 100, type: 'turn/end', data: {turn: seq, reason: {kind}}})
  const history = await new AttentionHistory(path).load()
  await history.observe('a', end(1)); await history.observe('a', end(2,'error'))
  const clicked = history.get('a')!.results.map(r => r.identity), failure = history.get('a')!.failures[0].identity
  await history.observe('a', {seq: 3, type: 'turn/start', data: {turn: 3}})
  await history.observe('a', end(4))
  await history.acknowledge('a', clicked, 'read')
  assert.equal(history.get('a')!.results.length,1); assert.equal(history.get('a')!.results[0].seq,4)
  const time = history.get('a')!.lastSignificantAt
  await history.acknowledge('a',[failure],'known')
  assert.equal(history.get('a')!.failures[0].known,true); assert.equal(history.get('a')!.failures[0].ended,false)
  assert.equal(history.get('a')!.lastSignificantAt,time)
  const restarted = await new AttentionHistory(path).load()
  assert.deepEqual(restarted.get('a'),history.get('a')); assert.equal(restarted.get('a')!.readThrough,1)
  await restarted.observe('a',end(1)); assert.equal(restarted.get('a')!.results.length,1)
  await restarted.acknowledge('a',[failure],'end'); assert.equal(restarted.get('a')!.failures.length,0)
  const persisted = await readFile(path,'utf8'); assert.ok(!/prompt|message|credential/.test(persisted))
})

test('F1 history evicts only fully read, ended records before the 1501st session', async t => {
  const root=await tempDir(t, 'fig-retention-'),path=join(root,'reading-state.json')
  const {writeFile}=await import('node:fs/promises')
  await writeFile(path,JSON.stringify({schema:1,records:Array.from({length:1500},(_,i)=>({sessionId:'old-'+i,observedThrough:1,readThrough:1,results:[],failures:[],lastSignificantAt:i}))}))
  const h=await new AttentionHistory(path).load()
  await h.observe('new',{seq:2,time:9999,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
  assert.equal(h.get('old-0'),undefined);assert.equal(h.get('new')?.results.length,1)
  assert.equal(JSON.parse(await readFile(path,'utf8')).records.length,1500)
})

test('full unread retention degrades only reading health and never silently discards old identities',async t=>{
 const root=await tempDir(t, 'fig-full-unread-'),path=join(root,'reading-state.json')
 const {writeFile}=await import('node:fs/promises')
 await writeFile(path,JSON.stringify({schema:1,records:Array.from({length:1500},(_,i)=>({sessionId:'keep-'+i,observedThrough:1,readThrough:0,results:[{identity:'result-'+i,seq:1,turn:1,at:i}],failures:[],lastSignificantAt:i}))}))
 const h=await new AttentionHistory(path).load()
 await assert.rejects(h.observe('overflow',{seq:2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}),/bound/)
 assert.equal(h.healthy,false);assert.equal(h.get('keep-0')?.results[0].identity,'result-0')
 await h.acknowledge('keep-0',['result-0'],'read');assert.equal(h.healthy,true)
 await h.observe('overflow',{seq:2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
 assert.ok(h.get('overflow'));assert.equal(h.get('keep-0'),undefined)
})

test('records of sessions no longer listed are evicted after empty ones; listed unread records never are', async t => {
  const root = await tempDir(t, 'fig-unlisted-'), path = join(root, 'reading-state.json')
  const {writeFile} = await import('node:fs/promises')
  const unread = (id: string, at: number) => ({sessionId: id, observedThrough: 1, readThrough: 0, results: [{identity: 'result-' + id, seq: 1, turn: 1, at}], failures: [], lastSignificantAt: at})
  await writeFile(path, JSON.stringify({schema: 1, records: [
    ...Array.from({length: 1497}, (_, i) => unread('keep-' + i, 100 + i)),
    unread('gone-new', 50), unread('gone-old', 10),
    {sessionId: 'empty', observedThrough: 1, readThrough: 1, results: [], failures: [], lastSignificantAt: 5000}]}))
  const h = await new AttentionHistory(path).load()
  const end = (seq: number, time: number) => ({seq, time, type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}})
  // Before any list arrives, only the empty record may go.
  await h.observe('first', end(2, 9000))
  assert.equal(h.get('empty'), undefined); assert.ok(h.get('gone-old'))
  await assert.rejects(h.observe('second', end(2, 9001)), /bound/)
  h.listed(new Set(Array.from({length: 1497}, (_, i) => 'keep-' + i).concat('first')), 9000)
  await h.observe('second', end(2, 9001))
  assert.equal(h.get('gone-old'), undefined, 'the oldest unlisted record goes first'); assert.ok(h.get('gone-new'))
  assert.ok(h.get('keep-0')?.results.length, 'listed sessions keep their unread results')
  // A session newer than the last list may simply be missing from it and is kept.
  await h.observe('third', end(2, 9002))
  assert.equal(h.get('gone-new'), undefined); assert.ok(h.get('second'))
  await assert.rejects(h.observe('fourth', end(2, 9003)), /bound/)
  assert.ok(h.get('third') && h.get('second'))
})
