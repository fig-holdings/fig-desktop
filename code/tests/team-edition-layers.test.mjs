import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTeamGroups } from '../harness/desktop-skin/client-team-models.js'
import { teamUnits, unitState } from '../harness/desktop-skin/client-team-plugins.js'
import { parseDescriptor } from '../app/main/profile.ts'

// The team model picker, and a team plugin group's two layers with the Team plugins tab.

test('team model groups: organization first as 「<vendor> 组织」, the default organization model badged, others untouched', () => {
  const groups = [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'flash', name: 'Flash' }] },
    { id: 'fig-chatgpt', name: 'ChatGPT 订阅', models: [{ id: 'gpt', name: 'GPT' }] },
    { id: 'org-claude', name: 'Anthropic', models: [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet', badge: { text: 'New', tone: 'info' } }] }
  ]
  const projected = projectTeamGroups(groups, { organizationProviders: ['org-claude'], platformProviders: [], defaultModel: { provider: 'org-claude', model: 'opus' } }, name => `${name} 组织`, { default: '默认', quota: '计入额度' })
  assert.deepEqual(projected.map(group => [group.id, group.name]), [['org-claude', 'Anthropic 组织'], ['deepseek-official', 'DeepSeek'], ['fig-chatgpt', 'ChatGPT 订阅']])
  assert.equal(projected[0].models[0].badge.text, '默认')
  assert.deepEqual(projected[0].models[1].badge, { text: 'New', tone: 'info' }, 'A provider badge is kept')
  assert.equal(projected[1], groups[0], 'A personal group is passed through as it is')
  assert.deepEqual(projectTeamGroups(groups, undefined).map(group => group.id), groups.map(group => group.id))
})

test('Team plugins tab: base layer and business plugins, each on, off with its reason, or not enabled', () => {
  const ready = (name, plugin) => ({ name, status: 'ready', group: 'team', source: 'package', ...plugin ? { plugin, pluginTitle: '任务协作' } : {} })
  const plugins = [ready('@c/core'), ready('@c/team'), ready('@c/market', 'tasks'), { ...ready('@c/exec', 'tasks'), status: 'failed', reason: 'bad' }, { name: 'other', status: 'ready', source: 'directory' }]
  const units = teamUnits(plugins)
  assert.equal(units.group, 'team')
  assert.deepEqual(units.base.map(item => item.name), ['@c/core', '@c/team'])
  assert.deepEqual(units.business.map(unit => [unit.id, unit.title, unit.packages.length]), [['tasks', '任务协作', 2]])
  assert.deepEqual(unitState(units.base), { on: true })
  assert.deepEqual(unitState(units.business[0].packages), { on: false, reason: 'bad' })
  assert.deepEqual(unitState([{ ...ready('@c/market', 'tasks'), status: 'disabled', reason: 'org' }]), { on: false, disabled: true, off: 'tenant', reason: 'org' })
  assert.equal(unitState([{ ...ready('@c/market', 'tasks'), status: 'disabled', unavailable: { active: false, off: 'platform' } }]).off, 'platform')
})

test('a team descriptor keeps the organization\'s business plugin switches and each entry\'s business plugin', () => {
  const descriptor = parseDescriptor({ edition: 'team', teamPlugins: { tasks: false, audit: true, 'bad name': false, x: 'no' },
    plugins: [{ source: { kind: 'package', path: '/a.tgz' }, required: true, group: 'team', plugin: 'tasks' }, { source: '/b', plugin: 'tasks' }] }, 'id')
  assert.deepEqual(descriptor.teamPlugins, { tasks: { active: false, off: 'tenant' } })
  assert.equal(descriptor.plugins[0].plugin, 'tasks')
  assert.equal(descriptor.plugins[1].plugin, undefined, 'A business plugin needs a group')
  assert.equal(parseDescriptor({ teamPlugins: { tasks: false } }, 'id').teamPlugins, undefined, 'Personal Profiles have none')
})

test('a reason in both languages shows the page language\'s half', async () => {
  const { localReason } = await import('../harness/desktop-skin/client-team-plugins.js')
  assert.equal(localReason('业务插件 tasks 已停用 / Business plugin tasks is off', true), '业务插件 tasks 已停用')
  assert.equal(localReason('业务插件 tasks 已停用 / Business plugin tasks is off', false), 'Business plugin tasks is off')
  assert.equal(localReason('failed to load', true), 'failed to load')
})

test('business plugin availability: the earlier boolean, the three causes, and anything else dropped', async () => {
  const { teamPluginPolicy } = await import('../harness/shared/profile-contract.ts')
  assert.deepEqual(teamPluginPolicy({ a: false, b: true, c: { active: true }, d: { active: false, off: 'unsubscribed' },
    e: { active: false, off: 'platform', platformOff: { kind: 'fault', reason: ' 上游故障 ', at: '2026-11-24' } }, f: { active: false, platformOff: { kind: 'security', reason: 'x' } },
    g: { active: false, off: 'nonsense' }, 'Bad Name': false }), {
    a: { active: false, off: 'tenant' }, d: { active: false, off: 'unsubscribed' },
    e: { active: false, off: 'platform', platformOff: { kind: 'fault', reason: '上游故障', at: '2026-11-24' } },
    f: { active: false, off: 'platform', platformOff: { kind: 'security', reason: 'x' } }, g: { active: false, off: 'tenant' } })
  const once = teamPluginPolicy({ e: { active: false, off: 'platform', platformOff: { kind: 'fault', reason: 'r' } } })
  assert.deepEqual(teamPluginPolicy(once), once, 'The descriptor keeps the same shape')
})

test('a platform model with a namesake among the tenant\'s own APIs is badged 计入额度; organizationProviders may carry source', async () => {
  const { teamModels } = await import('../harness/shared/team-models.ts')
  const settings = teamModels({ organizationProviders: [{ id: 'cowork-platform', source: 'platform' }, { id: 'tenant-key', source: 'tenant' }, 'legacy', { id: 'fig-chatgpt', source: 'tenant' }],
    defaultModel: { provider: 'cowork-platform', model: 'opus' } })
  assert.deepEqual([settings.organizationProviders, settings.platformProviders], [['cowork-platform', 'tenant-key', 'legacy'], ['cowork-platform']])
  assert.deepEqual(teamModels(settings), settings, 'The descriptor keeps the same shape')
  const projected = projectTeamGroups([
    { id: 'cowork-platform', name: 'Anthropic', models: [{ id: 'opus', name: 'Opus' }, { id: 'haiku', name: 'Haiku' }] },
    { id: 'tenant-key', name: 'Anthropic', models: [{ id: 'opus', name: 'Opus' }] }], settings, name => `${name} 组织`, { default: '默认', quota: '计入额度' })
  assert.deepEqual(projected[0].models.map(model => model.badge?.text ?? null), ['默认 · 计入额度', null])
  assert.deepEqual(projected[1].models.map(model => model.badge?.text ?? null), [null], 'The tenant\'s own API is not noted')
})
