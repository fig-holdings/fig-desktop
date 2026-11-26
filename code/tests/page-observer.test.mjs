import assert from 'node:assert/strict'
import test from 'node:test'
import { createPageObserver } from '../harness/shared/page-observer.js'

// No DOM here: a tiny element tree (attribute selectors only) and a stand-in MutationObserver and animation frame.
class FakeElement {
  constructor(attributes = {}, parent = null) { this.attributes = attributes; this.parentElement = parent; this.children = []; parent?.children.push(this) }
  matches(selector) {
    return selector.split(',').some(part => {
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part.trim()) ?? []
      return name !== undefined && name in this.attributes && (value === undefined || this.attributes[name] === value)
    })
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
  querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found } return null }
}
class FakeText { constructor(parent) { this.parentElement = parent } }

function harness() {
  const observed = [], frames = []
  class FakeObserver {
    constructor(callback) { this.callback = callback; observed.push(this) }
    observe(root, options) { this.options = options } disconnect() { this.options = undefined } takeRecords() { return [] }
  }
  const page = createPageObserver({ root: () => body, MutationObserver: /** @type {any} */ (FakeObserver),
    requestAnimationFrame: run => frames.push(run), cancelAnimationFrame: id => { frames[id - 1] = () => {} } })
  const fire = records => observed[0].callback(records)
  const flush = () => { const queued = frames.splice(0); for (const run of queued) run() }
  return { page, observed, fire, flush, frames }
}
const body = new FakeElement({})
const sidebar = new FakeElement({ 'data-slot': 'sidebar' }, body)
const content = new FakeElement({ 'data-conversation-content': '', 'data-conversation-session': 's1' }, body)
const running = new FakeElement({ 'data-chat-running': '' }, content)
const label = new FakeText(running)
const reply = new FakeElement({}, content)
const menu = new FakeElement({ role: 'menu' })
const menuHost = new FakeElement({}); menuHost.children.push(menu)
const childList = (target, added = [], removed = []) => ({ type: 'childList', target, addedNodes: added, removedNodes: removed })
const characterData = target => ({ type: 'characterData', target, addedNodes: [], removedNodes: [] })
const attribute = (target, attributeName) => ({ type: 'attributes', target, attributeName, addedNodes: [], removedNodes: [] })

test('one observer with the union of the watchers\' needs; it stops when the last one goes', t => {
  const saved = globalThis.Element; globalThis.Element = /** @type {any} */ (FakeElement); t.after(() => { globalThis.Element = saved })
  const { page, observed } = harness()
  const stopIcons = page.watch({ name: 'icons', run() {}, childList: true, attributes: ['data-sidebar-collapsed'] })
  const stopLabel = page.watch({ name: 'label', run() {}, timing: 'sync', characterData: true, attributes: ['data-shimmer-text'], within: '[data-chat-running]', ignore: null })
  assert.equal(observed.length, 1)
  assert.deepEqual(observed[0].options, { subtree: true, childList: true, characterData: true, attributeFilter: ['data-shimmer-text', 'data-sidebar-collapsed'] })
  stopLabel()
  assert.deepEqual(observed[0].options, { subtree: true, childList: true, characterData: false, attributeFilter: ['data-sidebar-collapsed'] })
  stopIcons()
  assert.equal(observed[0].options, undefined)
})

test('streaming inside a conversation wakes only the watcher that looks there; frame watchers run once per frame', t => {
  const saved = globalThis.Element; globalThis.Element = /** @type {any} */ (FakeElement); t.after(() => { globalThis.Element = saved })
  const { page, fire, flush, frames } = harness()
  const calls = []
  page.watch({ name: 'create', run: () => calls.push('create'), childList: true, characterData: true })
  page.watch({ name: 'label', run: records => calls.push('label:' + records.length), timing: 'sync', childList: true, characterData: true, attributes: ['data-shimmer-text'], within: '[data-chat-running]', ignore: null })
  fire([characterData(new FakeText(reply)), childList(reply, [new FakeText(reply)])])
  assert.deepEqual(calls, [], 'A reply streaming outside the running row wakes nobody')
  assert.equal(frames.length, 0)
  fire([characterData(label), characterData(new FakeText(reply))])
  assert.deepEqual(calls, ['label:1'], 'The running label runs at once, with its own records only')
  const row = new FakeElement({ 'data-chat-running': '' })
  fire([childList(content, [row])])
  assert.deepEqual(calls, ['label:1', 'label:1'], 'A running row being added counts though its parent is outside it')
  fire([childList(sidebar, [new FakeElement({})])])
  fire([childList(sidebar, [new FakeElement({})])])
  assert.equal(frames.length, 1)
  flush()
  assert.deepEqual(calls.slice(2), ['create'], 'Two batches, one frame run')
})

test('an attribute of the ignored element itself still counts; menus are seen anywhere, added or removed', t => {
  const saved = globalThis.Element; globalThis.Element = /** @type {any} */ (FakeElement); t.after(() => { globalThis.Element = saved })
  const { page, fire, flush } = harness()
  const calls = []
  page.watch({ name: 'header', run: () => calls.push('header'), childList: true, attributes: ['data-conversation-session'] })
  page.watch({ name: 'menus', run: () => calls.push('menus'), timing: 'sync', childList: true, within: '[role="menu"]', ignore: null })
  fire([attribute(content, 'data-conversation-session')])
  flush()
  assert.deepEqual(calls, ['header'], 'Switching the Session on the conversation element is seen')
  fire([childList(reply, [menuHost])])
  fire([childList(reply, [], [menuHost])])
  fire([childList(menu, [new FakeElement({ role: 'menuitem' })])])
  flush()
  // The last batch is outside any conversation (a portaled menu), so the header watcher looks once too.
  assert.deepEqual(calls, ['header', 'menus', 'menus', 'menus', 'header'], 'A menu opened inside a conversation, closed, or filled')
})

test('a watcher that throws does not stop the others', t => {
  const saved = { Element: globalThis.Element, error: console.error }
  globalThis.Element = /** @type {any} */ (FakeElement); console.error = () => {}
  t.after(() => { globalThis.Element = saved.Element; console.error = saved.error })
  const { page, fire } = harness()
  const calls = []
  page.watch({ name: 'broken', run() { throw new Error('boom') }, timing: 'sync', childList: true })
  page.watch({ name: 'fine', run: () => calls.push('fine'), timing: 'sync', childList: true })
  fire([childList(sidebar, [new FakeElement({})])])
  assert.deepEqual(calls, ['fine'])
})
