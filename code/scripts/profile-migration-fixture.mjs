import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

export const fixtureSource = {
  fig: '0.1.69 (3a94e43, before T3 C)',
  dsh: '0.2.2-rc.1 session JSONL v4 and workspace v2',
  settings: 'DSH legacy settings.yaml importer, ui-theme and ui-onboarding',
  reading: 'Fig schema 1 before category and snoozedUntil'
}

export const legacySettings = 'ui-theme:\n  preference: dark\n  fontSize: 18\nui-onboarding:\n  welcomeNoticeVersion: 2026-09-28.1\n'
export const readingPath = 'fig/attention/reading-state.json'
export const preferencesPath = 'fig/attention/preferences.json'
export const workspacePath = 'storages/workspace.json'
export const webPatch = 'profiles/web/cordis.patch.yml'
export const legacyAlerts = {schema: 1, notifications: false, dock: true}

/** Make the old-format artifact once and only boot a copy of it. All content is synthetic. */
export async function prepareLegacyProfile(profile, fixture) {
  const documents = join(profile, 'workspace')
  const cwd = join(documents, 'synthetic-f1')
  if (!/^\/[A-Za-z0-9._/-]+$/.test(cwd)) throw new Error('Fixture session path must use simple path components')
  const bucket = '--' + cwd.split('/').filter(Boolean).join('-').slice(0,251) + '--'
  const workspaceId = '10000000-0000-4000-8000-000000000001'
  const cases = [
    {key:'UNREAD', title:'F1 Synthetic Unread', read:false, known:undefined},
    {key:'READ', title:'F1 Synthetic Read', read:true, known:undefined},
    {key:'KNOWN', title:'F1 Synthetic Known Failure', read:true, known:true},
    {key:'ACTIVE', title:'F1 Synthetic Active Failure', read:true, known:false}
  ]
  const startedAt = Date.parse('2026-11-15T12:00:00.000Z')
  await mkdir(cwd, {recursive: true})
  await mkdir(fixture)
  const store = async (name, data) => {
    const file = join(fixture, name)
    await mkdir(dirname(file), {recursive:true})
    await writeFile(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + '\n')
  }
  const sessions = [], records = []
  for (const [index, spec] of cases.entries()) {
    const id = 'session-10000000-0000-4000-8000-' + String(index + 1).padStart(12, '0')
    const reply = 'F1-SYNTHETIC-REPLY-' + spec.key
    const path = join('sessions', bucket, id, 'session.v4.jsonl.zstd')
    const header = {type:'session', version:4, id, createdAt:startedAt, cwd, isSeeded:false, delegationDepth:0, agentPreset:'standard'}
    const events = []
    const add = (type, data, surfaceOp) => {
      const seq = events.length
      const event = {type, seq, time:startedAt+seq, data, ...(surfaceOp ? {surfaceOp} : {})}
      events.push(event)
      return event
    }
    const model = {provider:'synthetic-f1',model:'fixture'}
    const user = () => ({role:'user', id:randomUUID(), source:{kind:'user'}, content:[{type:'text', text:'Synthetic request for migration verification'}]})
    const start = turn => {
      const input = user()
      add('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[input]})
      add('turn/start',{turn})
      add('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]})
      add('step/start',{turn,step:1})
      if (turn===1) add('system/message',{turn,step:1,message:{role:'system',id:randomUUID(),
        source:{kind:'system-prompt'},content:[{type:'text',text:'Synthetic system prompt'}]}},'append')
      add('user/message',input,'append')
      if (turn===1) {
        add('request/header',{header:{config:model},reason:'initial'})
        add('request/context',model)
      }
    }
    const chunk = data => ({type:'chunk',time:startedAt+events.length,chunk:data})
    add('session/title',{title:spec.title,messageSeqs:[],source:{kind:'user'}})
    start(1)
    const block = {type:'text',text:reply}
    add('assistant/message',{turn:1,step:1,message:{role:'assistant',id:randomUUID(),
      source:{kind:'model',...model},content:[block]},stream:[
      chunk({type:'block-start',index:0,blockType:'text'}),
      chunk({type:'text-delta',index:0,text:reply}),
      chunk({type:'block-end',index:0,block}),chunk({type:'finish',reason:{kind:'stop'}})
    ]},'append')
    add('step/end',{turn:1,step:1})
    const result = add('turn/end',{turn:1,reason:{kind:'completed'}})
    let failure
    if (spec.known !== undefined) {
      start(2)
      const error = {code:'SYNTHETIC_FAILURE',message:'Synthetic failure for migration verification'}
      add('assistant/attempt',{turn:2,step:1,stream:[chunk({type:'finish',reason:{kind:'error',failure:error}})]})
      add('step/end',{turn:2,step:1})
      failure = add('turn/end',{turn:2,reason:{kind:'error',error}})
    }
    const identity = event => ({identity:id+':turn-end:'+event.seq,seq:event.seq,turn:event.data.turn,at:event.time})
    sessions.push({...spec,id,reply,path})
    records.push({sessionId:id,observedThrough:(failure??result).seq,readThrough:spec.read?result.seq:0,
      results:spec.read?[]:[{...identity(result),step:1}],failures:failure?[{...identity(failure),known:spec.known,ended:false}]:[],
      lastSignificantAt:(failure??result).time})
    // DSH reads the header independently and requires its own complete frame.
    const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header)+'\n'))
    const eventFrame = zstdCompressSync(Buffer.from(events.map(row=>JSON.stringify(row)).join('\n')+'\n'))
    await store(path,Buffer.concat([headerFrame,eventFrame]))
  }
  await store(readingPath,{schema:1,records})
  await store(preferencesPath,legacyAlerts)
  await store('settings.yaml',legacySettings)
  await store(webPatch,[{id:'workspace-controller',config:{documentsDirectory:documents}},
    {id:'locale',config:{preference:'zh'}}])
  const stamp = new Date(startedAt).toISOString()
  await store(workspacePath,{unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[workspaceId],
    defaultWorkspaceId:workspaceId,archivedSessionIds:[],pinnedSessionIds:[sessions[1].id]},
  tables:{workspaces:{[workspaceId]:{path:cwd,title:'synthetic-f1',createdAt:stamp,updatedAt:stamp,
    sessionIds:sessions.map(session=>session.id)}}}})
  const source = join(profile,'dsh')
  await cp(fixture,source,{recursive:true,errorOnExist:true,force:false})
  return {source,cwd,sessions,records,workspaceId}
}

export async function fixtureHashes(root, subdir = '') {
  const result = {}
  for (const entry of (await readdir(join(root,subdir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const relative = join(subdir,entry.name)
    if (entry.isDirectory()) Object.assign(result,await fixtureHashes(root,relative))
    else if (entry.isFile()) result[relative] = createHash('sha256').update(await readFile(join(root,relative))).digest('hex')
    else throw new Error('Unexpected fixture entry ' + relative)
  }
  return result
}
