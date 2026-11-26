import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedProfile, workbenchPage, cleanUp, launchBundle } from '../scripts/isolated-fig.mjs'
const bundle = process.argv.find(a => a.startsWith('--bundle='))?.slice(9), evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11)
assert.ok(bundle && evidence)
await mkdir(evidence)
const state = await isolatedProfile('delegate-package', { extraEnv: p => ({ GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json') }) })
await mkdir(state.workspace, { recursive: true })
await writeFile(join(state.workspace, 'fixture.txt'), 'SYNTHETIC-CODEX-PACKAGE-READONLY\n')
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: state.documents } }, { insert: [{ id: 'probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url)) }] }
]))
const report = {
  status: 'fail', bundle, startedAt: new Date().toISOString(), scope: 'One bounded real default Codex CLI request through signed app native delegate_agent; synthetic input, read-only, no MCP/apps/nested model calls'
}
let app
try {
  app = await launchBundle(bundle, state.env)
  const page = await workbenchPage(app, 90000)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click()
  const rpc = async (endpoint, payload) => {
    const r = await page.evaluate(async ({ endpoint, payload }) => (await fetch('/handoff-probe/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json(), { endpoint, payload })
    assert.ok(r.ok, JSON.stringify(r.error))
    return r.value
  }
  const { id } = await rpc('parent', { workspacePath: state.workspace, preset: 'read-only', title: 'Synthetic Codex delegate' })
  const result = await rpc('call', {
    id, name: 'delegate_agent', timeoutMs: 180000, args: {
      agent: 'codex', task: 'This is a single read-only compatibility fixture, not an implementation review. Read only fixture.txt in the current directory using your read-only tool. Reply exactly with its content, without commentary. Do not edit anything, invoke another agent, use MCP/apps, search the network, or read other files.'
    }
  })
  await writeFile(join(evidence, 'native-tool-result.json'), JSON.stringify(result, null, 2))
  const value = result.result?.value
  assert.equal(value?.exitCode, 0, JSON.stringify(result))
  assert.equal(value.text.trim(), 'SYNTHETIC-CODEX-PACKAGE-READONLY')
  assert.equal(await readFile(join(state.workspace, 'fixture.txt'), 'utf8'), 'SYNTHETIC-CODEX-PACKAGE-READONLY\n')
  report.agent = value.agent
  report.exitCode = value.exitCode
  report.elapsedMs = value.elapsedMs
  report.status = 'pass'
} catch (e) {
  report.error = String(e.stack ?? e)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
  await cleanUp(state.profile, report.status === 'pass')
}
