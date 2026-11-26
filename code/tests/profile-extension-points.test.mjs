import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { panelPins, profileState } from '../harness/desktop-skin/index.js'
import { cachedFileOpener, externalOpener } from '../harness/shell-bridge/index.js'
import { installTeamFileActions, teamFileActions } from '../harness/desktop-skin/client-team-files.js'
import { activityExtensions, extensionBoundary } from '../harness/attention/client-extensions.js'
import * as React from 'react'
import { workspacePickerSections } from '../harness/desktop-skin/client-workspace-picker.js'
import { applyPins, lockRequired } from '../harness/desktop-skin/client-profile.js'
import { heatShades, icons, projectColors, projectIcons, tokens, tones, version } from '../harness/ui-kit/components.js'
import { colors as navigationColors, icons as navigationIcons } from '../harness/project-navigation/model.js'
import { figPlugins } from '../harness/plugins.ts'
import { tempDir } from './helpers/temp-dir.mjs'

test('Cowork cache opens only regular documents in this Profile', async t => {
  const home = await realpath(await tempDir(t, 'fig-cloud-cache-'))
  const cache = join(home, 'fig/cowork-files')
  await mkdir(join(cache, 'version'), { recursive: true })
  await writeFile(join(cache, 'version/本机文档.txt'), 'fixture')
  await writeFile(join(home, 'outside.txt'), 'outside')
  await symlink(join(home, 'outside.txt'), join(cache, 'link.txt'))
  await symlink(home, join(cache, 'other'))
  await writeFile(join(cache, 'version/launch.webloc'), 'fixture')
  await writeFile(join(cache, 'version/link.fileloc'), 'fixture')
  await writeFile(join(cache, 'version/exec'), '#!/bin/sh')
  await chmod(join(cache, 'version/exec'), 0o755)
  const calls = []
  const open = cachedFileOpener(home, async (command, args) => { calls.push([command, args]) })
  await open('version/本机文档.txt')
  for (const path of ['version', 'link.txt', 'other/outside.txt', '../outside.txt', '/etc/hosts', 'version/launch.webloc', 'version/link.fileloc', 'version/exec'])
    await assert.rejects(open(path), path)
  assert.deepEqual(calls, [['/usr/bin/open', ['--', join(cache, 'version/本机文档.txt')]]])
})

test('Cloud Drive actions capture a verified file or folder and support explicit multi-selection only in team edition', async () => {
  const menus = new Map(), deliveries = []
  const actions = teamFileActions()
  const dispose = actions.service.registerUpload(value => deliveries.push(value))
  let exists = true
  const ctx = { contextMenus: { register(menu) { menus.set(menu.target, menu); return () => menus.delete(menu.target) } },
    sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work' } } }) } },
    remote: { workspaceFiles: { stat: async (_, path) => ({ ok: exists, value: { absolutePath: '/work/' + path } }), list: async () => ({ ok: true }) } } }
  const signal = new AbortController().signal
  const picker = { pick: async folder => { assert.equal(folder, '/work'); return ['/work/b.md', '/work/folder', '/work/b.md'] } }
  const offPersonal = installTeamFileActions(ctx, { ready: Promise.resolve({ edition: 'personal' }) }, actions, picker)
  assert.deepEqual(await menus.get('file').resolve({ sessionId: 's1', path: 'a.md' }, signal), [])
  offPersonal()
  const offTeam = installTeamFileActions(ctx, { ready: Promise.resolve({ edition: 'team' }) }, actions, picker)
  await Promise.resolve()
  const [direct, multiple] = await menus.get('file').resolve({ sessionId: 's1', path: 'a.md' }, signal)
  await direct.run()
  await multiple.run()
  const [folder] = await menus.get('directory').resolve({ sessionId: 's1', path: 'folder' }, signal)
  await folder.run()
  assert.deepEqual(deliveries, [{ paths: ['/work/a.md'], sessionId: 's1' }, { paths: ['/work/b.md', '/work/folder'], sessionId: 's1' }, { paths: ['/work/folder'], sessionId: 's1' }])
  exists = false
  await assert.rejects(direct.run(), /unavailable/)
  dispose()
  assert.deepEqual(await menus.get('file').resolve({ sessionId: 's1', path: 'a.md' }, signal), [])
  offTeam()
  assert.equal(menus.size, 0)
})

