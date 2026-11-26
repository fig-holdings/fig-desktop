import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'

// The ChatGPT subscription plugin loads on the verified DSH: its settings section shows the signed-out
// state, the sign-in endpoint returns an OpenAI authorize URL with Fig's installation id, and the
// attempt is cancelled. Nothing is opened in a browser and no account signs in.
const evidence = fileURLToPath(new URL('../../work/verification/chatgpt/', import.meta.url))
await mkdir(evidence, { recursive: true })
const { profile, dshHome, env } = await isolatedProfile('chatgpt')
let app, passed = false
try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30000 })
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 30000 })
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('button', { name: 'ChatGPT 账号', exact: true }).click({ timeout: 15000 })
  await page.getByText('未登录 ChatGPT', { exact: true }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: '登录 ChatGPT' }).and(page.locator(':enabled')).waitFor()
  await page.screenshot({ path: join(evidence, 'signed-out.png'), animations: 'disabled' })

  const post = endpoint => page.evaluate(async path => (await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}'
  })).json(), '/fig-chatgpt/' + endpoint)
  const login = await post('login')
  assert.ok(login.ok, JSON.stringify(login))
  const url = new URL(login.value.url)
  const host = JSON.parse(await readFile(join(dshHome, 'fig', 'chatgpt-host.json'), 'utf8')).id
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize')
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:' + host)
  assert.equal(url.searchParams.get('agent_name_hint'), 'Fig Desktop')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback')
  assert.match(url.searchParams.get('scope') ?? '', /chatgpt\.tokens\.use\.direct/)
  assert.equal((await post('account')).value.signedIn, false)
  assert.equal((await post('account')).value.signingIn, true)
  assert.ok((await post('cancel')).ok)
  await page.waitForTimeout(300)
  assert.equal((await post('account')).value.signingIn, false)

  const forbidden = await page.evaluate(async () => (await fetch('/fig-chatgpt/account', {
    method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: '{}'
  })).status)
  assert.ok([401, 403].includes(forbidden), 'The route must reject a request without the DSH browser session')
  console.log('PASS: ChatGPT account section, sign-in URL with installation id, cancel, route fence')
  passed = true
} finally {
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
