import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { readJsonFile, writeRecord } from '../harness/shared/atomic-json.ts'
import { ttlCache } from '../harness/shared/cache.js'
import { pageRoute, readJsonBody, RouteError } from '../harness/shared/http.js'
import { figPlugins } from '../harness/plugins.ts'
import { tempDir } from './helpers/temp-dir.mjs'

test('the cache shares one load, reuses it until it expires and reloads for another key', async () => {
  const cache = ttlCache(60_000)
  let loads = 0
  const load = () => new Promise(resolve => setTimeout(() => resolve(++loads), 5))
  assert.deepEqual(await Promise.all([cache.get(load), cache.get(load)]), [1, 1])
  assert.equal(await cache.get(load), 1)
  cache.expire()
  assert.equal(cache.last, 1)
  assert.equal(await cache.get(load), 2)
  assert.equal(await cache.get(load, 'other'), 3)
  cache.clear()
  assert.equal(cache.last, undefined)
})

function call(route, endpoint, body, { method = 'POST', rejection, context } = {}) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)])
  Object.assign(req, { method, url: '/fig-test/' + endpoint })
  return new Promise(resolve => {
    const res = { writeHead(status) { this.status = status }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }) } }
    route({ requestRejection: () => rejection }, req, res, context)
  })
}

test('a page route answers checked POSTs and never echoes endpoint errors', async () => {
  const route = pageRoute({
    prefix: '/fig-test', bodyLimit: 32,
    endpoints: {
      echo: (payload, context) => ({ payload, context }),
      strict: () => { throw new RouteError(400, 'BAD_REQUEST') },
      broken: () => { throw new Error('token=secret') }
    },
    failure: (_error, endpoint) => ({ code: 'TEST', message: 'failed ' + endpoint })
  })
  assert.deepEqual(await call(route, 'echo', { a: 1 }, { context: 'c' }), { status: 200, body: { ok: true, value: { payload: { a: 1 }, context: 'c' } } })
  assert.deepEqual((await call(route, 'echo')).body.value.payload, {})
  assert.equal((await call(route, 'echo', {}, { rejection: 403 })).status, 403)
  assert.equal((await call(route, 'echo', {}, { method: 'GET' })).status, 404)
  assert.equal((await call(route, 'missing', {})).status, 404)
  assert.equal((await call(route, 'echo', 'not json')).status, 400)
  assert.equal((await call(route, 'echo', { text: 'x'.repeat(64) })).status, 413)
  assert.equal((await call(route, 'strict', {})).status, 400)
  assert.deepEqual(await call(route, 'broken', {}), { status: 200, body: { ok: false, error: { code: 'TEST', message: 'failed broken' } } })
})

test('a JSON body keeps a character split across chunks', async () => {
  const bytes = Buffer.from(JSON.stringify({ text: '中文历史' }))
  const cut = bytes.indexOf(Buffer.from('文')) + 1
  const req = Readable.from((async function* () {
    yield bytes.subarray(0, cut)
    await new Promise(resolve => setImmediate(resolve)) // arrives as a second chunk
    yield bytes.subarray(cut)
  })(), { objectMode: false })
  assert.deepEqual(await readJsonBody(req, 1000), { payload: { text: '中文历史' } })
})

test('JSON files are written owner-only without leftovers and read without moving foreign files', async t => {
  const dir = await tempDir(t, 'fig-atomic-json-')
  const path = join(dir, 'nested/value.json')
  await writeRecord(path, { version: 1 })
  assert.equal(await readFile(path, 'utf8'), '{"version":1}\n')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(join(dir, 'nested')), ['value.json'])
  assert.deepEqual(await readJsonFile(path), { version: 1 })
  assert.equal(await readJsonFile(join(dir, 'missing.json')), undefined)
  await writeFile(join(dir, 'broken.json'), '{')
  assert.equal(await readJsonFile(join(dir, 'broken.json')), undefined)
  assert.ok((await readdir(dir)).includes('broken.json'))
})

test('the plugin table lists every plugin directory with files that exist', async () => {
  const harness = fileURLToPath(new URL('../harness/', import.meta.url))
  const withPatch = []
  for (const entry of await readdir(harness, { withFileTypes: true })) {
    if (entry.isDirectory() && await access(join(harness, entry.name, 'cordis.patch.yml')).then(() => true, () => false)) withPatch.push(entry.name)
  }
  assert.deepEqual(figPlugins.map(plugin => plugin.name).sort(), withPatch.sort())
  for (const { name, assets, entries } of figPlugins) {
    for (const file of [...assets, ...entries.map(entry => entry + '.js')]) await access(join(harness, name, file))
  }
  // Each row's id is the one its own patch inserts, so Fig's config rows (app/main/plugin-config.ts) reach it.
  const { parse } = await import('yaml')
  for (const { name, id } of figPlugins) {
    const patch = parse(await readFile(join(harness, name, 'cordis.patch.yml'), 'utf8'))
    assert.equal(patch[0].insert[0].id, id, name)
    // A bundle's own patch inserts the same entry by package name, so DSH can show its title and description.
    const manifest = JSON.parse(await readFile(join(harness, name, 'package.json'), 'utf8'))
    if (manifest.dsh?.bundle) {
      const bundle = parse(await readFile(join(harness, name, manifest.dsh.bundle.patch), 'utf8'))
      assert.deepEqual(bundle[0].insert[0], { id, name: manifest.name }, name + ' bundle patch')
    }
  }
})

test('the containing Workspace is the longest one holding the directory; its name is the last segment', async () => {
  const { containingWorkspace, workspaceName } = await import('../harness/shared/workspaces.ts')
  const workspaces = [{ path: '/w' }, { path: '/w/alpha' }, { path: '/x/' }]
  assert.equal(containingWorkspace(workspaces, '/w/alpha/sub')?.path, '/w/alpha')
  assert.equal(containingWorkspace(workspaces, '/w/alpha')?.path, '/w/alpha')
  assert.equal(containingWorkspace(workspaces, '/w/alphabet')?.path, '/w')
  assert.equal(containingWorkspace(workspaces, '/x/y')?.path, '/x/')
  assert.equal(containingWorkspace(workspaces, '/elsewhere'), undefined)
  assert.equal(workspaceName('/w/alpha/'), 'alpha')
  assert.equal(workspaceName('/'), undefined)
})

test('no two packages serve page routes under overlapping prefixes', async () => {
  // DSH routes by prefix; one package's prefix inside another's would take its requests (as /fig-desktop once did).
  const harness = fileURLToPath(new URL('../harness/', import.meta.url))
  const prefixes = new Set()
  for (const entry of await readdir(harness, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(js|ts)$/.test(entry.name)) continue
    const source = await readFile(join(entry.parentPath, entry.name), 'utf8')
    for (const match of source.matchAll(/(?:prefix|Prefix) = '(\/[\w-]+)'|registerPageRoute\(\w+, '(\/[\w-]+)'/g)) prefixes.add(match[1] ?? match[2])
  }
  assert.ok(prefixes.size >= 9, [...prefixes].join(' '))
  for (const a of prefixes) for (const b of prefixes) if (a !== b) assert.ok(!b.startsWith(a), `${b} starts with ${a}`)
})
