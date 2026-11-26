import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { preview, previewTarget, previewText, previewWidths } from '../harness/preview/index.js'
import { tempDir } from './helpers/temp-dir.mjs'

test('targets are workspace files or localhost addresses only', async t => {
  const cwd = await tempDir(t, 'fig-preview-')
  await writeFile(join(cwd, 'page.html'), '<p>hi</p>')
  await mkdir(join(cwd, 'site'))
  await writeFile(join(cwd, 'site/index.html'), '<p>hi</p>')
  assert.equal(await previewTarget('page.html', cwd), pathToFileURL(join(cwd, 'page.html')).href)
  assert.equal(await previewTarget('site', cwd), pathToFileURL(join(cwd, 'site/index.html')).href)
  assert.equal(await previewTarget('http://localhost:5173/app', cwd), 'http://localhost:5173/app')
  assert.equal(await previewTarget('http://127.0.0.1:8787', cwd), 'http://127.0.0.1:8787/')
  await assert.rejects(previewTarget('https://example.com', cwd), /only local pages/)
  await assert.rejects(previewTarget('missing.html', cwd), /No such file/)
  await assert.rejects(previewTarget('', cwd), /file path or a localhost URL/)
})

test('widths keep 1 to 4 sane values, else the defaults', () => {
  assert.deepEqual(previewWidths(undefined), [1440, 390])
  assert.deepEqual(previewWidths([390, 390, 100, 5000, 768, 1024, 1280, 1920]), [390, 768, 1024, 1280])
  assert.deepEqual(previewWidths(['x']), [1440, 390])
})

test('the report states every finding in text', () => {
  const text = previewText('file:///p.html', 'dark', {
    title: 'P', consoleErrors: ['Uncaught Error: x'], failedRequests: ['404 file:///img.png'], externalHosts: ['fonts.example.com'],
    views: [
      { width: 390, pageHeight: 1800, contentTop: 160, overflowX: 310, overflowing: [{ element: 'div.card "A card"', right: 700 }],
        brokenImages: ['file:///img.png'], boxes: [{ selector: '#t', boxes: [{ x: 0, y: 160, width: 390, height: 40 }] }, { selector: '.none', boxes: [] }], screenshot: '/s/390.png' },
      { width: 1440, error: 'crashed' }
    ]
  })
  for (const part of ['dark theme', 'Uncaught Error: x', '404 file:///img.png', 'fonts.example.com', 'HORIZONTAL OVERFLOW 310px',
    'div.card "A card"', 'blank area above it', 'broken images', '390×40 at (0, 160)', '.none: not found', '/s/390.png', '1440px: could not capture']) {
    assert.ok(text.includes(part), part)
  }
  assert.match(previewText('x', 'light', { consoleErrors: [], failedRequests: [], externalHosts: [], views: [] }), /works offline/)
})

test('preview refuses to run without a page capture from the shell', async () => {
  await assert.rejects(preview({ target: 'x.html' }, tmpdir(), { home: tmpdir() }), /needs a page capture/)
})

test('the preview tool exists only where the shell lends a page capture', async () => {
  const { apply } = await import('../harness/preview/index.js')
  const run = async capabilities => {
    const registered = []
    const scope = { shellCapabilities: capabilities, effect: fn => fn() }
    apply({ inject: (names, fn) => { assert.deepEqual(names, ['shellCapabilities']); fn(scope) }, tools: { register: tool => { registered.push(tool); return () => {} } }, logger: { warn: () => {} } })
    await new Promise(resolve => setTimeout(resolve, 50))
    return registered
  }
  assert.equal((await run({ alerts: true })).length, 0, 'a shell without a page capture: no tool')
  // With one, registration needs DSH's tool definitions (the native schema smoke covers it); here it must at least try.
  let asked = false
  await run({ renderPage: async () => { asked = true } })
  assert.equal(asked, false, 'nothing renders until the tool runs')
})
