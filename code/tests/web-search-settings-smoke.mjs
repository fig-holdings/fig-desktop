// Isolated Fig + rc.5: drive the actual mode picker and credential form, then restart
// the same test Profile. No vendor credentials or external search requests.
// --bundle=<path to Fig Desktop.app> tests its exact packaged payload in the isolated dev host.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { isolatedDevEnvironment } from '../scripts/dev-isolation.mjs'
import { cleanUp, closeFig, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'
import { openWorkbench } from './helpers/fig-smoke.mjs'

const bundle = process.argv.find(arg => arg.startsWith('--bundle='))?.slice(9)
const appPath = bundle && resolve(bundle, 'Contents/Resources/app')
const { profile, dshHome, env, documents, workspace } = await isolatedProfile('search-settings', { base: isolatedDevEnvironment() })
delete env.BRAVE_SEARCH_API_KEY
delete env.DSH_WEB_SEARCH_PROVIDER
await mkdir(env.GROK_HOME)
await writeFile(env.GROK_AUTH_PATH, JSON.stringify({ 'https://auth.x.ai::00000000-0000-0000-0000-000000000001': {
  auth_mode: 'oidc', key: 'fig-synthetic-grok-access-token', expires_at: new Date(Date.now() + 3600000).toISOString() } }))
await writeFile(join(env.GROK_HOME, 'version.json'), '{"version":"1.2.3"}')
await writeFile(join(dshHome, '.credentials.yaml'), JSON.stringify({ version: 1, records: {
  'fig-chatgpt/subscription': { kind: 'grant', payload: { type: 'oauth', clientId: 'test', refresh: 'test', access: 'fig-synthetic-chatgpt-token', expires: Date.now() + 3600000 } }
} }), { mode: 0o600 })
env.FIG_SEARCH_TEST_KEY = 'fig-synthetic-personal-key'
await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: documents } },
  { id: 'llm-pi-ai', config: { providers: { personal: { api: 'openai-responses', baseURL: 'https://custom.example/v1',
    apiKeyEnv: 'FIG_SEARCH_TEST_KEY', models: [{ id: 'personal-model' }] } } } },
  { insert: ['web-search-vendors', 'harness-probe'].map(id => ({ id, name: fileURLToPath(new URL('./fixtures/' + id + '.mjs', import.meta.url)) })) }
]))

async function toolSearch(page, route, host) {
  const rpc = async (endpoint, payload) => {
    const result = await page.evaluate(async ({ endpoint, payload }) => (await fetch('/harness-probe/' + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    })).json(), { endpoint, payload })
    assert.ok(result.ok, result.error?.message)
    return result.value
  }
  const agent = await rpc('create', { route, cwd: workspace })
  const result = await rpc('call', { id: agent.id, requestContext: route, name: 'web_search', args: { queries: ['Electron'] } })
  assert.equal(result.results[0].result.value?.sources[0]?.title, host, JSON.stringify(result))
  await rpc('close', {})
}
let app, passed = false
async function openSettings(restart = false) {
  app = await launchFig(env, { appPath })
  const page = restart ? await workbenchPage(app) : await openWorkbench(app)
  await page.locator('[data-lexical-editor="true"]').first().waitFor()
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('button', { name: '联网搜索', exact: true }).click()
  const mode = page.getByRole('combobox', { name: '搜索方式' })
  await mode.waitFor()
  return { page, mode }
}
try {
  let { page, mode } = await openSettings()
  assert.equal(await mode.inputValue(), 'fig-follow-model')
  for (const [provider, model, host] of [
    ['deepseek-official', 'deepseek-flash', '127.0.0.1'], ['fig-grok-oauth', 'grok-4.7', 'cli-chat-proxy.grok.com'],
    ['fig-chatgpt', 'gpt-6.1-sol', 'api.openai.com'], ['personal', 'personal-model', 'custom.example']
  ]) await toolSearch(page, { provider, model }, host)
  await mode.selectOption('fig-brave-search')
  await page.getByLabel('Brave Search API Key', { exact: true }).fill('fig-synthetic-brave-key')
  await page.getByRole('button', { name: '保存密钥' }).click()
  await page.getByText('已配置', { exact: true }).waitFor()
  assert.doesNotMatch(await readFile(join(dshHome, 'profiles/web/cordis.patch.yml'), 'utf8'), /fig-synthetic-brave-key/)
  await toolSearch(page, { provider: 'deepseek-official', model: 'deepseek-flash' }, 'api.search.brave.com')
  await closeFig(app)
  app = undefined
  ;({ page, mode } = await openSettings(true))
  assert.equal(await mode.inputValue(), 'fig-brave-search')
  await page.getByRole('button', { name: '移除已保存的密钥' }).click()
  await page.getByText('尚未配置', { exact: true }).waitFor()
  await mode.selectOption('fig-follow-model')
  await page.getByLabel('Brave Search API Key', { exact: true }).waitFor({ state: 'detached' })
  assert.equal(await mode.inputValue(), 'fig-follow-model')
  passed = true
  console.log('PASS: default, independent mode, secret storage, restart, key removal and follow-model selection')
} finally {
  if (app) await closeFig(app)
  await cleanUp(profile, passed)
}
