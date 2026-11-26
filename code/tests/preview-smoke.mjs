import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from '../harness/preview/index.js'
import { pageRenderer } from '../harness/shell-bridge/index.js'
import { figCommand } from '../scripts/isolated-fig.mjs'

// Fig's capture mode on a page with known defects (tests/fixtures/preview-page.html): each one must
// appear in the preview report, and the wide table in a scrolling container must not. Needs a build.
const code = fileURLToPath(new URL('..', import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'fig-preview-smoke-'))
try {
  // The page capture Fig's shell-bridge lends the preview package.
  const renderPage = pageRenderer(await figCommand())
  const started = Date.now()
  const result = await preview({ target: 'tests/fixtures/preview-page.html', selectors: ['#title'] }, code, { renderPage, home })
  console.log(`Captured 2 widths in ${Date.now() - started} ms`)
  console.log(result.text)
  assert.match(result.consoleErrors.join('\n'), /fixture script failure/)
  assert.ok(result.externalHosts.includes('fonts.example.invalid'))
  assert.ok(result.failedRequests.some(entry => entry.includes('missing-image.png')))
  const [wide, phone] = result.views
  assert.equal(wide.overflowX, 0)
  assert.ok(wide.contentTop >= 150, 'the sprite leaves blank space at the top: ' + wide.contentTop)
  assert.ok(phone.overflowX > 0)
  assert.deepEqual(phone.overflowing.map(item => item.element.split(' ')[0]), ['div.card'])
  assert.equal(phone.brokenImages.length, 1)
  assert.equal(phone.boxes[0].boxes.length, 1)
  for (const view of result.views) assert.ok((await stat(view.screenshot)).size > 1000)
  const dark = await preview({ target: 'tests/fixtures/preview-page.html', widths: [800], theme: 'dark', selectors: ['#theme'] }, code, { renderPage, home })
  assert.ok(dark.views[0].boxes[0].boxes[0].width > 0, 'prefers-color-scheme: dark applies')
  console.log('PASS: the preview report names every defect of the fixture page, in light and dark')
} finally {
  await rm(home, { recursive: true, force: true })
}
