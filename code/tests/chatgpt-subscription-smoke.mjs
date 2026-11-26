import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanUp, isolatedProfile, realCliHomes, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'
import { grantPayload } from './helpers/chatgpt-grant.mjs'
import { sessionEvents } from './helpers/session-events.mjs'

// Real ChatGPT subscription requests from an isolated Fig: one short reply and one local tool round
// trip. The access token comes from the ChatGPT sign-in in the user's Fig (DSH_HOME, default ~/.fig);
// the isolated copy gets a dummy refresh token, so it can never rotate the user's grant, and the copy
// is deleted afterwards whatever the outcome. Uses ChatGPT plan usage.

if (!process.argv.includes('--real')) throw new Error('Pass --real to run with the ChatGPT sign-in in your Fig.')

const userHome = process.env.FIG_CHATGPT_DSH_HOME ?? join(homedir(), '.fig')
const payload = grantPayload(await readFile(join(userHome, '.credentials.yaml'), 'utf8'))
assert.equal(payload.type, 'oauth')
if (!(payload.expires > Date.now() + 10 * 60_000)) throw new Error('The ChatGPT access token expires within 10 minutes; open Fig once so it refreshes, then rerun.')

const probe = 'FIG-PROBE-' + randomUUID().slice(0, 8)
const { profile, dshHome, workspace, env } = await isolatedProfile('chatgpt-subscription', { extraEnv: realCliHomes })
const credentialsPath = join(dshHome, '.credentials.yaml')
let app
let passed = false
try {
  // YAML accepts JSON; the dummy refresh token keeps the isolated copy from rotating the user's grant.
  await writeFile(credentialsPath, JSON.stringify({ version: 1, records: {
    'fig-chatgpt/subscription': { kind: 'grant', payload: { ...payload, refresh: 'fig-smoke-no-refresh' } }
  } }), { mode: 0o600 })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'chatgpt-probe.txt'), probe + '\n')

  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: /^选择模型/ }).first().click({ timeout: 30_000 })
  await page.getByRole('menuitem', { name: /^模型|^Model/i }).first().click()
  await page.getByText('ChatGPT 订阅', { exact: true }).first().waitFor({ timeout: 30_000 })
  const listed = await page.getByRole('menuitemradio').allInnerTexts()
  console.log('Model menu:', JSON.stringify(listed.map(text => text.split('\n')[0])))
  const model = process.env.FIG_CHATGPT_SMOKE_MODEL ?? 'gpt-6.1-sol'
  await page.getByRole('menuitemradio', { name: new RegExp(model.replace(/[.-]/g, '[ .-]'), 'i') }).first().click()
  console.log('PASS: the ChatGPT 订阅 group lists the account models; selected', model)

  const editor = page.locator('[contenteditable="true"]').last()
  const failurePage = async () => {
    console.error('Page text tail:', (await page.locator('body').innerText().catch(() => '')).slice(-1500))
    await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => undefined)
  }
  await editor.fill('Reply with exactly GPT-OK-122 and nothing else. Do not use tools.')
  await editor.press('Enter')
  try { await page.locator('p').filter({ hasText: /^GPT-OK-122$/ }).waitFor({ timeout: 120_000 }) } catch (error) { await failurePage(); throw error }
  console.log('PASS: a short reply streams from the ChatGPT subscription')

  await editor.fill('Read the file chatgpt-probe.txt in the current workspace with your file reading tool, then reply with only its contents.')
  await editor.press('Enter')
  try { await page.locator('p').filter({ hasText: new RegExp('^' + probe + '$') }).waitFor({ timeout: 180_000 }) } catch (error) { await failurePage(); throw error }
  console.log('PASS: a local tool round trip returns the file contents')

  const events = await sessionEvents(join(dshHome, 'sessions'))
  const types = {}
  for (const event of events) types[event.type] = (types[event.type] ?? 0) + 1
  console.log('Session event types:', JSON.stringify(types))
  const routes = new Set(events.filter(event => event.data?.provider).map(event => event.data.provider + '/' + event.data.model))
  console.log('Routes in the session:', JSON.stringify([...routes]))
  assert.ok([...routes].some(route => route.startsWith('fig-chatgpt/')), 'the session must run on fig-chatgpt')
  assert.ok(Object.keys(types).some(type => /tool/i.test(type)), 'the second turn must call a tool')
  passed = true
} finally {
  await app?.close()
  await rm(credentialsPath, { force: true })
  await cleanUp(profile, passed)
}
