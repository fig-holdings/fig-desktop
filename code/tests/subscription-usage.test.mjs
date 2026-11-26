import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usageColor, usagePercent } from '../harness/shared/page-subscription-usage.js'

test('subscription rings use exact usage color boundaries', () => {
  for (const percent of [0, 12, 59.99]) assert.equal(usageColor(percent), '#22a06b')
  for (const percent of [60, 89, 90]) assert.equal(usageColor(percent), '#d99a16')
  for (const percent of [90.01, 100]) assert.equal(usageColor(percent), '#e5484d')
  assert.match(usageColor(undefined), /tertiary/)
})
test('unknown usage is not zero and finite usage is clamped', () => {
  for (const value of [null, undefined, NaN, Infinity, '30']) assert.equal(usagePercent(value), undefined)
  assert.equal(usagePercent(0), 0)
  assert.equal(usagePercent(-1), 0)
  assert.equal(usagePercent(101), 100)
})
