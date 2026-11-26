import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewTarget } from '../harness/preview/index.js'
import { capturedLocally, interactiveTarget } from '../harness/shared/preview-policy.ts'

// What each caller accepts today. Columns: the preview tool's target (plain, then confined to an
// interactive run), the screenshot's "stays on this machine" check for loaded resources, and the
// interactive capture's target guard. null: previewTarget only reads http(s) text as a URL.
const rows = [
  ['http://localhost:3000/', true, true, true, true],
  ['https://127.0.0.1/', true, true, true, true],
  ['http://[::1]:8080/', true, true, true, true],
  ['http://LOCALHOST/', true, true, true, true],
  ['http://app.localhost/', true, false, true, false],
  ['http://localhost.example.com/', false, false, false, false],
  ['http://127.0.0.2/', false, false, false, false],
  ['http://0.0.0.0/', false, false, false, false],
  ['http://[::ffff:127.0.0.1]/', false, false, false, false],
  ['https://example.com/', false, false, false, false],
  ['http://user:pw@localhost/', false, false, true, false],
  ['http://user@127.0.0.1/', false, false, true, false],
  ['http://localhost/?token=x', true, false, true, true],
  ['http://localhost/?api_key=x', true, false, true, true],
  ['ws://localhost/', null, null, true, false],
  ['ftp://127.0.0.1/', null, null, true, false],
  ['ws://app.localhost/', null, null, true, false],
  ['file:///tmp/a.html', null, null, true, true],
  ['data:text/html,hi', null, null, true, false],
  ['blob:http://example.com/x', null, null, true, false],
  ['about:blank', null, null, true, false],
  ['javascript:alert(1)', null, null, false, false]
]

const accepts = promise => promise.then(() => true, () => false)

test('each caller keeps its own local-address rule', async () => {
  for (const [url, plain, confined, captured, interactive] of rows) {
    assert.equal(capturedLocally(new URL(url)), captured, 'screenshot resource ' + url)
    assert.equal(interactiveTarget(new URL(url)), interactive, 'interactive target ' + url)
    if (plain === null) continue
    assert.equal(await accepts(previewTarget(url, '/', false)), plain, 'preview ' + url)
    assert.equal(await accepts(previewTarget(url, '/', true)), confined, 'confined preview ' + url)
  }
})
