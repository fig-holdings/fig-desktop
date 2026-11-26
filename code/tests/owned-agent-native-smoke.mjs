import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Explicit fixed-release package tree; no download, model call, credentials or daily DSH state.
const modules = process.argv.find(arg => arg.startsWith('--modules='))?.slice(10)
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
assert.ok(modules && evidence, 'Require --modules=<fixed DSH node_modules> --evidence=<new directory>')
await mkdir(evidence, { recursive: false })
const report = { startedAt: new Date().toISOString(), status: 'fail', cases: [] }
const cwd = await mkdtemp(join(tmpdir(), 'fig-owned-native-'))
try {
  const { apply } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-tool-call-timeout-policy/lib/index.js')))
  const { runOwnedAgent } = await import('../../work/build/main/shared/owned-agent.js')
  let wrapper
  apply({ tools: { get: () => ({ timeoutMs: 400 }) }, on: (event, fn) => { assert.equal(event, 'tools/execute'); wrapper = fn } })
  const exec = { name: 'delegate_agent', signal: new AbortController().signal, agent: {} }
  const upstream = exec.signal
  const started = performance.now()
  const record = join(cwd, 'pids.json')
  const result = await wrapper(exec, async () => {
    try {
      await runOwnedAgent({ file: process.execPath, args: [fileURLToPath(new URL('./fixtures/owned-agent.mjs', import.meta.url)), 'stubborn', record], cwd, input: '', signal: exec.signal })
      assert.fail('timeout must abort the CLI')
    } catch (error) { return { isError: true, error: { message: error.message } } }
  })
  assert.equal(result.error.info.code, 'TOOL_TIMEOUT')
  assert.equal(exec.signal, upstream)
  const elapsedMs = performance.now() - started
  assert.ok(elapsedMs >= 2300, 'DSH must await the cleanup grace period')
  const pids = JSON.parse(await readFile(record, 'utf8'))
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  report.cases.push({ id: 'native-timeout-awaits-built-supervisor-cleanup', status: 'pass', elapsedMs, pids })
  report.status = 'pass'
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  await rm(cwd, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString()
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(report.status + ': native timeout / built supervisor')
}
