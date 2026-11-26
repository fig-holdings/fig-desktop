import assert from 'node:assert/strict'
import { join } from 'node:path'
import { cleanUp, isolatedProfile, realCliHomes, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'
import { sessionEvents } from './helpers/session-events.mjs'

if (!process.argv.includes('--real')) {
  throw new Error('Pass --real to run with the current Grok CLI login.')
}

const { profile, env } = await isolatedProfile('grok-subscription', {
  extraEnv: realCliHomes
})
const model = process.env.FIG_GROK_SMOKE_MODEL ?? 'Grok 4.7'

let app
let passed = false

try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: /^选择模型.*DeepSeek/i }).first().click({ timeout: 30_000 })
  await page.getByRole('menuitem', { name: /^模型|^Model/i }).first().click()
  await page.getByText(/^Grok (Subscription|订阅)$/).first().waitFor({ timeout: 30_000 })
  await page.getByRole('menuitemradio', { name: model, exact: true }).first().click()
  await page.getByRole('button', { name: new RegExp('^选择模型.*' + model.replace('.', '\\.')) }).first().waitFor()
  console.log('PASS: standard session lists the Grok Subscription group and selects', model)

  const editor = page.locator('[contenteditable="true"]').last()
  await editor.fill('Reply with exactly SUB-OK-671 and nothing else. Do not use tools.')
  await editor.press('Enter')
  try {
    await page.locator('p').filter({ hasText: /^SUB-OK-671$/ }).waitFor({ timeout: 90_000 })
  } catch (error) {
    const text = await page.locator('body').innerText().catch(() => '')
    console.error('Page text tail:', text.slice(-1500))
    await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => undefined)
    throw error
  }
  console.log('PASS: Grok Subscription streams a reply')
  const windows = (await sessionEvents(join(profile, 'dsh/sessions'))).filter(event => event.type === 'request/context').map(event => event.data.contextWindow)
  assert.ok(windows.length && windows.every(window => window === 500000), 'context window ' + windows)
  console.log('PASS: the session runs with the 500K window')
  passed = true
} finally {
  await app?.close()
  await cleanUp(profile, passed)
}
