import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { WorkbenchRecovery, type RecoveryFailure } from '../app/main/workbench-recovery'

function setup(t: TestContext, load = async () => {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const failures: RecoveryFailure[] = []
  const changes: string[] = []
  const state = { ready: true, attempts: 0, attached: 0 }
  const recovery: WorkbenchRecovery = new WorkbenchRecovery({
    active: () => state.ready,
    load: async () => { state.attempts++; await load() },
    changed: () => changes.push(recovery.phase),
    recovered: () => { state.attached++ },
    failed: reason => failures.push(reason)
  }, () => Date.now())
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms)
    await Promise.resolve()
    await Promise.resolve()
  }
  return { recovery, state, changes, failures, tick }
}

test('the fourth crash within 60 seconds waits until the oldest crash leaves the window', async t => {
  const { recovery, state, changes, tick } = setup(t)
  for (let i = 0; i < 3; i++) {
    recovery.crashed()
    await tick(499)
    assert.equal(state.attempts, i)
    await tick(1)
    assert.equal(recovery.phase, 'normal')
  }
  recovery.crashed()
  assert.equal(recovery.phase, 'rate-limited')
  await tick(58_499)
  assert.equal(state.attempts, 3)
  await tick(1)
  assert.equal(state.attached, 4)
  assert.equal(recovery.phase, 'normal')
  assert.deepEqual(changes, ['recovering', 'recovering', 'recovering', 'rate-limited', 'recovering'])
})

test('the fifth crash in one DSH launch stops automatic recovery', async t => {
  const { recovery, state, failures, tick } = setup(t)
  for (let i = 0; i < 4; i++) { recovery.crashed(); await tick(60_000) }
  assert.equal(state.attached, 4)
  recovery.crashed()
  await tick(120_000)
  assert.equal(recovery.phase, 'failed')
  assert.deepEqual(failures, ['limit'])
  assert.equal(state.attempts, 4)
})

test('a crash exactly 60 seconds old does not count toward the limit', async t => {
  const { recovery, state, tick } = setup(t)
  for (let i = 0; i < 3; i++) { recovery.crashed(); await tick(500) }
  await tick(58_500)
  recovery.crashed()
  assert.equal(recovery.phase, 'recovering')
  await tick(500)
  assert.equal(state.attached, 4)
})

test('a reload rejection or another crash during an active reload gives up', async t => {
  await t.test('load rejected', async t => {
    const { recovery, failures, state, tick } = setup(t, async () => { throw new Error('synthetic load error') })
    recovery.crashed()
    await tick(500)
    await tick(120_000)
    assert.equal(recovery.phase, 'failed')
    assert.deepEqual(failures, ['load'])
    assert.equal(state.attached, 0)
  })
  await t.test('renderer died in flight', async t => {
    const { recovery, failures, state, tick } = setup(t, () => new Promise(() => {}))
    recovery.crashed()
    await tick(500)
    recovery.crashed()
    await tick(120_000)
    assert.deepEqual(failures, ['load'])
    assert.equal(state.attempts, 1)
  })
})

test('the recovery deadline also bounds an unresponsive reload', async t => {
  const { recovery, failures, state, tick } = setup(t, () => new Promise(() => {}))
  recovery.crashed()
  await tick(500)
  await tick(119_499)
  assert.deepEqual(failures, [])
  await tick(1)
  assert.deepEqual(failures, ['timeout'])
  assert.equal(state.attached, 0)
})

test('a resumed timer past the two-minute deadline fails without reloading', async t => {
  const { recovery, state, failures, tick } = setup(t)
  for (let i = 0; i < 3; i++) { recovery.crashed(); await tick(500) }
  recovery.crashed()
  t.mock.timers.setTime(122_000)
  await tick(0)
  assert.equal(state.attempts, 3)
  assert.deepEqual(failures, ['timeout'])
})

test('DSH exit prevents a scheduled reload', async t => {
  const { recovery, state, failures, tick } = setup(t)
  recovery.crashed()
  state.ready = false
  await tick(120_000)
  assert.equal(state.attempts, 0)
  assert.deepEqual(failures, [])
})

test('DSH exit suppresses a rejection from an in-flight reload', async t => {
  let rejectLoad!: (reason: Error) => void
  const { recovery, state, failures, tick } = setup(t, () => new Promise((_, reject) => { rejectLoad = reject }))
  recovery.crashed()
  await tick(500)
  state.ready = false
  rejectLoad(new Error('DSH exited'))
  recovery.crashed()
  await tick(120_000)
  assert.equal(state.attempts, 1)
  assert.equal(state.attached, 0)
  assert.deepEqual(failures, [])
})

test('manual retry cancels the previous DSH launch recovery before a new one can load', async t => {
  const { recovery, state, failures, tick } = setup(t)
  recovery.crashed()
  recovery.cancel()
  await tick(500)
  recovery.crashed()
  await tick(120_000)
  assert.equal(state.attempts, 0)
  assert.deepEqual(failures, [])
})

test('quit or view removal prevents an in-flight result from presenting the page', async t => {
  let finish!: () => void
  const { recovery, state, failures, tick } = setup(t, () => new Promise(resolve => { finish = resolve }))
  recovery.crashed()
  await tick(500)
  recovery.cancel()
  finish()
  await tick(120_000)
  assert.equal(state.attached, 0)
  assert.deepEqual(failures, [])
})
