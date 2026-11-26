import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import { homedir } from 'node:os'
import { parse } from 'yaml'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedProfile, launchFig, workbenchPage, cleanUp, until, emergencyReport } from '../scripts/isolated-fig.mjs'
if (!process.argv.includes('--real')) {console.error('Require --real: one bounded synthetic DeepSeek task'); process.exit(2)}
const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11); assert.ok(evidence); await mkdir(evidence)
// Native workspace-changes intentionally omits OS tmp roots. This repo is synthetic project work.
const repo = await realpath(await mkdir(join(evidence, 'repo')).then(() => join(evidence, 'repo')))
const envGit = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'}
const git = (...args) => execFileSync('git', args, {cwd: repo, env: envGit, encoding: 'utf8'})
git('init', '-q'); git('config', 'user.name', 'Synthetic Fixture'); git('config', 'user.email', 'fixture@example.invalid')
await writeFile(join(repo, 'tracked.txt'), 'BASE\nSHARED-ORIGINAL\nTAIL\n')
await writeFile(join(repo, 'staged.txt'), 'STAGED-BASE\n')
await writeFile(join(repo, 'deleted.txt'), 'DELETE-BASE\n')
await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 2]))
await writeFile(join(repo, 'large.txt'), 'A'.repeat(2 * 1024 * 1024 + 1))
git('add', '.'); git('commit', '-qm', 'synthetic baseline')
await writeFile(join(repo, 'tracked.txt'), 'USER-PREEXISTING\nSHARED-ORIGINAL\nTAIL\n')
await writeFile(join(repo, 'staged.txt'), 'USER-STAGED\n'); git('add', 'staged.txt')
await writeFile(join(repo, 'untracked.txt'), 'USER-UNTRACKED\n')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const indexBefore = hash(await readFile(join(repo, '.git/index')))
const before = Object.fromEntries(await Promise.all(['tracked.txt', 'staged.txt', 'untracked.txt'].map(async file => [file, hash(await readFile(join(repo, file)))])))
const state = await isolatedProfile('attribution-native', {extraEnv: p => ({GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'})})
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([{id: 'workspace-controller', config: {documentsDirectory: state.documents}}, {insert: [
  {id: 'handoff-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url))},
  {id: 'change-probe', name: fileURLToPath(new URL('./fixtures/change-probe.mjs', import.meta.url))}
]}]))
const expected = ['dirty-baseline', 'mixed-authorship', 'restore-exclusions', 'ephemeral-lifecycle']
const report = {status: 'fail', suite: 'subset', expectedScenarioIds: expected, results: [], provider: 'deepseek-account', model: 'deepseek-flash', startedAt: new Date().toISOString(), before, indexBefore, scope: 'One bounded synthetic DeepSeek turn; isolated skill/rule roots; minimal account copy, no refresh/fallback; actual public WorkspaceChanges and real Git'}
let app, page
const credential = join(state.dshHome, '.credentials.yaml')
emergencyReport(join(evidence, 'result.json'), report, {app: () => app, prepare: error => {
  // The credential copy goes before anything else is written.
  rmSync(credential, {force: true}); report.error = String(error?.message ?? error)
  for (const id of expected) if (!report.results.some(r => r.id === id)) report.results.push({id, status: 'fail', reason: 'Uncaught process failure'})
}})
try {
  const stored = parse(await readFile(join(homedir(), '.fig/.credentials.yaml'), 'utf8'))
  const records = Object.fromEntries(Object.entries(stored.records ?? {}).filter(([id]) => /deepseek/i.test(id)))
  if (!Object.values(records).some(record => typeof record.payload?.token === 'string')) throw Object.assign(new Error('DeepSeek account grant unavailable'), {status: 'blocked'})
  await mkdir(join(state.profile, 'agents'), {recursive: true})
  delete state.env.DEEPSEEK_API_KEY; delete state.env.DEEPSEEK_BASE_URL
  await writeFile(credential, JSON.stringify({version: 1, records}), {mode: 0o600})
  let launched = false
  const launch = async () => {app = await launchFig(state.env); page = await workbenchPage(app); if (!launched) await page.getByRole('button', {name: /^(继续|Continue)$/}).click(); launched = true; await page.locator('[data-slot="sidebar"]').waitFor()}
  await launch()
  const rpc = (prefix, endpoint, payload) => page.evaluate(async ({prefix, endpoint, payload}) => (await fetch(prefix + '/' + endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)})).json(), {prefix, endpoint, payload}).then(r => {assert.ok(r.ok, JSON.stringify(r.error)); return r.value})
  const probe = (e, p) => rpc('/handoff-probe', e, p), changes = (e, p) => rpc('/change-probe', e, p)
  const wait = fn => until(fn, {timeout: 20000, message: 'native changes fixture timeout'})
  const {id} = await probe('parent', {workspacePath: repo, cwd: repo, preset: 'workspace-write', title: 'Synthetic attribution', route: {provider: 'deepseek-account', model: 'deepseek-flash'}})
  const skills = await probe('skillInfo', {id}); assert.ok(skills.complete && skills.skills.length === 0, 'Model skill isolation must be confirmed')
  await probe('followup', {id, text: 'Authorized synthetic regression in this repository only. Read tracked.txt, then use write to replace only SHARED-ORIGINAL with TOOL-CHANGE while preserving all other existing lines. Create new.txt containing TOOL-NEW. After those writes, use bash to run exactly `touch external-ready; sleep 4`. The fixture performs concurrent edits during that wait. After bash finishes, do not change any files again; reply ATTRIBUTION-DONE. No restore, no extra tasks.'})
  const row = page.getByText('Synthetic attribution', {exact: true}).first()
  if (!await row.isVisible().catch(() => false)) await page.getByText('repo', {exact: true}).first().click()
  await row.click()
  await until(async () => {
    const events = await probe('events', {id})
    if (events.some(e => e.type === 'turn/end' && e.data.reason?.kind === 'error' && ['AUTH','GROK_LOGIN_REQUIRED','CHATGPT_LOGIN_REQUIRED'].includes(e.data.reason.error?.code))) throw Object.assign(new Error('Model authorization unavailable'), {status: 'blocked'})
    return readFile(join(repo, 'external-ready')).then(() => true, () => false)
  }, {timeout: 150000, interval: 200, message: 'Bounded model task did not reach the controlled external-write boundary'})
  assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'USER-PREEXISTING\nTOOL-CHANGE\nTAIL\n')
  const turn = (await probe('events', {id})).filter(e => e.type === 'turn/start').at(-1).data.turn
  await writeFile(join(repo, 'tracked.txt'), 'USER-PREEXISTING\nTOOL-CHANGE\nEXTERNAL-DURING-TURN\n')
  await writeFile(join(repo, 'external.txt'), 'EXTERNAL-ONLY\n')
  await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 4, 5]))
  await writeFile(join(repo, 'large.txt'), 'B'.repeat(2 * 1024 * 1024 + 1))
  await rm(join(repo, 'deleted.txt'))
  await wait(async () => !(await probe('state', {id})).running)
  const events = await probe('events', {id})
  assert.equal(events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed')
  assert.match((await probe('inspect', {id})).messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n'), /ATTRIBUTION-DONE/)
  await writeFile(join(evidence, 'tool-and-turn-events.json'), JSON.stringify(events.filter(e => ['tool/call','turn/start','turn/end'].includes(e.type)), null, 2))
  await wait(async () => (await changes('events', {id})).some(e => e.turn === turn))
  const seq = (await changes('events', {id})).filter(e => e.turn === turn).at(-1).seq
  const result = await changes('read', {id, seq})
  await writeFile(join(evidence, 'native-summary-and-diffs.json'), JSON.stringify(result, null, 2))
  assert.deepEqual(result.api.sort(), ['diff', 'summary'])
  const find = file => result.diffs[result.summary.files.findIndex(item => item.path === file)]
  const tracked = find('tracked.txt')
  assert.equal(tracked.hunks.length, 1); assert.equal(tracked.hunks[0].oldStart, 1); assert.equal(tracked.hunks[0].oldLines, 3)
  const beforeText = tracked.hunks[0].lines.filter(line => /^[ -]/.test(line)).map(line => line.slice(1)).join('\n') + '\n'
  const afterText = tracked.hunks[0].lines.filter(line => /^[ +]/.test(line)).map(line => line.slice(1)).join('\n') + '\n'
  assert.equal(hash(beforeText), before['tracked.txt'])
  report.results.push({id: 'dirty-baseline', status: 'pass'})
  const lines = find('tracked.txt').hunks.flatMap(h => h.lines)
  assert.ok(lines.includes('+TOOL-CHANGE') && lines.includes('+EXTERNAL-DURING-TURN'))
  assert.ok(!lines.includes('+USER-PREEXISTING'))
  assert.ok(result.summary.files.some(f => f.path === 'external.txt'))
  assert.ok(!result.summary.files.some(f => ['staged.txt', 'untracked.txt'].includes(f.path)))
  report.results.push({id: 'mixed-authorship', status: 'pass'})
  assert.equal(find('new.txt').before, false); assert.equal(find('deleted.txt').after, false)
  assert.equal(find('binary.bin').kind, 'binary'); assert.equal(find('large.txt').kind, 'oversized')
  assert.equal(hash(await readFile(join(repo, '.git/index'))), indexBefore)
  await writeFile(join(repo, 'tracked.txt'), 'POST-TURN-EXTERNAL\n')
  assert.notEqual(hash(await readFile(join(repo, 'tracked.txt'))), hash(afterText))
  report.attribution = result.summary.files.map(file => ({path: file.path, modelToolTouched: ['tracked.txt', 'new.txt'].includes(file.path), authorship: 'unknown', automaticRestore: false}))
  report.automaticRestoreCandidates = []; report.reasons = ['net diff includes external edits', 'binary/oversized lack complete text', 'new/deleted require destructive actions', 'current content changed after turn']
  report.results.push({id: 'restore-exclusions', status: 'pass'})
  report.snapshotIdentityBoundary = 'Native tree IDs address a private temporary object store; use public diff, not git show against the user repository'
  report.sessionId = id; report.summarySeq = seq
  report.initialUserChangesPreserved = true; report.indexPreserved = true; report.nativeAPI = result.api
  await rm(credential, {force: true})
  await app.close(); app = undefined
  await launch()
  assert.equal((await changes('read', {id, seq})).summary, null)
  report.hostRestartLosesEphemeralSnapshots = true
  report.results.push({id: 'ephemeral-lifecycle', status: 'pass'})
  report.status = 'pass'
} catch (error) {report.error = String(error.stack ?? error); report.status = error?.status === 'blocked' ? 'blocked' : 'fail'; for (const id of expected) if (!report.results.some(r => r.id === id)) report.results.push({id, status: report.status, reason: error.message}); if (page) { const size = await page.evaluate(() => ({width: innerWidth, height: innerHeight})).catch(() => null); if (size) await page.screenshot({path: join(evidence, 'failure.png'), clip: {x:0,y:0,width:size.width,height:Math.max(1,size.height-100)}}).catch(() => {}) }; process.exitCode = report.status === 'blocked' ? 3 : 1}
finally {await rm(credential, {force: true}); report.finishedAt = new Date().toISOString(); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2)); await app?.close().catch(() => {}); await cleanUp(state.profile, report.status === 'pass')}
