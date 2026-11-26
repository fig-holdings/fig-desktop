import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { historyLimit, historyStore, scopeLimit } from '../harness/composer/history.js'
import { route } from '../harness/composer/index.js'
import { tempDir } from './helpers/temp-dir.mjs'

const file = async t => join(await tempDir(t, 'fig-history-'), 'fig', 'input-history.json')

test('history keeps sent text per workspace across a restart', async t => {
  const path = await file(t)
  const store = historyStore(path)
  assert.equal(await store.add('/w/a', 'first'), true)
  assert.equal(await store.add('/w/a', 'first'), false, 'a repeat of the last entry is skipped')
  assert.equal(await store.add('/w/a', '   '), false)
  await store.add('/w/b', 'other')
  await store.add('/w/a', 'second')
  assert.deepEqual(await historyStore(path).list('/w/a'), ['first', 'second'])
  assert.deepEqual(await historyStore(path).list('/w/b'), ['other'])
  assert.deepEqual(await store.list('/w/none'), [])
})

test('history drops the oldest entries and least recent workspaces at the limits', async t => {
  const path = await file(t)
  const store = historyStore(path)
  for (let i = 0; i < historyLimit + 5; i++) await store.add('/w/a', 'm' + i)
  const list = await store.list('/w/a')
  assert.equal(list.length, historyLimit)
  assert.equal(list[0], 'm5')
  for (let i = 0; i < scopeLimit; i++) await store.add('/s/' + i, 'x')
  const saved = JSON.parse(await readFile(path, 'utf8')).scopes
  assert.equal(Object.keys(saved).length, scopeLimit)
  assert.equal(saved['/w/a'], undefined)
})

function call(endpoint, body, { method = 'POST', rejection } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(req, { method, url: '/fig-composer/' + endpoint })
  return new Promise(resolve => {
    const res = { writeHead(status) { this.status = status }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }) } }
    route({ requestRejection: () => rejection }, req, res, { history: store })
  })
}
let store

test('the route answers only checked POSTs to its known endpoints', async t => {
  store = historyStore(join(await tempDir(t, 'fig-history-route-'), 'h.json'))
  assert.deepEqual(await call('history/add', { scope: '/w', text: 'hi' }), { status: 200, body: { ok: true, value: true } })
  assert.deepEqual(await call('history/list', { scope: '/w' }), { status: 200, body: { ok: true, value: ['hi'] } })
  assert.equal((await call('history/list', { scope: '/w' }, { rejection: 403 })).status, 403)
  assert.equal((await call('history/list', { scope: '/w' }, { method: 'GET' })).status, 404)
  assert.equal((await call('history/clear', { scope: '/w' })).status, 404)
  assert.equal((await call('history/list', {})).status, 400)
})

test('an add during the first read keeps the other workspaces', async t => {
  const path = await file(t)
  await historyStore(path).add('/w/a', 'kept')
  const store = historyStore(path)
  await Promise.all([store.list('/w/a'), store.add('/w/b', 'new')])
  const saved = JSON.parse(await readFile(path, 'utf8')).scopes
  assert.deepEqual(saved, { '/w/a': ['kept'], '/w/b': ['new'] })
})
