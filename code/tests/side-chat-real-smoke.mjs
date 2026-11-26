import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { cleanUp, isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'

// 侧边聊天 on a real DeepSeek account: the side chat is read-only, reads the main Session's live progress through
// main_session_status, and a reply the user picks reaches the main Session. Credentials are an isolated copy with
// only the DeepSeek records.
if (!process.argv.includes('--real')) throw new Error('Pass --real: calls the real DeepSeek model with an isolated credential copy.')
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/side-chat/', import.meta.url))
await mkdir(evidence, { recursive: true })
const stored = parse(await readFile(join(homedir(), '.fig/.credentials.yaml'), 'utf8'))
for (const key of Object.keys(stored.records ?? {})) if (!key.startsWith('deepseek-account')) delete stored.records[key]
const { profile, dshHome, env } = await isolatedProfile('sidechat-real')
delete env.DEEPSEEK_API_KEY; delete env.DEEPSEEK_BASE_URL
await writeFile(join(dshHome, '.credentials.yaml'), JSON.stringify(stored), { mode: 0o600 })
let app, passed = false
const result = {}
try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  page.on('console', m => { if (m.type() === 'error' || /fig/i.test(m.text())) (result.console ??= []).push(m.text().slice(0, 500)) })
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30000 }).catch(() => {})
  const editor = page.locator('[data-lexical-editor="true"]').first(); await editor.waitFor({ timeout: 30000 })
  await editor.click()
  await page.keyboard.type('Authorized test. Use the todo tool to record exactly three todo items: alpha, beta, gamma. Then reply MAIN-READY and stop.')
  await page.keyboard.press('Enter')
  await page.getByText('MAIN-READY').first().waitFor({ timeout: 180000 })
  await page.waitForTimeout(1500)

  await editor.click()
  await page.keyboard.press('Alt+Meta+KeyS')
  const side = page.locator('[data-fig-side-chat]')
  await side.waitFor({ timeout: 30000 })
  result.permission = await side.locator('button[aria-label^="访问模式"]').first().getAttribute('aria-label')
  assert.match(result.permission, /仅可查看/, 'The side chat is read-only')
  assert.equal(await side.getByText('MAIN-READY', { exact: true }).count(), 0, 'The side chat opens with its own transcript')
  const sideEditor = side.locator('[data-lexical-editor="true"]').first()
  await sideEditor.click()
  await page.keyboard.type('Call main_session_status once. Then reply with exactly three lines and nothing else. Line 1: SIDE-NOTE-77 followed by the number of todo items the main session has. Line 2: 给主会话： Line 3: MAIN-TODO-OK')
  await page.keyboard.press('Enter')
  const reply = side.getByText(/^SIDE-NOTE-77\D{0,12}\d+/).last()
  assert.match(await side.locator('[data-fig-side-chat-status]').innerText(), /^主会话：/)
  await reply.waitFor({ timeout: 180000 })
  result.sideReply = (await reply.innerText()).trim()
  assert.match(result.sideReply, /SIDE-NOTE-77\D{0,12}3\b/, 'The side chat read the main todo list')
  await page.waitForTimeout(1500)
  await side.locator('[data-fig-send-main]').last().click()
  // The box starts with only the part after 给主会话：; the user could edit it before sending.
  const box = page.locator('[data-fig-send-box] textarea').last()
  await box.waitFor({ timeout: 20000 })
  result.draft = await box.inputValue()
  assert.equal(result.draft.trim(), 'MAIN-TODO-OK')
  await page.screenshot({ path: join(evidence, 'real-send-box.png') })
  await page.locator('[data-fig-send-confirm]').last().click()
  await side.getByText('已发到主会话').last().waitFor({ timeout: 20000 })
  // The main Session gets the reply as a user message marked as coming from the side chat.
  const main = page.locator('[data-slot="main.conversation"]')
  await main.getByText(/来自侧边聊天/).first().waitFor({ timeout: 30000 })
  assert.equal(await main.getByText('SIDE-NOTE-77').count(), 0, 'Only the part for the main Session was sent')
  await main.getByText('MAIN-TODO-OK').first().waitFor()
  result.mainReceived = true
  await page.screenshot({ path: join(evidence, 'real.png') })
  passed = true
} catch (error) {
  await app?.windows().at(-1)?.screenshot({ path: join(evidence, 'real-failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(evidence, 'real-result.json'), JSON.stringify(result, null, 2))
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
console.log('PASS: side chat real', JSON.stringify(result))
