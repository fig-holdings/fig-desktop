import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { cleanUp, isolatedProfile, realCliHomes, launchFig, workbenchPage, until } from '../scripts/isolated-fig.mjs'
import { sessionEvents } from './helpers/session-events.mjs'

if (!process.argv.includes('--real')) throw new Error('Pass --real: one short ChatGPT child request with synthetic instructions.')
// --evidence=<dir> keeps a run's record apart from earlier ones.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11) ?? fileURLToPath(new URL('../../work/verification/harness-audit/', import.meta.url))
await mkdir(evidence, { recursive: true })
const state = await isolatedProfile('handoff-ui', { extraEnv: realCliHomes })
const credential = join(state.dshHome, '.credentials.yaml')
const stored = parse(await readFile(join(homedir(), '.fig/.credentials.yaml'), 'utf8'))
const grant = stored.records['fig-chatgpt/subscription']
const provider = process.argv.find(arg => arg.startsWith('--provider='))?.slice(11) ?? 'chatgpt'
const routes = {
  chatgpt: { provider: 'fig-chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'low' },
  grok: { provider: 'fig-grok-oauth', model: 'grok-4.7', reasoningEffort: 'low' },
  deepseek: { provider: 'deepseek-account', model: 'deepseek-flash' }
}
assert.ok(routes[provider], 'Unknown --provider')
if (provider === 'deepseek') {
  // The shared catalog-only fixture targets loopback, which deliberately cannot accept account auth.
  delete state.env.DEEPSEEK_API_KEY
  delete state.env.DEEPSEEK_BASE_URL
}
const records = provider === 'chatgpt' ? { 'fig-chatgpt/subscription': { ...grant, payload: { ...grant.payload, refresh: 'isolated-no-refresh' } } }
  : provider === 'deepseek' ? Object.fromEntries(Object.entries(stored.records).filter(([id]) => /deepseek/i.test(id))) : {}
await writeFile(credential, JSON.stringify({ version: 1, records }), { mode: 0o600 })
await mkdir(join(state.profile, 'agents'))
state.env.DSH_AGENTS_HOME = join(state.profile, 'agents')
await mkdir(join(state.workspace, '.git'), { recursive: true })
await writeFile(join(state.workspace, 'AGENTS.md'), 'Synthetic test. Reply only as requested. Do not read any files.\n')
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: state.documents } },
  { insert: [{ id: 'harness-probe', name: fileURLToPath(new URL('./fixtures/harness-probe.mjs', import.meta.url)) }] }
]))
let app, passed = false
try {
  app = await launchFig(state.env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  async function rpc(endpoint, payload) {
    const result = await page.evaluate(async ({ endpoint, payload }) => (await fetch('/harness-probe/' + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    })).json(), { endpoint, payload })
    assert.ok(result.ok, result.error?.message)
    return result.value
  }
  const agent = await rpc('create', { cwd: state.workspace, route: routes[provider], preset: provider === 'grok' ? 'cordis' : 'standard' })
  const result = await rpc('call', { id: agent.id, name: 'handoff_session', permission: 'workspace-write',
    args: { title: 'UI handoff probe', prompt: 'Reply with exactly UI-HANDOFF-OK. Do not call any tools.' } })
  const value = result.results[0].result.value
  assert.ok(value?.sessionId && value.workspaceId, JSON.stringify(result))
  assert.equal(value.lifecycle, 'fig')
  const child = await rpc('inspect', { id: value.sessionId })
  assert.equal(child.route.provider, routes[provider].provider)
  assert.equal(child.route.model, routes[provider].model)
  // It must be accounted in the live Web registry, not just found after an application restart.
  await page.getByText('UI handoff probe', { exact: true }).first().waitFor({ timeout: 30_000 }).catch(async error => {
    await writeFile(join(evidence, 'handoff-ui-failure.txt'), await page.locator('body').innerText())
    await page.screenshot({ path: join(evidence, 'handoff-ui-failure.png') })
    throw error
  })
  await page.screenshot({ path: join(evidence, 'handoff-sidebar.png') })
  await until(async () => (await sessionEvents(join(state.dshHome, 'sessions'))).some(event => event.type === 'turn/end'),
    { timeout: 90_000, interval: 500, message: 'The managed child must finish before cleanup' })
  await page.getByText('UI handoff probe', { exact: true }).first().click()
  await page.getByText('UI-HANDOFF-OK', { exact: true }).first().waitFor({ timeout: 30_000 })
  const editor = page.locator('[contenteditable="true"]').last()
  await editor.fill('Reply with exactly UI-RESUME-OK. Do not call any tools.')
  await editor.press('Enter')
  await page.getByText('UI-RESUME-OK', { exact: true }).first().waitFor({ timeout: 90_000 })
  await writeFile(join(evidence, 'handoff-ui-' + provider + '-result.json'), JSON.stringify({ provider, sessionId: value.sessionId, workspaceId: value.workspaceId, liveSidebar: true, continued: true }))
  console.log('PASS:', provider, 'handoff appears by title without restarting; opens and continues through the normal Fig composer')
  passed = true
} finally {
  await app?.close()
  await rm(credential, { force: true })
  await cleanUp(state.profile, passed)
}
