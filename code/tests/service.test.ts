import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import type { TestContext } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { DshService, dshArguments, parseLaunchUrl, stopProcessGroup } from '../app/main/service'
import { dshCandidate, dshEngines, launchDsh, verifiedDsh } from '../harness/dsh-versions'
import { sanitizeLog } from '../harness/shared/log'
import { findNodeRuntime, supportsDsh, withMacProxy } from '../harness/environment'
import { tempDir } from './helpers/temp-dir.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
const fixture = join(directory, 'fixtures/dsh-server.mjs')
const scratch = join(directory, '../../work/verification/unit')
await mkdir(scratch, { recursive: true })

async function setup(t: TestContext, mode = '', extra: Record<string, unknown> = {}) {
  const folder = await tempDir(t, 'service-', scratch)
  const record = join(folder, 'fixture.json')
  const service = new DshService({
    homeDirectory: join(folder, 'home'), workingDirectory: folder,
    startupTimeoutMs: 3000, stopTimeoutMs: 250,
    resolveCommand: async () => ({ executable: process.execPath, args: [fixture], env: { ...process.env, FIG_FIXTURE_MODE: mode, FIG_FIXTURE_RECORD: record } }),
    ...extra
  })
  return { service, record }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(30) }
  throw new Error('Timed out waiting for lifecycle condition')
}

function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

test('runtime discovery isolates its version probe but preserves user NODE_OPTIONS for DSH', async () => {
  const environment = {PATH: dirname(process.execPath), NODE_OPTIONS: '--fig-invalid-option-for-probe'}
  const runtime = await findNodeRuntime(environment)
  assert.ok(supportsDsh(runtime.version), 'the version probe must not consume user preload/options')
  assert.equal(runtime.environment.NODE_OPTIONS, environment.NODE_OPTIONS)
  assert.equal(environment.NODE_OPTIONS, '--fig-invalid-option-for-probe')
})

