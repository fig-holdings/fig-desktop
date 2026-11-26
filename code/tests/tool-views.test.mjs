import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { findingsRequest, parseFindings } from '../harness/delegate/index.js'
import { previewMeta, shotRoute } from '../harness/preview/index.js'
import { absolutePath, argsOf, duration, installToolViewStyle, metaOf, resultText, shortTarget, stateOf } from '../harness/shared/page-tool-view.js'
import { figPlugins } from '../harness/plugins.ts'
import { tempDir } from './helpers/temp-dir.mjs'

test('a delegated answer lists its problems after the last FINDINGS line', () => {
  assert.equal(parseFindings('Looks fine to me.'), undefined, 'no block: not a structured review')
  assert.deepEqual(parseFindings('All good.\n\nFINDINGS\nnone'), [])
  assert.deepEqual(parseFindings('FINDINGS\n[low] old.js - superseded\n\nSecond pass.\n**FINDINGS:**\n- [HIGH] `src/a.ts:12` - null is dereferenced\n[medium] docs/readme.md — stale link\nnot a finding'), [
    { severity: 'high', path: 'src/a.ts', line: 12, summary: 'null is dereferenced' },
    { severity: 'medium', path: 'docs/readme.md', line: null, summary: 'stale link' }
  ])
  assert.equal(parseFindings('FINDINGS\n' + Array.from({ length: 80 }, (_, i) => `[low] f${i}.js - x`).join('\n')).length, 50)
  assert.match(findingsRequest, /FINDINGS/)
})

test('preview meta carries counts and names only its own screenshots', () => {
  const home = '/home/dsh'
  const meta = previewMeta({ target: 'file:///w/page.html', theme: 'dark', title: 'T', consoleErrors: ['a', 'b'], failedRequests: [],
    steps: [{ status: 'pass' }, { status: 'fail' }],
    views: [
      { width: 1440, overflowX: 12, brokenImages: ['x.png'], screenshot: '/home/dsh/fig/preview/2026-run-ab12cd/1440-dark.png' },
      { width: 390, error: 'timeout' },
      { width: 800, screenshot: '/elsewhere/800-dark.png' }
    ] }, home)
  assert.equal(meta.kind, 'fig-preview')
  assert.deepEqual([meta.consoleErrors, meta.failedRequests, meta.failedSteps], [2, 0, 1])
  assert.deepEqual(meta.views.map(view => view.shot), ['2026-run-ab12cd/1440-dark.png', null, null])
  assert.deepEqual(meta.views[0], { width: 1440, error: null, overflowX: 12, brokenImages: 1, screenshot: '/home/dsh/fig/preview/2026-run-ab12cd/1440-dark.png', shot: '2026-run-ab12cd/1440-dark.png' })
})

test('the screenshot route serves only preview screenshots to an accepted request', async t => {
  const home = await tempDir(t, 'fig-shot-')
  await mkdir(join(home, 'fig/preview/run-1'), { recursive: true })
  await writeFile(join(home, 'fig/preview/run-1/390-light.png'), 'PNG')
  await writeFile(join(home, 'fig/secret.png'), 'SECRET')
  const route = shotRoute(home)
  const ask = async (body, { method = 'POST', rejection = 0 } = {}) => {
    const req = Object.assign(Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]), { method })
    const res = { status: 0, body: undefined, writeHead(status) { this.status = status }, end(data) { this.body = data } }
    await route({ requestRejection: () => rejection }, req, res)
    return res
  }
  assert.equal(String((await ask({ shot: 'run-1/390-light.png' })).body), 'PNG')
  assert.equal((await ask({ shot: 'run-1/390-light.png' }, { rejection: 403 })).status, 403)
  assert.equal((await ask({ shot: 'run-1/390-light.png' }, { method: 'GET' })).status, 404)
  for (const shot of ['../secret.png', 'run-1/../../secret.png', '/etc/passwd', 'run-1/result.json', 7]) assert.equal((await ask({ shot })).status, 400, String(shot))
  assert.equal((await ask({ shot: 'run-2/390-light.png' })).status, 404)
  assert.equal((await ask('not json')).status, 400)
})

test('tool rows read meta, arguments and state from each phase', () => {
  const result = { phase: 'result', block: { isError: false, meta: { kind: 'fig-handoff', sessionId: 's' }, call: { argsRaw: '{"title":"T"}' }, content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } }
  assert.equal(metaOf(result, 'fig-handoff').sessionId, 's')
  assert.equal(metaOf(result, 'fig-preview'), undefined, "another tool's meta is not this view's")
  assert.equal(metaOf({ phase: 'start', block: { argsRaw: '{}' } }, 'fig-handoff'), undefined)
  assert.equal(metaOf({ phase: 'result', block: {} }, 'fig-handoff'), undefined, 'a result recorded before the tool had meta')
  assert.deepEqual(argsOf(result), { title: 'T' })
  assert.deepEqual(argsOf({ phase: 'start', block: { argsRaw: '{"agent":"codex"}' } }), { agent: 'codex' })
  assert.deepEqual(argsOf({ phase: 'preparing', block: {} }), {})
  assert.deepEqual(argsOf({ phase: 'result', block: { call: null } }), {}, 'the call left the loaded window')
  assert.deepEqual(argsOf({ phase: 'start', block: { argsRaw: '{' } }), {})
  assert.equal(resultText(result.block), 'a\nb')
  assert.deepEqual([stateOf({ phase: 'preparing' }), stateOf({ phase: 'start' }), stateOf(result), stateOf({ phase: 'result', block: { isError: true } })], ['running', 'running', 'done', 'error'])
  assert.equal(absolutePath('src/a.ts', '/w/'), '/w/src/a.ts')
  assert.equal(absolutePath('/abs/a.ts', '/w'), '/abs/a.ts')
  assert.equal(absolutePath('a.ts', undefined), 'a.ts')
  assert.equal(shortTarget('file:///private/var/w/site/a%20b.html', '/var/w'), 'site/a b.html')
  assert.equal(shortTarget('file:///elsewhere/page.html', '/w'), 'page.html')
  assert.equal(shortTarget('http://localhost:5173/app', '/w'), 'http://localhost:5173/app')
  assert.deepEqual([duration(400), duration(42_400), duration(185_000)], ['0s', '42s', '3m 05s'])
})

test('the three tools ship a page client', () => {
  for (const name of ['preview', 'handoff', 'delegate']) assert.ok(figPlugins.find(plugin => plugin.name === name).assets.includes('client.js'), name)
})

test('the shared tool-row style stays until the last plugin drawing rows lets go', () => {
  const nodes = new Map()
  const doc = {
    getElementById: id => nodes.get(id) ?? null,
    createElement: () => { const node = { dataset: {}, remove: () => nodes.delete(node.id) }; return node },
    head: { append: node => nodes.set(node.id, node) }
  }
  const preview = installToolViewStyle(doc), delegate = installToolViewStyle(doc)
  assert.equal(nodes.size, 1)
  preview(); preview()
  assert.equal(nodes.size, 1, 'delegate still draws rows after preview is switched off')
  delegate()
  assert.equal(nodes.size, 0)
})
