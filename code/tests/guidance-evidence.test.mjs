import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guidanceDiagnostics } from './helpers/guidance-evidence.mjs'

const events = (line, id = 'p1', isError = false) => [
  { type: 'tool/call', data: { name: 'preview', callId: 'p1' } },
  { type: 'tool/result', data: { message: { toolCallId: id, isError, content: [{ type: 'text', text: 'Preview of file:///synthetic.html\n' + line }] } } }
]
test('guidance verdict needs this preview result and the actual narrow diagnostic, not generic checked text', () => {
  const input = events('390px: page height 900px; no horizontal overflow.')
  assert.ok(guidanceDiagnostics('390px: no horizontal overflow', input).diagnosticReferenced)
  assert.equal(guidanceDiagnostics('I checked the preview', input).diagnosticReferenced, false)
  assert.equal(guidanceDiagnostics('no horizontal overflow', events('390px: no horizontal overflow', 'wrong-call')).narrowObserved, false)
  assert.equal(guidanceDiagnostics('no horizontal overflow', events('390px: no horizontal overflow', 'p1', true)).diagnostics, 0)
  assert.equal(guidanceDiagnostics('No horizontal overflow', events('390px: HORIZONTAL OVERFLOW 330px')).diagnosticReferenced, false)
  assert.ok(guidanceDiagnostics('330px overflow remains', events('390px: HORIZONTAL OVERFLOW 330px')).diagnosticReferenced)
})
