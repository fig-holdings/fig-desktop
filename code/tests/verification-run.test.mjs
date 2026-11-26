import assert from 'node:assert/strict'
import { test } from 'node:test'
import { declareSuite, extraScenarioIds, scenarioIds, suiteExit } from './helpers/verification-run.mjs'

test('regression suite rejects empty, unknown and repeated selections before startup', () => {
  for (const only of ['', 'unknown', 'stop,stop', ',stop', 'stop,']) assert.throws(() => declareSuite('deepseek', only))
  assert.throws(() => declareSuite('unknown'))
  assert.equal(declareSuite('deepseek', 'stop').suite, 'subset')
  assert.equal(scenarioIds.length, 17)
  for (const provider of ['deepseek', 'deepseek-api', 'grok', 'chatgpt', 'claude']) {
    const { suite, expectedScenarioIds } = declareSuite(provider)
    assert.equal(suite, 'full', provider + ' runs the whole suite')
    assert.deepEqual(expectedScenarioIds, scenarioIds)
    assert.equal(declareSuite(provider, 'approval-reject,subagent').suite, 'subset')
    assert.deepEqual(declareSuite(provider, extraScenarioIds.join(',')).expectedScenarioIds, extraScenarioIds, 'extra checks only by name')
    for (const id of extraScenarioIds) assert.ok(!expectedScenarioIds.includes(id))
  }
})

test('exit zero requires a complete nonempty all-pass set; blocked, missing and skipped cannot release', () => {
  assert.equal(suiteExit([], []), 2)
  assert.equal(suiteExit(['a'], []), 3)
  assert.equal(suiteExit(['a'], [{ id: 'a', status: 'blocked' }]), 3)
  assert.equal(suiteExit(['a'], [{ id: 'a', status: 'skipped' }]), 3)
  assert.equal(suiteExit(['a'], [{ id: 'a', status: 'fail' }]), 1)
  assert.equal(suiteExit(['a'], [{ id: 'a', status: 'pass' }]), 0)
  assert.equal(suiteExit(['a'], [{ id: 'other', status: 'pass' }]), 2)
  assert.equal(suiteExit(['a'], [{ id: 'a', status: 'pass' }, { id: 'a', status: 'pass' }]), 2)
})
