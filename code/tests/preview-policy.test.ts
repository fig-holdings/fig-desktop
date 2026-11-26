import assert from 'node:assert/strict'
import {test} from 'node:test'
import {previewStepPlan, authorizePreview, mutatesPreview} from '../harness/shared/preview-policy'
const click = [{action: 'click', selector: '#add'}]
test('preview validates all bounds and multiple widths before effects, without accepting scripts or system keys', () => {
  assert.equal(previewStepPlan({}), undefined); assert.equal(mutatesPreview({}), false)
  assert.deepEqual(previewStepPlan({steps: click})?.widths, [1440])
  for (const args of [
    {steps: click, widths: [390,390]}, {steps: click, widths: [0]}, {steps: Array(11).fill(click[0])},
    {steps: [{action: 'eval', selector: 'body'}]}, {steps: [{action: 'click', selector: '#a', script: 'evil'}]},
    {steps: [{action: 'press', selector: '#a', key: 'Meta+Q'}]}, {steps: [{action: 'fill', selector: '#a', text: 'a'.repeat(4097)}]},
    {steps: [{action: 'fill', selector: '#a', text: 'sk-' + 'a'.repeat(30)}]}, {steps: [{action: 'click', selector: 'a'.repeat(513)}]},
    {steps: click, target: 'x'.repeat(32769)}
  ]) assert.throws(() => previewStepPlan(args))
  assert.equal(previewStepPlan({steps: [{action: 'waitFor', selector: '#x'}]})?.mutating, false)
})

test('native approval gates effective preset knobs, all non-allow outcomes, full-access/never and permission changes', async () => {
  const plan = previewStepPlan({steps: click})!, agent = {session: {}}
  let name = 'workspace-write', sandbox = name, approval = 'ask', calls = 0, outcome = 'allowed-once', change = false
  const ctx = {permissionPresets: {current: () => name, resolve: () => ({sandbox, approval})}, approval: {request: async () => {calls++; if (change) sandbox = 'read-only'; return outcome}}}
  const exec = {agent, callId: 'synthetic'}, signal = new AbortController().signal
  assert.equal(await authorizePreview(ctx, exec, plan, 'http://127.0.0.1:1', signal), true); assert.equal(calls, 1)
  for (outcome of ['rejected','cancelled','unavailable']) await assert.rejects(authorizePreview(ctx, exec, plan, 'local', signal))
  for (name of ['read-only','custom','auto','unknown']) await assert.rejects(authorizePreview(ctx, exec, plan, 'local', signal))
  name = sandbox = 'danger-full-access'; approval = 'never'; const before = calls
  assert.equal(await authorizePreview(ctx, exec, plan, 'local', signal), true); assert.equal(calls, before)
  name = sandbox = 'workspace-write'; outcome = 'allowed-once'
  await assert.rejects(authorizePreview(ctx, exec, plan, 'local', signal), /disables approval/); assert.equal(calls, before)
  approval = 'ask'; change = true
  await assert.rejects(authorizePreview(ctx, exec, plan, 'local', signal), /Permission changed/)
  const observe = previewStepPlan({steps: [{action: 'waitFor', selector: '#x'}]})!
  name = 'unknown'; assert.equal(await authorizePreview(ctx, exec, observe, 'local', signal), false)
})