test('DSH Node version requirements and the installed-entry CLI invocation', () => {
  assert.equal(supportsDsh('v22.18.0'), false)
  assert.equal(supportsDsh('v22.19.0'), true)
  assert.equal(supportsDsh('v23.1.0'), false)
  assert.equal(supportsDsh('v24.18.0'), true)
  assert.equal(launchDsh, verifiedDsh.at(-1))
  const entry = '/cache/dsh/0.2.2-rc.5-abc/node_modules/@deepseek-ai/dsh/lib/bin.js'
  assert.deepEqual(dshArguments(entry), [entry, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
  assert.throws(() => dshArguments('@deepseek-ai/dsh@latest'))
})

test('plugin engines and the candidate come from the verified release list', () => {
  assert.equal(dshEngines(), verifiedDsh.join(' || '))
  assert.equal(dshEngines('9.9.9-rc.1'), [...verifiedDsh, '9.9.9-rc.1'].join(' || '))
  assert.equal(dshEngines(launchDsh), verifiedDsh.join(' || '), 'a verified candidate is not listed twice')
  assert.equal(dshCandidate({ FIG_DSH_CANDIDATE: '0.2.2-rc.1' }), '0.2.2-rc.1')
  assert.equal(dshCandidate({ FIG_DSH_CANDIDATE: 'latest' }), undefined)
  assert.equal(dshCandidate({}), undefined)
})

test('Finder-style launches inherit the enabled macOS HTTPS proxy and local bypasses', () => {
  const settings = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  HTTPEnable : 0
  HTTPPort : 8080
  HTTPProxy : proxy.test
  HTTPSEnable : 1
  HTTPSPort : 8081
  HTTPSProxy : proxy.test
  SOCKSEnable : 1
  SOCKSPort : 8082
  SOCKSProxy : proxy.test
}
`
  assert.deepEqual(withMacProxy({}, settings), {
    HTTPS_PROXY: 'http://proxy.test:8081',
    NO_PROXY: 'localhost,127.0.0.1,::1,*.local'
  })
  const explicit = { https_proxy: 'http://custom.test:3128' }
  assert.equal(withMacProxy(explicit, settings), explicit)
  assert.deepEqual(withMacProxy({}, settings.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), {})
})

test('accepts only the loopback startup announcement and redacts credentials', () => {
  assert.equal(parseLaunchUrl('dsh web: https://example.com/?token=no'), undefined)
  assert.equal(parseLaunchUrl('log: http://127.0.0.1:3000/'), undefined)
  assert.equal(parseLaunchUrl('dsh web: http://127.0.0.1:34321/?token=test'), 'http://127.0.0.1:34321/?token=test')
  const output = sanitizeLog('dsh web: http://127.0.0.1:34/?token=do-not-log api_key=private-key refresh_token=private-refresh')
  assert.ok(!output.includes('do-not-log') && !output.includes('private-key') && !output.includes('private-refresh'))
  assert.ok(!sanitizeLog(JSON.stringify({ access_token: 'quoted-secret', DEEPSEEK_API_KEY: 'private-key' })).includes('quoted-secret'))
  assert.ok(!sanitizeLog(JSON.stringify({ DEEPSEEK_API_KEY: 'private-key' })).includes('private-key'))
})

test('concurrent starts share one owned service and the token never enters UI state', async t => {
  const { service, record } = await setup(t)
  try {
    await Promise.all([service.start(), service.start()])
    const first = service.state.pid
    await service.start()
    assert.equal(service.state.pid, first)
    assert.equal(service.state.phase, 'ready')
    assert.match(service.launchUrl!, /token=fixture-token/)
    assert.ok(!JSON.stringify(service.state).includes('fixture-token'))
    const data = JSON.parse(await readFile(record, 'utf8'))
    assert.equal(data.pid, first)
    await service.stop()
    await waitFor(() => !alive(data.pid) && !alive(data.workerPid))
    assert.equal(service.state.phase, 'idle')
  } finally { await service.stop() }
})

test('early CLI exit produces a retryable failure without declaring readiness', async t => {
  const { service } = await setup(t, 'fail')
  await service.start()
  assert.equal(service.state.phase, 'failed')
  assert.match(service.state.error!, /23/)
  assert.equal(service.launchUrl, undefined)
  await service.stop()
})

test('a replaced bundle never starts DSH again and says why', async t => {
  let resolved = false
  const { service } = await setup(t, '', {
    ensureCurrent: async () => { throw new Error('Fig 0.1.60 is installed') },
    resolveCommand: async () => { resolved = true; throw new Error('unreachable') }
  })
  await service.start()
  assert.equal(service.state.phase, 'failed')
  assert.match(service.state.error!, /0\.1\.60 is installed/)
  assert.equal(resolved, false)
})

test('timeout cleans up the process tree; a retry can start a new service', async t => {
  let attempt = 0
  const folder = await tempDir(t, 'retry-', scratch)
  const service = new DshService({
    homeDirectory: folder, workingDirectory: folder, startupTimeoutMs: 350, stopTimeoutMs: 200,
    resolveCommand: async () => ({ executable: process.execPath, args: [fixture], env: { ...process.env, FIG_FIXTURE_MODE: attempt++ === 0 ? 'hang' : '' } })
  })
  try {
    await service.start()
    assert.equal(service.state.phase, 'failed')
    assert.match(service.state.error!, /超时/)
    await service.retry()
    assert.equal(service.state.phase, 'ready')
  } finally { await service.stop() }
})

test('quit during environment discovery never launches a child later', async t => {
  const { service } = await setup(t, '', { resolveCommand: async () => { await delay(100); return { executable: process.execPath, args: [fixture], env: process.env } } })
  const starting = service.start()
  await service.stop()
  await starting
  assert.equal(service.state.phase, 'idle')
  assert.equal(service.state.pid, undefined)
})

test('stopping a stubborn descendant is bounded and leaves unrelated processes alone', async t => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  const { service, record } = await setup(t, 'stubborn')
  try {
    await service.start()
    const data = JSON.parse(await readFile(record, 'utf8'))
    await service.stop()
    await waitFor(() => !alive(data.pid) && !alive(data.workerPid))
    assert.ok(alive(unrelated.pid!))
  } finally {
    await service.stop()
    await stopProcessGroup(unrelated.pid!, 200)
  }
})

test('a service crash is reported and its remaining descendants are reaped', async t => {
  const { service, record } = await setup(t)
  try {
    await service.start()
    const data = JSON.parse(await readFile(record, 'utf8'))
    await fetch(`http://127.0.0.1:${data.port}/crash`)
    await waitFor(() => service.state.phase === 'failed')
    await waitFor(() => !alive(data.pid) && !alive(data.workerPid))
    assert.equal(service.launchUrl, undefined)
  } finally { await service.stop() }
})


test('quit tolerates a transient macOS EPERM as the owned group disappears', async () => {
  const original = process.kill
  const target = -987654321
  let stopped = false
  let transient = 0
  let escalated = false
  process.kill = ((pid, signal) => {
    if (pid !== target) return original(pid, signal)
    if (signal === 'SIGTERM') { stopped = true; return true }
    if (signal === 'SIGKILL') { escalated = true; return true }
    if (!stopped) return true
    if (transient++ < 2) throw Object.assign(new Error('group is disappearing'), { code: 'EPERM' })
    throw Object.assign(new Error('group exited'), { code: 'ESRCH' })
  }) as typeof process.kill
  try { await stopProcessGroup(-target, 200); assert.equal(escalated, false) }
  finally { process.kill = original }
})

test('persistent process-group permission failures still prevent a successful quit', async () => {
  const original = process.kill
  const target = -987654321
  process.kill = ((pid, signal) => {
    if (pid !== target) return original(pid, signal)
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
  }) as typeof process.kill
  try { await assert.rejects(stopProcessGroup(-target, 200), { code: 'EPERM' }) }
  finally { process.kill = original }
})
