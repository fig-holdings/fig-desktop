import assert from 'node:assert/strict'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { managedHandoff, parentSettings } from '../harness/handoff/index.js'
import { tempDir } from './helpers/temp-dir.mjs'

test('handoff inherits the selected route and refuses ambiguous permissions', () => {
  const selected = { provider: 'fig-chatgpt', model: 'test-model', reasoningEffort: 'high' }
  const agent = { session: {}, options: { provider: 'wrong', model: 'wrong' }, model: { current: () => selected } }
  const context = preset => ({ get: () => ({ current: () => preset }) })
  assert.deepEqual(parentSettings(context('read-only'), agent), { preset: 'read-only', model: selected })
  // The Web sibling shares the host, so a live Auto selection is applied natively; custom stays unnamed.
  assert.equal(parentSettings(context('auto'), agent).preset, 'auto')
  for (const preset of ['custom', undefined]) assert.throws(() => parentSettings(context(preset), agent), /permission mode/)
})

function managedServices({ workspaces, steps, created }) {
  const child = { session: {}, model: { select: model => steps.push(['model', model]) }, followup: message => steps.push(['prompt', message]) }
  return {
    workspaceRegistry: { list: () => workspaces, create: async path => { created.push(path); return { id: 'new', path, sessionIds: [] } },
      archiveSession: async (id, options) => steps.push(['archive', id, options]) },
    agentPresets: { composedPreset: () => 'cordis' },
    sessionController: { create: async request => { steps.push(['create', request]); return { sessionId: 'child' } } },
    agents: { get: () => child },
    permissionPresets: { set: (_session, preset) => steps.push(['permission', preset]) },
    approval: { setPolicy: () => steps.push(['approval']) },
    workingDirectory: { set: async (_agent, path) => steps.push(['cwd', path]) },
    sessionTitle: { rename: (_session, title) => steps.push(['title', title]) }
  }
}

test('Web handoff creates a native sibling in the caller workspace with its preset, route and title', async t => {
  const root = await tempDir(t, 'fig-managed-')
  const workspace = await realpath(root)
  await mkdir(join(workspace, 'sub/dir'), { recursive: true })
  const steps = [], created = []
  const services = managedServices({ workspaces: [{ id: 'other', path: join(workspace, 'sub'), sessionIds: [] },
    { id: 'ws', path: workspace, sessionIds: ['parent'] }], steps, created })
  const settings = { preset: 'workspace-write', model: { provider: 'fig-chatgpt', model: 'test' } }
  const parent = { ctx: {}, session: { id: 'parent' } }
  const result = await managedHandoff({ get: name => services[name] }, parent, { prompt: 'Review only', title: 'Review' },
    join(root, 'sub/dir'), settings, AbortSignal.timeout(1000), message => message)
  assert.equal(result.lifecycle, 'fig')
  assert.equal(result.workspaceId, 'ws', 'the caller workspace wins over a deeper registered one')
  assert.deepEqual(created, [], 'no extra workspace is registered for a subdirectory')
  assert.deepEqual(steps.map(step => step[0]), ['create', 'model', 'permission', 'cwd', 'title', 'prompt'])
  assert.deepEqual(steps[0][1], { workspaceId: 'ws', agentPreset: 'cordis' })
  assert.equal(steps[2][1], 'workspace-write', 'the preset keeps its native approval policy')
  assert.equal(steps[3][1], join(workspace, 'sub/dir'))

  // A subagent caller is not a Workspace member: the deepest registered Workspace containing the directory owns it.
  steps.length = 0
  const nested = await managedHandoff({ get: name => services[name] }, { ctx: {}, session: { id: 'subagent' } }, { prompt: 'Go' },
    join(root, 'sub/dir'), { preset: 'read-only' }, undefined, message => message)
  assert.equal(nested.workspaceId, 'other')
  // At the Workspace root nothing changes the directory, and cancellation before creation starts nothing.
  steps.length = 0
  await managedHandoff({ get: name => services[name] }, parent, { prompt: 'Go' }, root, { preset: 'read-only' }, undefined, message => message)
  assert.ok(!steps.some(step => step[0] === 'cwd'))
  steps.length = 0
  await assert.rejects(managedHandoff({ get: name => services[name] }, parent, { prompt: 'Go' }, root, { preset: 'read-only' },
    AbortSignal.abort(new Error('cancelled')), message => message), /cancelled/)
  assert.deepEqual(steps, [])
})

test('a Web handoff that fails after creating the sibling archives it instead of leaving an orphan', async t => {
  const root = await realpath(await tempDir(t, 'fig-managed-fail-'))
  const steps = [], created = []
  const services = managedServices({ workspaces: [{ id: 'ws', path: root, sessionIds: ['parent'] }], steps, created })
  services.permissionPresets = { set: () => { throw new Error('preset refused') } }
  await assert.rejects(managedHandoff({ get: name => services[name] }, { ctx: {}, session: { id: 'parent' } }, { prompt: 'Go' },
    root, { preset: 'read-only' }, undefined, message => message), /preset refused/)
  assert.deepEqual(steps.at(-1), ['archive', 'child', { stopActivity: true }])
  // An archive that fails too still reports the handoff's own failure.
  services.workspaceRegistry.archiveSession = async () => { throw new Error('archive failed') }
  await assert.rejects(managedHandoff({ get: name => services[name] }, { ctx: {}, session: { id: 'parent' } }, { prompt: 'Go' },
    root, { preset: 'read-only' }, undefined, message => message), /preset refused/)
})
