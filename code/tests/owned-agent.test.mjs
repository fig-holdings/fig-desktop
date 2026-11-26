import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { runOwnedAgent, signalOwnedGroup } from '../harness/shared/owned-agent.js'
import { tempDir } from './helpers/temp-dir.mjs'

const fixture = fileURLToPath(new URL('./fixtures/owned-agent.mjs', import.meta.url))
async function waitFor(check) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) { if (await check()) return; await delay(30) }
  throw new Error('owned-agent fixture timed out')
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function setup(t, mode) {
  const cwd = await tempDir(t, 'fig-owned-test-')
  const record = join(cwd, 'pids.json')
  return { cwd, record, command: { file: process.execPath, args: [fixture, mode, record], cwd, input: 'synthetic review' } }
}
async function pids(record) {
  let data
  await waitFor(async () => { try { data = JSON.parse(await readFile(record, 'utf8')); return true } catch { return false } })
  return data
}

test('normal CLI exit waits for stubborn descendant cleanup and preserves logical status', async t => {
  const { cwd, record, command } = await setup(t, 'normal')
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  try {
    const result = await runOwnedAgent(command)
    const ids = await pids(record)
    await waitFor(() => Object.values(ids).every(pid => !alive(pid)))
    assert.equal(result.code, 7)
    assert.match(result.out, /fixture-answer/)
    assert.ok(result.elapsedMs >= 1900)
    assert.ok(alive(unrelated.pid))
  } finally { unrelated.kill('SIGKILL') }
})

test('abort, repeated abort and already aborted invocation leave no owned child', async t => {
  const { cwd, record, command } = await setup(t, 'stubborn')
  const controller = new AbortController()
  const pending = runOwnedAgent({ ...command, signal: controller.signal })
  const ids = await pids(record)
  controller.abort(new Error('fixture cancellation'))
  controller.abort()
  await assert.rejects(pending, /fixture cancellation/)
  await waitFor(() => Object.values(ids).every(pid => !alive(pid)))
  await assert.rejects(runOwnedAgent({ ...command, signal: controller.signal }), /fixture cancellation/)
})

test('spawn failure settles only after supervisor cleanup', async () => {
  const started = Date.now()
  await assert.rejects(runOwnedAgent({ file: '/nonexistent/fig-agent', args: [], cwd: tmpdir(), input: '' }), { code: 'ENOENT' })
  assert.ok(Date.now() - started >= 1900)
})

test('IPC disconnect after parent crash cleans the entire pinned group', async t => {
  const { cwd, record, command } = await setup(t, 'stubborn')
  const helper = new URL('../harness/shared/owned-agent.js', import.meta.url).href
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `import { runOwnedAgent } from ${JSON.stringify(helper)}; await runOwnedAgent(${JSON.stringify(command)})`], { stdio: 'ignore' })
  try {
    const ids = await pids(record)
    parent.kill('SIGKILL')
    await waitFor(() => Object.values(ids).every(pid => !alive(pid)))
  } finally { parent.kill('SIGKILL') }
})

test('a connected supervisor never races the parent with its own KILL timer', async t => {
  const { cwd, record, command } = await setup(t, 'stubborn')
  const leader = spawn(process.execPath, [fileURLToPath(new URL('../harness/shared/owned-agent-supervisor.js', import.meta.url))], {
    cwd, detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc']
  })
  const closed = new Promise(resolve => leader.once('close', resolve))
  try {
    await new Promise(resolve => leader.once('message', message => { assert.equal(message.type, 'ready'); resolve() }))
    leader.send({ type: 'start', ...command })
    leader.stdin.end(command.input)
    const ids = await pids(record)
    process.kill(-leader.pid, 'SIGTERM')
    leader.send({ type: 'stop' })
    await delay(2300)
    assert.ok(alive(leader.pid), 'leader must remain pinned for the parent, without competing self-KILL')
    assert.ok(alive(ids.worker))
  } finally {
    if (leader.exitCode === null && leader.signalCode === null) process.kill(-leader.pid, 'SIGKILL')
    await closed
  }
})

test('unexpected supervisor exit fails unconfirmed without signaling a recycled group', async t => {
  const { cwd, record, command } = await setup(t, 'leader-crash')
  await assert.rejects(runOwnedAgent(command), { code: 'AGENT_CLEANUP_FAILED' })
  const ids = await pids(record)
  // These known fixture PIDs are cleaned by the test, never by the production helper's stale PGID.
  for (const pid of [ids.cli, ids.worker]) if (alive(pid)) process.kill(pid, 'SIGKILL')
})

test('group signaling treats ESRCH as exited, rejects EPERM and never uses a closed leader', () => {
  const leader = { pid: 123, exitCode: null, signalCode: null }
  assert.doesNotThrow(() => signalOwnedGroup(leader, 'SIGTERM', () => { throw Object.assign(new Error(), { code: 'ESRCH' }) }))
  assert.throws(() => signalOwnedGroup(leader, 'SIGTERM', () => { throw Object.assign(new Error(), { code: 'EPERM' }) }), { code: 'EPERM' })
  assert.throws(() => signalOwnedGroup({ ...leader, exitCode: 0 }, 'SIGKILL', () => assert.fail('must not kill')), /leader-exited/)
})
