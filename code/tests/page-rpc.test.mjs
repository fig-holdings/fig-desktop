import assert from 'node:assert/strict'
import test from 'node:test'
import { pageRpc } from '../harness/shared/page-rpc.js'
import { pageCaller } from '../harness/shared/page-ui.js'

// The page's calls to its Host half: one helper, with the texts each caller showed before.
test('pageRpc returns the value and throws Errors with the Host code and the caller\'s texts', async t => {
  const saved = { fetch: globalThis.fetch, document: globalThis.document }
  t.after(() => { globalThis.fetch = saved.fetch; globalThis.document = saved.document })
  globalThis.document = /** @type {any} */ ({ documentElement: { lang: 'en' } })
  let answer, sent
  globalThis.fetch = /** @type {any} */ (async (url, init) => { sent = { url, body: init.body }; return answer() })
  const json = (status, body) => () => ({ ok: status < 400, json: async () => body })
  const noBody = status => () => ({ ok: status < 400, json: async () => { throw new SyntaxError('empty') } })

  const plain = pageRpc('/fig-x')
  answer = json(200, { ok: true, value: 7 })
  assert.equal(await plain('read'), 7)
  assert.deepEqual(sent, { url: '/fig-x/read', body: '{}' })
  answer = json(200, { ok: false, error: { code: 'X_DOWN', message: 'Host says no' } })
  await assert.rejects(plain('read'), error => error.message === 'fig-x read failed' && error.code === 'X_DOWN', 'Without texts the message stays fixed')

  const worded = pageRpc('/fig-x', { unavailable: () => 'Unavailable', failed: () => 'Failed' })
  await assert.rejects(worded('read'), error => error.message === 'Host says no' && error.code === 'X_DOWN')
  answer = json(409, { ok: false, error: { code: 'EXPIRED' } })
  await assert.rejects(worded('read'), error => error.message === 'Failed' && error.code === 'EXPIRED')
  answer = noBody(502)
  await assert.rejects(worded('read'), error => error.message === 'Unavailable' && error.code === undefined)
  await assert.rejects(pageCaller('/fig-x', () => '不可用', () => '失败')('read'), /^Error: 不可用$/)
})
