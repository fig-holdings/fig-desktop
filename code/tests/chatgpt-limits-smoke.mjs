import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, realCliHomes, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'
import { grantPayload } from './helpers/chatgpt-grant.mjs'

// The ChatGPT 账号 section shows the plan's usage limits from the local Codex sign-in: at once from
// Codex's session records, then from a live read naming the Codex account. The
// ChatGPT sign-in is copied from the user's Fig with a dummy refresh token (as in
// chatgpt-subscription-smoke) and deleted afterwards. No model request is sent.

if (!process.argv.includes('--real')) throw new Error('Pass --real to use the ChatGPT sign-in in your Fig and the local Codex.')
const evidence = fileURLToPath(new URL('../../work/verification/chatgpt/', import.meta.url))
await mkdir(evidence, { recursive: true })
const userHome = process.env.FIG_CHATGPT_DSH_HOME ?? join(homedir(), '.fig')
const payload = grantPayload(await readFile(join(userHome, '.credentials.yaml'), 'utf8'))

const { profile, dshHome, env } = await isolatedProfile('chatgpt-limits', { extraEnv: realCliHomes })
const credentialsPath = join(dshHome, '.credentials.yaml')
let app
let passed = false
try {
  await writeFile(credentialsPath, JSON.stringify({ version: 1, records: {
    'fig-chatgpt/subscription': { kind: 'grant', payload: { ...payload, refresh: 'fig-smoke-no-refresh' } }
  } }), { mode: 0o600 })
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 30_000 })
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
  await page.getByRole('button', { name: 'ChatGPT 账号', exact: true }).click({ timeout: 15_000 })
  await page.getByText('已登录 ChatGPT', { exact: true }).waitFor({ timeout: 15_000 })
  // Shown at once from the limits at hand (Codex's session files), then replaced by the live read.
  const started = Date.now()
  await page.getByText('每周额度', { exact: true }).waitFor({ timeout: 10_000 })
  const shownIn = Date.now() - started
  const section = () => page.locator('[data-shortcut-modal="settings"]').innerText()
  const first = await section()
  console.log('Weekly limit shown in', shownIn, 'ms, from', /来自 Codex 会话记录/.test(first) ? 'the session records' : 'a live read')
  assert.ok(shownIn < 1500, 'the limit must not wait for Codex')
  await page.getByText(/^额度来源：Codex/).waitFor({ timeout: 30_000 })
  await page.getByText(/正在更新/).waitFor({ state: 'detached', timeout: 30_000 })
  console.log('Live read replaced it after', Date.now() - started, 'ms')
  const card = await section()
  assert.match(card, /\d+(\.\d)?%\s*已用/)
  assert.match(card, /重置于 /)
  assert.match(card, /额度来源：Codex；来源账号：[^；]+@[^；]+；可能不是当前模型登录账号/)
  console.log('Section:', card.slice(card.indexOf('套餐'), card.indexOf('查看用量')).replace(/[^\s|（]+@[^\s|）]+/g, '<email>').replace(/\n+/g, ' | '))
  await page.screenshot({ path: join(evidence, 'limits.png'), animations: 'disabled' })
  console.log('PASS: the ChatGPT section shows the weekly limit read from Codex')
  passed = true
} finally {
  await app?.close()
  await rm(credentialsPath, { force: true })
  await cleanUp(profile, passed)
}
