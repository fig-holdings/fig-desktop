import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { acquireRefreshHandoff, nativeCredentialStore, recoverRefreshHandoff } from '../scripts/refresh-handoff.mjs'
const modules = process.argv.find(a => a.startsWith('--dsh-modules='))?.slice(14), evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11)
assert.ok(modules && evidence)
await mkdir(evidence)
const root = await mkdtemp(join(tmpdir(), 'fig-refresh-transfer-')), source = join(root, 'source.yaml'), target = join(root, 'isolated/credentials.yaml'), key = 'fig-chatgpt/subscription'
const grant = access => ({
  kind: 'grant', payload: { type: 'oauth', access, refresh: 'refresh-' + access, expires: 1, clientId: 'synthetic', scopes: [] }
})
const report = { status: 'fail', scope: 'Native credential service with synthetic grants; no network', checks: [] }
let handoff, store
try {
  await writeFile(source, '# KEEP-COMMENT\n' + JSON.stringify({
    version: 1, records: { [key]: grant('original'), 'other/account': { kind: 'grant', payload: { keep: 'UNCHANGED' } } }
  }), { mode: 0o600 })
  handoff = await acquireRefreshHandoff({ source, target, modules, checkOwner: () => {} })
  assert.equal(parse(await readFile(source, 'utf8')).records[key].payload.type, 'fig-verification-handoff')
  await assert.rejects(acquireRefreshHandoff({ source, target: target + '-second', modules, checkOwner: () => {} }), /Unresolved/)
  report.checks.push('exclusive marker and second owner rejected')
  let doc = parse(await readFile(target, 'utf8'))
  doc.records[key] = grant('rotated')
  await writeFile(target, JSON.stringify(doc), { mode: 0o600 })
  await handoff.release()
  handoff = undefined
  let text = await readFile(source, 'utf8')
  assert.match(text, /KEEP-COMMENT/)
  assert.equal(parse(text).records[key].payload.refresh, 'refresh-rotated')
  assert.equal(parse(text).records['other/account'].payload.keep, 'UNCHANGED')
  report.checks.push('latest rotated grant returned; comment and other record preserved')
  handoff = await acquireRefreshHandoff({ source, target, modules, checkOwner: () => {} })
  store = await nativeCredentialStore(source, modules)
  await store.credentials.modifyRecord(key, async () => grant('new-login'))
  await store.close()
  store = undefined
  const result = await handoff.release()
  handoff = undefined
  assert.equal(result.newLoginWon, true)
  assert.equal(parse(await readFile(source, 'utf8')).records[key].payload.access, 'new-login')
  report.checks.push('new canonical login wins')
  let live = false
  handoff = await acquireRefreshHandoff({ source, target, modules, checkOwner: () => {
    if (live) throw Error('live owner')
  } })
  live = true
  await assert.rejects(handoff.release(), /live owner/)
  assert.equal(parse(await readFile(source, 'utf8')).records[key].payload.type, 'fig-verification-handoff')
  live = false
  await handoff.release()
  handoff = undefined
  report.checks.push('return refuses a still-live Host and retains recoverable ownership')
  let calls = 0
  await assert.rejects(acquireRefreshHandoff({
    source, target, modules, checkOwner: () => {
      if (++calls === 2) throw Object.assign(Error('new owner appeared'), { status: 'blocked' })
    }
  }), /handoff failed/)
  assert.equal(parse(await readFile(source, 'utf8')).records[key].payload.access, 'new-login')
  report.checks.push('post-claim race rolls back before refresh')
  handoff = await acquireRefreshHandoff({ source, target, modules, checkOwner: () => {} })
  doc = parse(await readFile(target, 'utf8'))
  doc.records[key] = grant('crash-latest')
  await writeFile(target, JSON.stringify(doc), { mode: 0o600 })
  const journal = source + '.fig-verification-handoff.json', meta = JSON.parse(await readFile(journal, 'utf8'))
  meta.pid = 2147483647
  await writeFile(journal, JSON.stringify(meta), { mode: 0o600 })
  await recoverRefreshHandoff({ source, modules, checkOwner: () => {} })
  assert.equal(parse(await readFile(source, 'utf8')).records[key].payload.access, 'crash-latest')
  report.checks.push('dead-owner recovery uses latest copy')
  report.status = 'pass'
} catch (e) {
  report.error = String(e.stack ?? e)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  await store?.close()
  if (report.status === 'pass') await rm(root, { recursive: true, force: true })
}
