import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { colors, icons, validAppearance, recentSessions, sessionState } from '../harness/project-navigation/model.js'
import { appearanceStore } from '../harness/project-navigation/store.js'
import { tempDir } from './helpers/temp-dir.mjs'

test('project appearance accepts only built-in icons and colors', () => {
  assert.equal(Object.keys(icons).length,60);assert.equal(Object.keys(colors).length,16)
  assert.deepEqual(Object.keys(colors).slice(0,5),['red','green','blue','orange','yellow'])
  assert.ok(Object.keys(colors).indexOf('light-blue') > Object.keys(colors).indexOf('yellow'))
  assert.ok(validAppearance({icon:'robot',color:'deep-red'}))
  assert.ok(validAppearance({icon:'flask',color:'green'}))
  assert.ok(!validAppearance({icon:'__proto__',color:'green'}))
  assert.ok(!validAppearance({icon:'flask',color:'#123456'}))
})
test('recent ten excludes archived, blank and internal subagents with stable ties', () => {
  const byId = Object.fromEntries(Array.from({length:15},(_,i) => [`s${i}`,{id:`s${i}`,updatedAt:i*1000}]))
  byId.s14.blank=true;byId.s13.origin='subagent'
  const rows=recentSessions({byId},{archivedSessionIds:['s12']})
  assert.equal(rows.length,10);assert.equal(rows[0].id,'s11');assert.equal(rows[9].id,'s2')
})
test('dots reflect waiting before running and child activity without claiming success', () => {
  const s={id:'a',running:false}, list={byId:{child:{running:true}},projectionsBySession:{a:{values:{subagentCatalog:[{id:'child'}]}}}}
  assert.equal(sessionState(s,new Map(),list),'running')
  assert.equal(sessionState(s,new Map([['a',{pendingInteraction:{kind:'approval'}}]]),list),'waiting')
  assert.equal(sessionState(s,new Map([['child',{running:false}]]),list),'idle')
})
test('appearance persistence serializes concurrent writes and reset survives reload', async t => {
  const path=join(await tempDir(t, 'fig-project-nav-'),'appearance.json'),store=appearanceStore(path)
  await Promise.all([store.set('a',{icon:'flask',color:'green'}),store.set('b',{icon:'book',color:'blue'})])
  assert.equal(Object.keys(await appearanceStore(path).list()).length,2)
  await store.set('a',null);assert.deepEqual(await appearanceStore(path).list(),{b:{icon:'book',color:'blue'}})
  assert.equal(JSON.parse(await readFile(path,'utf8')).version,1)
  assert.throws(() => store.set('../bad',{icon:'arbitrary',color:'red'}))
})
test('a corrupted appearance file is set aside and saving works again', async t => {
  const dir=await tempDir(t, 'fig-project-nav-'), path=join(dir,'appearance.json')
  await writeFile(path,'broken')
  const store=appearanceStore(path)
  assert.deepEqual(await store.list(),{})
  await store.set('a',{icon:'flask',color:'green'})
  assert.deepEqual(await appearanceStore(path).list(),{a:{icon:'flask',color:'green'}})
  const aside=(await readdir(dir)).filter(name => name.startsWith('appearance.json.corrupt-'))
  assert.equal(aside.length,1)
  assert.equal(await readFile(join(dir,aside[0]),'utf8'),'broken')
})
