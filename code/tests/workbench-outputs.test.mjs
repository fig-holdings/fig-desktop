import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionOutputs, readOutputs } from '../harness/development-workbench/outputs.js'
const event = (seq, type, data) => ({ seq, type, data })
const call = (seq, id, name, args) => event(seq, 'tool/call', { callId: id, name, arguments: JSON.stringify(args) })
const result = (seq, id, path, isError = false) => event(seq, 'tool/result', { message: { source: { callId: id }, isError }, ...(path ? { meta: { path } } : {}) })
test('outputs collect successful session documents and explicit deliveries, not reads, failures or source code', () => {
  const events = [call(1, 'a', 'write', { file_path: 'one.md', content: 'x' }), result(2, 'a', '/repo/one.md'),
    call(3, 'b', 'read', { file_path: 'input.md' }), result(4, 'b', '/repo/input.md'),
    call(5, 'c', 'write', { file_path: 'fail.md', content: 'x' }), result(6, 'c', '/repo/fail.md', true),
    call(7, 'd', 'write', { file_path: 'code.js', content: 'x' }), result(8, 'd', '/repo/code.js'),
    call(9, 'e', 'edit', { file_path: 'one.md', old_string: 'x', new_string: 'y' }), result(10, 'e', '/repo/one.md'),
    event(11, 'deliverables/presented', { files: [{ path: 'chart.png', description: 'Chart' }, { path: 'one.md' }] })]
  assert.deepEqual(sessionOutputs(events, '/repo').map(f => f.path), ['/repo/chart.png', '/repo/one.md'])
  assert.equal(sessionOutputs(events, '/repo')[0].description, 'Chart')
  assert.deepEqual(sessionOutputs([], '/other'), [])
})
test('canonical metadata wins; invalid relative metadata does not guess a target', () => {
  assert.deepEqual(sessionOutputs([call(1, 'a', 'write', { file_path: 'x.md', content: '' }), result(2, 'a', 'relative.md')], '/repo'), [])
  assert.equal(sessionOutputs([call(1, 'a', 'write', { file_path: 'x.md', content: '' }), result(2, 'a', '/changed/x.md')], '/repo')[0].path, '/changed/x.md')
})
test('cold history is paged at a pinned cut, merged chronologically, without activating agents', async () => {
  const requests = []
  const controller = {
    async *follow(request) { assert.equal(request.activate, undefined); yield { type: 'snapshot', cursor: 4, header: { cwd: '/repo' } } },
    async events(request) { requests.push(request); return requests.length === 1
      ? { cursor: 4, hasMore: true, records: [{ event: result(4, 'a', '/repo/x.md') }] }
      : { cursor: 4, hasMore: false, records: [{ event: call(1, 'a', 'write', { file_path: 'x.md', content: 'x' }) }] } }
  }
  const value = await readOutputs(controller, 's', AbortSignal.timeout(1000))
  assert.equal(value.files[0].path, '/repo/x.md'); assert.equal(value.truncated, false)
  assert.equal(requests[1].beforeSeq, 4); assert.equal(requests[1].throughSeq, 4)
})
