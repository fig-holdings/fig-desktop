import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'

// Managed (Web) handoff against the real DSH host, without a model: the parent is created like the Web UI
// creates it (Session Controller, inside a Workspace), with each permission preset and a working directory
// below the Workspace root. The children start a turn against the catalog-only placeholder, which fails
// offline; only the native session state set up by the handoff is asserted.
const explicitEvidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
const evidence = explicitEvidence ?? fileURLToPath(new URL('../../work/verification/handoff-native/', import.meta.url))
await mkdir(dirname(evidence), { recursive: true })
await mkdir(evidence, { recursive: !explicitEvidence })
const state = await isolatedProfile('handoff-native', {extraEnv: profile => ({GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: join(profile, 'grok/auth.json')})})
await mkdir(join(state.profile, 'agents'))
state.env.DSH_AGENTS_HOME = join(state.profile, 'agents')
const sub = join(state.workspace, 'sub/dir')
await mkdir(sub, { recursive: true })
const subReal = await realpath(sub)
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: state.documents } },
  { insert: [{ id: 'handoff-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url)) }] }
]))
const report = { startedAt: new Date().toISOString(), cases: [] }
let app, passed = false
try {
  app = await launchFig(state.env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  const rpc = async (endpoint, payload) => {
    const result = await page.evaluate(async ({ endpoint, payload }) => (await fetch('/handoff-probe/' + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    })).json(), { endpoint, payload })
    assert.ok(result.ok, result.error?.message)
    return result.value
  }
  const failures = []
  for (const preset of ['read-only', 'workspace-write', 'danger-full-access']) {
    const parent = await rpc('parent', { workspacePath: state.workspace, cwd: sub, preset })
    const call = await rpc('call', { id: parent.id, name: 'handoff_session', args: { title: 'Probe ' + preset, prompt: 'Reply OK.' } })
    const value = call.result?.value
    const entry = { preset, parent, value: value ?? null, error: call.result?.error ?? call.error ?? null }
    if (value?.sessionId) {
      entry.child = await rpc('inspect', { id: value.sessionId })
      const chained = await rpc('call', { id: value.sessionId, name: 'handoff_session', args: { title: 'Chain ' + preset, prompt: 'Reply OK.' } })
      entry.chained = chained.result?.value ? { sessionId: chained.result.value.sessionId } : { error: JSON.stringify(chained).slice(0, 400) }
      if (chained.result?.value?.sessionId) entry.grandchild = await rpc('inspect', { id: chained.result.value.sessionId })
    }
    report.cases.push(entry)
    const check = (ok, message) => { if (!ok) failures.push(preset + ': ' + message) }
    check(!!value?.sessionId, 'handoff failed ' + JSON.stringify(call).slice(0, 300))
    if (!entry.child) continue
    check(entry.child.preset === preset, `child preset ${entry.child.preset}, expected ${preset}`)
    check(entry.child.workspaceId === parent.workspaceId, 'child landed in another workspace')
    check(entry.child.cwd === subReal, `child cwd ${entry.child.cwd}, expected ${subReal}`)
    // DSH's own session description (source runtime-context; seen on 0.2.2-rc.5) states the policy the child runs under; only
    // a notice from anywhere else counts as injected.
    check(!entry.child.messages.some(message => /approval/i.test(message.text) && !['user', 'runtime-context'].includes(message.source)),
      'child received an injected approval-policy notice')
    check(!!entry.chained?.sessionId, 'chained handoff refused: ' + entry.chained?.error)
    check(entry.grandchild?.preset === preset, `grandchild preset ${entry.grandchild?.preset}`)
  }
  report.workspaces = (await rpc('inspect', { id: report.cases[0].parent.id })).workspaces
  if (report.workspaces.length !== 1) failures.push('workspaces registered: ' + report.workspaces.join(', '))
  report.failures = failures
  passed = failures.length === 0
  console.log(passed ? 'PASS: managed handoff keeps preset, workspace and directory; chains' : 'FAIL:\n' + failures.join('\n'))
} finally {
  report.passed = passed
  const name = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) ?? 'run'
  await writeFile(join(evidence, `handoff-native-${name}.json`), JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
  await cleanUp(state.profile, passed)
}
if (!passed) process.exitCode = 1