test('without a Profile from main the page sees a personal one with the default look', () => {
  const state = profileState(undefined)
  assert.equal(state.edition, 'personal')
  assert.deepEqual(state.shell, { pluginMenuActions: false, pinnedPanels: undefined, activity: { views: true, figures: true, usage: true, filter: true, sessionGroups: true } })
  const given = { id: 'p', edition: 'team', dshGeneration: 2, shell: { pluginMenuActions: false }, plugins: [] }
  assert.equal(profileState(given), given)
})

test('the user\'s sidebar pins are kept per Profile and validated', async t => {
  const home = await tempDir(t, 'fig-pins-')
  const pins = panelPins(home)
  assert.deepEqual(await pins.read(), {})
  await pins.write('team-market', false)
  await pins.write('fig-task-activity', true)
  assert.deepEqual(await pins.read(), { 'team-market': false, 'fig-task-activity': true })
  assert.deepEqual(JSON.parse(await readFile(join(home, 'fig/panel-pins.json'), 'utf8')).pinned, { 'team-market': false, 'fig-task-activity': true })
  await assert.rejects(pins.write('x', 'yes'), /Invalid pin/)
  // Quick clicks: every write reads the one before it, so none is lost.
  await Promise.all([pins.write('a', true), pins.write('b', false), pins.write('c', true)])
  assert.deepEqual(await pins.read(), { 'team-market': false, 'fig-task-activity': true, a: true, b: false, c: true })
})

/** A stand-in for DSH's sidebar face: panels, the unpinned set and setPinned, with listeners. */
function fakeSidebar(ids) {
  const listeners = { panels: new Set(), pins: new Set() }
  let unpinned = []
  const source = (key, get) => ({ getSnapshot: get, subscribe: listener => { listeners[key].add(listener); return () => listeners[key].delete(listener) } })
  const face = {
    calls: [],
    setPinned(id, pinned) { face.calls.push([id, pinned]); face.userSets(id, pinned) },
    /** What DSH's own More menu does. */
    userSets(id, pinned) { unpinned = pinned ? unpinned.filter(item => item !== id) : [...unpinned, id]; for (const listener of listeners.pins) listener() },
    hooks: { panels: source('panels', () => ids.map(id => ({ id }))), entryPins: source('pins', () => unpinned) }
  }
  return face
}
function fakeStore(defaults) {
  const listeners = new Set(), pins = {}, writes = []
  return {
    writes,
    getSnapshot: () => ({ shell: { pinnedPanels: defaults } }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    pinned: id => typeof pins[id] === 'boolean' ? pins[id] : defaults.includes(id),
    async setPinned(id, pinned) { pins[id] = pinned; writes.push([id, pinned]); for (const listener of listeners) listener() }
  }
}

test('Profile pins: defaults apply when the sidebar registers late, and a change in DSH\'s own UI is kept', () => {
  const entries = [], events = new Map()
  const ctx = { slots: { entries: () => entries }, on: (name, listener) => { events.set(name, listener); return () => events.delete(name) } }
  const store = fakeStore(['fig-task-activity'])
  const dispose = applyPins(ctx, store)
  const face = fakeSidebar(['fig-task-activity', 'team-market'])
  entries.push({ inject: () => face })
  events.get('slots/changed')('sidebar')
  assert.deepEqual(face.calls, [['team-market', false]], 'The late sidebar gets the Profile default')
  face.userSets('team-market', true)
  assert.deepEqual(store.writes, [['team-market', true]], 'The native change is written to the Profile')
  assert.deepEqual(face.calls, [['team-market', false]], 'and not undone')
  dispose()
  assert.equal(events.size, 0)
})

test('required plugin switches refuse the keyboard and are marked aria-disabled', t => {
  const saved = globalThis.document, savedElement = globalThis.Element
  t.after(() => { globalThis.document = saved; globalThis.Element = savedElement })
  const listeners = new Map()
  class FakeElement { constructor(match) { this.match = match; this.attributes = new Map() }
    closest(selector) { return this.match && selector.includes('"@team/core"') ? this : null }
    getAttribute(name) { return this.attributes.get(name) ?? null } setAttribute(name, value) { this.attributes.set(name, value) } removeAttribute(name) { this.attributes.delete(name) } }
  globalThis.Element = /** @type {any} */ (FakeElement)
  globalThis.document = /** @type {any} */ ({ createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} },
    addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type) })
  const store = { getSnapshot: () => ({ plugins: [{ name: '@team/core', required: true }] }), subscribe: () => () => {} }
  const dispose = lockRequired(store)
  const press = (target, key) => { const event = { type: 'keydown', key, target, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }; listeners.get('keydown')(event); return event.prevented }
  const locked = new FakeElement(true), other = new FakeElement(false)
  assert.equal(press(locked, ' '), true)
  assert.equal(press(locked, 'Enter'), true)
  assert.equal(press(locked, 'Tab'), false, 'Focus still moves on')
  assert.equal(press(other, ' '), false)
  assert.equal(locked.getAttribute('aria-disabled'), 'true')
  dispose()
  assert.equal(listeners.size, 0)
  assert.equal(locked.getAttribute('aria-disabled'), null)
})

