import assert from 'node:assert/strict'
import { copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'

if (!process.argv.includes('--real')) {
  throw new Error('Pass --real to run with the current Grok CLI login.')
}

const { profile, env } = await isolatedProfile('grok-reasoning', {
  extraEnv: profile => ({ GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: process.env.GROK_AUTH_PATH ?? join(homedir(), '.grok/auth.json') })
})
// Grok 订阅 sends the CLI version from GROK_HOME; the proxy refuses requests without it (HTTP 426).
await mkdir(join(profile, 'grok'))
await copyFile(join(homedir(), '.grok/version.json'), join(profile, 'grok/version.json'))

let app
let passed = false
const modelButton = page => page.getByRole('button', { name: /^选择模型/ }).first()
const stop = page => page.getByRole('button', { name: /^(停止生成|Stop generating)$/ }).first()
const assistantText = (page, text) => page.locator('p').filter({ hasText: new RegExp('^' + text + '$') })

async function send(page, prompt) {
  const editor = page.locator('[contenteditable="true"]').last()
  await editor.fill(prompt)
  await editor.press('Enter')
}

async function pickEffort(page, effort) {
  await modelButton(page).click({ timeout: 30_000 })
  await page.getByRole('menuitem', { name: /^推理等级/ }).first().click()
  const items = (await page.getByRole('menuitemradio').allInnerTexts()).map(text => text.trim())
  await page.getByRole('menuitemradio', { name: effort, exact: true }).first().click()
  await page.getByRole('button', { name: new RegExp('推理等级 ' + effort + '$') }).first().waitFor({ timeout: 15_000 })
  return items
}

try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: '标准模式', exact: true }).click()
  const presets = (await page.getByRole('menuitem').allInnerTexts()).map(text => text.split('\n')[0].trim())
  assert.deepEqual(presets, ['标准模式', '创造模式'])
  await page.keyboard.press('Escape')
  console.log('PASS: the mode menu hides PTC and minimal')

  await modelButton(page).click({ timeout: 30_000 })
  await page.getByRole('menuitem', { name: /^模型|^Model/i }).first().click()
  await page.getByText('Grok 订阅', { exact: true }).first().waitFor({ timeout: 30_000 })
  await page.getByRole('menuitemradio', { name: 'Grok 4.7', exact: true }).first().click()
  const subscription = await pickEffort(page, 'Low')
  assert.deepEqual(subscription, ['Low', 'Medium', 'High', 'Extra High'])
  await send(page, 'Reply with exactly SUB-LOW-671 and nothing else. Do not use tools.')
  await assistantText(page, 'SUB-LOW-671').waitFor({ timeout: 90_000 })
  await stop(page).waitFor({ state: 'hidden', timeout: 15_000 })
  console.log('PASS: Grok 订阅 lists Grok efforts and answers at Low')

  passed = true
} catch (error) {
  const text = await app?.context().pages().at(-1)?.locator('body').innerText().catch(() => '')
  if (text) console.error('Page text tail:', text.slice(-1500))
  throw error
} finally {
  await app?.close()
  await cleanUp(profile, passed)
}
