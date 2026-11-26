import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, access, rm, writeFile, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileLifecycle } from '../scripts/verification-lifecycle.mjs'

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fig-lifecycle-unit-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}
const exists = async p => access(p).then(() => true, () => false)

test('success removes only its own profile and leaves evidence and neighbouring data', () => fixture(async evidence => {
  await writeFile(join(evidence, 'result.json'), '{}')
  const a = await profileLifecycle({ evidence, prefix: 'profile-' })
  const b = await profileLifecycle({ evidence, prefix: 'profile-', reportName: 'other.json' })
  assert.equal((await a.finish(true)).disposition, 'removed')
  assert.equal(await exists(a.profile), false)
  assert.equal(await exists(b.profile), true)
  assert.equal(await exists(join(evidence, 'result.json')), true)
}))
test('failure and omitted outcome retain profile with explicit reason', () => fixture(async evidence => {
  const run = await profileLifecycle({ evidence, prefix: 'fail-' })
  assert.equal((await run.finish()).reason, 'test-failed-or-incomplete')
  assert.equal(await exists(run.profile), true)
}))
test('explicit reuse survives successful finalization', () => fixture(async evidence => {
  const original = await profileLifecycle({ evidence, prefix: 'real-' })
  const reuse = await profileLifecycle({ evidence, prefix: 'real-', reuse: original.profile })
  assert.equal((await reuse.finish(true)).reason, 'explicit-reuse')
  assert.equal(await exists(original.profile), true)
}))
test('new real profile may be explicitly retained for future reuse', () => fixture(async evidence => {
  const run = await profileLifecycle({ evidence, prefix: 'real-', retainForReuse: true })
  assert.equal((await run.finish(true)).reason, 'explicit-reuse')
  assert.equal(await exists(run.profile), true)
}))
test('live tracked process prevents cleanup even when caller says passed', () => fixture(async evidence => {
  const run = await profileLifecycle({ evidence, prefix: 'live-' })
  run.track({ process: () => ({ pid: process.pid }) })
  assert.equal((await run.finish(true)).reason, 'process-exit-not-confirmed')
  assert.equal(await exists(run.profile), true)
}))
test('close failure retains profile', () => fixture(async evidence => {
  const run = await profileLifecycle({ evidence, prefix: 'close-' })
  const app = run.track({ process: () => ({ pid: process.pid }), evaluate: async () => undefined, close: async () => { throw Error('fixture close failed') } })
  await assert.rejects(run.close(app), /fixture close failed/)
  assert.equal((await run.finish(true)).disposition, 'retained')
}))
test('service process still alive prevents removal after host close', () => fixture(async evidence => {
  const run = await profileLifecycle({ evidence, prefix: 'service-', timeout: 0 })
  const app = run.track({ process: () => ({ pid: 2147483647 }), evaluate: async () => process.pid, close: async () => {} })
  await assert.rejects(run.close(app), /still alive/)
  assert.equal((await run.finish(true)).disposition, 'retained')
}))
test('replaced profile symlink is never followed for deletion', () => fixture(async evidence => {
  const run = await profileLifecycle({ evidence, prefix: 'replace-' })
  await rename(run.profile, run.profile + '-saved')
  await symlink(run.profile + '-saved', run.profile)
  await assert.rejects(run.finish(true), /identity changed/)
  assert.equal(await exists(run.profile + '-saved'), true)
}))
test('invalid reuse outside exact evidence parent is refused', () => fixture(async evidence => {
  await assert.rejects(profileLifecycle({ evidence, prefix: 'profile-', reuse: tmpdir() }), /outside expected/)
}))