test('openExternal opens only the Profile\'s Cowork origin', async () => {
  const opened = []
  const open = externalOpener('https://cowork.example', async (file, args) => { opened.push([file, ...args]) })
  await open('https://cowork.example/admin?tab=keys')
  assert.deepEqual(opened, [['/usr/bin/open', '--', 'https://cowork.example/admin?tab=keys']])
  await assert.rejects(open('https://evil.example/'), /only the Profile's Cowork site/)
  await assert.rejects(open('https://user:pw@cowork.example/'), /only the Profile's Cowork site/)
  await assert.rejects(open('not a url'), /invalid URL/)
  assert.equal(opened.length, 1)
})

test('task activity extension points: register, update, dispose, order and project selection', () => {
  const extensions = activityExtensions()
  let changes = 0
  extensions.subscribe(() => changes++)
  const late = extensions.register({ kind: 'summary', id: 'b', label: 'B', value: 1, order: 2 })
  extensions.register({ kind: 'summary', id: 'a', label: 'A', value: 5, order: 1 })
  assert.deepEqual(extensions.list('summary').map(item => item.id), ['a', 'b'])
  late.update({ value: 7, kind: 'view', id: 'x' })
  assert.deepEqual(extensions.list('summary').find(item => item.id === 'b'), { order: 2, kind: 'summary', id: 'b', label: 'B', value: 7 }, 'Kind and id never change')
  extensions.register({ kind: 'attention', id: 'items', count: 2, label: '工作项' })
  extensions.register({ kind: 'attention', id: 'none', count: 0 })
  assert.deepEqual(extensions.attention().map(item => item.id), ['items'], 'Zero counts add nothing')
  extensions.register({ kind: 'decoration', id: 'claims', tags: { s1: [{ label: '认领 #12', tone: 'accent' }] } })
  extensions.register({ kind: 'decoration', id: 'other', tags: { s1: [{ label: 'x' }], s2: 'bad' } })
  assert.deepEqual(extensions.tags('s1').map(tag => tag.label), ['认领 #12', 'x'])
  assert.deepEqual(extensions.tags('s2'), [])
  late.dispose()
  late.update({ value: 9 })
  assert.deepEqual(extensions.list('summary').map(item => item.id), ['a'], 'A disposed handle no longer updates')
  const before = extensions.getSnapshot()
  extensions.setProject('w1')
  assert.equal(extensions.getProject(), 'w1')
  assert.ok(extensions.getSnapshot() > before)
  assert.ok(changes >= 7)
  assert.throws(() => extensions.register({ kind: 'sidebar', id: 'x' }), /kind and id/)
})

test('figActivity v2: read-only sessions and usage, empty without Fig\'s stores', () => {
  const bare = activityExtensions()
  assert.equal(bare.version, 2)
  assert.deepEqual(bare.sessions.get(), [])
  assert.equal(bare.usage.get(), null)
  const rows = [{ id: 's1' }], view = { cells: [] }, seen = []
  const store = value => ({ get: () => value, subscribe: listener => { seen.push(listener); return () => {} } })
  const extensions = activityExtensions({ sessions: store(rows), usage: store(view) })
  assert.equal(extensions.sessions.get(), rows)
  assert.equal(extensions.usage.get(), view)
  extensions.sessions.subscribe(() => {}); extensions.usage.subscribe(() => {})
  assert.equal(seen.length, 2)
  assert.equal('register' in extensions.sessions, false, 'Nothing to write through')
})

test('figUi: a versioned set of tokens, icons and formatting; ui-kit is part of Fig and ships a bundle patch', () => {
  assert.equal(version, 1)
  // Project navigation's icons and colours, the same table, read-only.
  assert.deepEqual(projectIcons, navigationIcons)
  assert.deepEqual(Object.fromEntries(Object.entries(projectColors).map(([name, pair]) => [name, [...pair]])), navigationColors)
  assert.ok(Object.isFrozen(projectIcons) && Object.isFrozen(projectColors.red))
  assert.equal(heatShades.length, 5)
  // Orange text reads in both themes through the brand text token; the fill stays Fig orange.
  assert.equal(tokens.accentText, 'var(--dsw-alias-brand-text, #b64000)')
  assert.equal(tones.accent, tokens.accentText)
  for (const key of ['accentHover', 'onAccent', 'accentWash', 'accentLine']) assert.equal(typeof tokens[key], 'string')
  assert.deepEqual(heatShades.slice(1).map(shade => Number(/ (\d+)%/.exec(shade)[1])), [20, 40, 60, 80], 'Four soft accent steps')
  for (const name of ['pending', 'running', 'result', 'failure', 'activity', 'open', 'check', 'alert']) assert.equal(typeof icons[name], 'string')
  assert.equal(tokens.accent, '#ff6a1a')
  const plugin = figPlugins.find(item => item.name === 'ui-kit')
  assert.ok(plugin && !plugin.bundle && plugin.assets.includes('bundle.patch.yml'))
})

test('workspace picker sections: registered in order, updated, disposed; none means DSH keeps its picker', () => {
  const sections = workspacePickerSections()
  let changes = 0
  sections.subscribe(() => changes++)
  assert.deepEqual(sections.list(), [], 'With no section Fig leaves the slot to DSH')
  const claims = sections.register({ id: 'claims', title: '我认领的任务', order: 1, items: [{ id: 'a', label: '#1' }] })
  sections.register({ id: 'first', order: 0 })
  assert.deepEqual(sections.list().map(section => section.id), ['first', 'claims'])
  claims.update({ selectedItemId: 'a', id: 'other' })
  assert.equal(sections.list()[1].selectedItemId, 'a')
  assert.equal(sections.list()[1].id, 'claims', 'The id never changes')
  claims.dispose()
  claims.update({ items: [] })
  assert.deepEqual(sections.list().map(section => section.id), ['first'])
  assert.equal(changes, 4)
  assert.throws(() => sections.register({}), /id is required/)
})

test('an extension that throws is replaced by one line; a new component gets another try', t => {
  const saved = globalThis.document
  t.after(() => { globalThis.document = saved })
  globalThis.document = /** @type {any} */ ({ documentElement: { lang: 'en' } })
  const Boundary = extensionBoundary(React)
  const Broken = () => { throw new Error('boom') }, Fixed = () => null
  const boundary = new Boundary({ id: 'team', component: Broken, props: {} })
  assert.equal(boundary.render().type, Broken, 'Renders the extension while it works')
  boundary.state = { ...boundary.state, ...Boundary.getDerivedStateFromError() }
  const note = boundary.render()
  assert.equal(note.props['data-fig-activity-extension-error'], 'team')
  assert.equal(note.props.children, 'This extension could not be shown.')
  assert.equal(Boundary.getDerivedStateFromProps({ component: Broken }, boundary.state), null, 'Stays hidden for the same component')
  assert.deepEqual(Boundary.getDerivedStateFromProps({ component: Fixed }, boundary.state), { failed: false, component: Fixed })
})
