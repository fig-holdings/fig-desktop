import assert from 'node:assert/strict'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse } from 'yaml'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'

// Exercise DSH's real registry/executor/sandbox in both Fig modes, without calling a model.
// --evidence=<dir> keeps a run's record apart from earlier ones.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11) ?? fileURLToPath(new URL('../../work/verification/harness-audit/', import.meta.url))
await mkdir(evidence, { recursive: true })
const state = await isolatedProfile('harness-caps')
const realWeb = process.argv.includes('--web-real')
if (realWeb) {
  const credentials = parse(await readFile(join(homedir(), '.fig/.credentials.yaml'), 'utf8'))
  credentials.records = Object.fromEntries(Object.entries(credentials.records ?? {}).filter(([name]) => /deepseek/i.test(name)))
  await writeFile(join(state.dshHome, '.credentials.yaml'), JSON.stringify(credentials), { mode: 0o600 })
  delete state.env.DEEPSEEK_API_KEY
  delete state.env.DEEPSEEK_BASE_URL
}
const fixture = fileURLToPath(new URL('./fixtures/harness-probe.mjs', import.meta.url))
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: state.documents } },
  { insert: [{ id: 'harness-probe', name: fixture }, {
    id: 'audit-mcp', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'audit', transport: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcp-probe.mjs', import.meta.url))], failOnStartupError: true
    }
  }] }
]))
await mkdir(state.workspace, { recursive: true })
await writeFile(join(state.workspace, 'input.txt'), 'HARNESS-READ-OK\n')
await writeFile(join(state.profile, 'outside.txt'), 'OUTSIDE-READ-OK\n')
await mkdir(join(state.workspace, '.agents/skills/audit-probe'), { recursive: true })
await writeFile(join(state.workspace, '.agents/skills/audit-probe/SKILL.md'), '---\nname: audit-probe\ndescription: Test-only harness probe\n---\nSKILL-CONTENT-OK\n')
let app, passed = false
const site = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>HARNESS-BROWSER-OK</h1>') })
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
const results = {}
// System temp can be a separately writable sandbox root; use a task-owned path outside it.
const deniedPath = join(evidence, 'outside-denied-' + process.pid + '.txt')
try {
  app = await launchFig(state.env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30_000 })
  async function rpc(endpoint, payload = {}) {
    const result = await page.evaluate(async ({ endpoint, payload }) => (await fetch('/harness-probe/' + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    })).json(), { endpoint, payload })
    assert.ok(result.ok, result.error?.message)
    return result.value
  }
  for (const preset of ['standard', 'cordis']) {
    const agent = await rpc('create', { preset, cwd: state.workspace })
    results[preset] = agent.tools
    const names = agent.tools.map(tool => tool.name)
    for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'web_search', 'web_fetch',
      'subagent', 'subagent_fork', 'send_message', 'todo_write', 'schedule_create', 'schedule_list', 'job_list',
      'preview', 'delegate_agent', 'handoff_session']) assert.ok(names.includes(name), `${preset}: missing ${name}`)
    console.log('PASS:', preset, 'tool catalog:', names.join(', '))
    results[preset + '-read'] = await rpc('call', { id: agent.id, name: 'read', args: { file_path: 'input.txt' } })
    assert.match(JSON.stringify(results[preset + '-read']), /HARNESS-READ-OK/)
    results[preset + '-write'] = await rpc('call', { id: agent.id, name: 'write', args: { file_path: 'output.txt', content: 'HARNESS-WRITE-OK' } })
    assert.doesNotMatch(JSON.stringify(results[preset + '-write']), /"isError":true/)
    results[preset + '-deny'] = await rpc('call', { id: agent.id, permission: 'read-only', name: 'write', args: { file_path: 'denied.txt', content: 'FORBIDDEN' } })
    assert.match(JSON.stringify(results[preset + '-deny']), /denied|read.only|not.*allow|permission/i)
    results[preset + '-jobs'] = await rpc('call', { id: agent.id, name: 'job_list' })
    results[preset + '-schedules'] = await rpc('call', { id: agent.id, name: 'schedule_list' })
    await assert.rejects(access(join(state.workspace, 'denied.txt')))
    const call = async (name, args = {}) => {
      const result = await rpc('call', { id: agent.id, name, args, permission: 'workspace-write' })
      results[preset + '-' + name] = result
      assert.equal(result.results[0].result.isError, false, JSON.stringify(result))
      return result.results[0].result.value
    }
    await call('edit', { file_path: 'output.txt', old_string: 'HARNESS-WRITE-OK', new_string: 'HARNESS-EDIT-OK' })
    assert.equal(await readFile(join(state.workspace, 'output.txt'), 'utf8'), 'HARNESS-EDIT-OK')
    await call('glob', { pattern: '*.txt' })
    await call('grep', { pattern: 'HARNESS', path: '.' })
    await call('skill', { name: 'audit-probe' })
    const mcp = await call('mcp__audit__echo')
    assert.match(JSON.stringify(mcp), /HARNESS-MCP-OK/)
    await call('list_mcp_resources', { server: 'audit' })
    await call('list_mcp_resource_templates', { server: 'audit' })
    const resource = await call('read_mcp_resource', { server: 'audit', uri: 'audit://probe' })
    assert.match(JSON.stringify(resource), /HARNESS-RESOURCE-OK/)
    const outside = await call('read', { file_path: join(state.profile, 'outside.txt') })
    assert.match(JSON.stringify(outside), /OUTSIDE-READ-OK/)
    const denied = await rpc('call', { id: agent.id, name: 'write', permission: 'workspace-write', args: {
      file_path: deniedPath, content: 'FORBIDDEN'
    } })
    assert.equal(denied.results[0].result.isError, true, 'Workspace write must not escape its write root')
    await assert.rejects(access(deniedPath))
    await call('bash', { command: 'printf HARNESS-SHELL-OK', description: 'Check isolated harness shell output' })
    const background = await call('bash', { command: 'sleep 30', description: 'Start a cancellable test background job', run_in_background: true })
    assert.ok(background.jobId)
    await call('job_list')
    await call('job_output', { job_id: background.jobId })
    await call('job_kill', { job_id: background.jobId })
    await call('todo_write', { todos: [{ content: 'Probe complete', status: 'completed' }] })
    const workflow = await call('workflow', { meta: { name: 'harness-probe', description: 'Run a deterministic orchestration probe' },
      script: 'return { marker: "WORKFLOW-OK" }' })
    assert.match(JSON.stringify(workflow), /WORKFLOW-OK/)
    const schedule = await call('schedule_create', { title: 'Harness audit probe', prompt: 'Do not run: test task deleted immediately',
      rrule: 'DTSTART:20991107T120000Z\nRRULE:FREQ=DAILY;COUNT=1', target: 'this_session' })
    results[preset + '-schedule-created'] = schedule
    await call('schedule_list')
    // Schedule result carries the authoritative id (rather than guessing a persistent storage path).
    await call('schedule_edit', { id: schedule.id ?? schedule.task?.id, action: 'delete' })
    if (realWeb && preset === 'standard') {
      await call('web_search', { queries: ['DeepSeek Harness official open source GitHub'] })
      await call('web_fetch', { url: 'https://example.com' })
      console.log('PASS: native web search with a DeepSeek account and external page fetch')
    }
    console.log('PASS:', preset, 'read/write/edit, glob/grep, skill, shell, MCP, read-only denial, todo, jobs, schedule create/list/delete')
  }
  await rpc('close')
  await writeFile(join(evidence, 'capabilities.json'), JSON.stringify(results, null, 2))
  await page.screenshot({ path: join(evidence, 'workbench.png') })
  const editor = page.locator('[contenteditable="true"]').first()
  await editor.fill('Harness browser probe')
  await editor.press('Enter')
  await page.getByText('Harness browser probe', { exact: true }).first().waitFor()
  await page.keyboard.press('Meta+Alt+t')
  const address = page.getByRole('textbox', { name: /网址|地址|URL|address/i }).first()
  await address.waitFor({ timeout: 15_000 })
  await address.fill('http://127.0.0.1:' + site.address().port)
  await address.press('Enter')
  await page.frameLocator('iframe[data-sidebar-browser-frame]').getByRole('heading', { name: 'HARNESS-BROWSER-OK' }).waitFor()
  await page.screenshot({ path: join(evidence, 'browser.png') })
  console.log('PASS: official Browser entry is reachable inside Fig')
  passed = true
} finally {
  await app?.close()
  await rm(deniedPath, { force: true })
  await new Promise(resolve => site.close(resolve))
  if (realWeb) await import('node:fs/promises').then(fs => fs.rm(join(state.dshHome, '.credentials.yaml'), { force: true }))
  await cleanUp(state.profile, passed)
}
