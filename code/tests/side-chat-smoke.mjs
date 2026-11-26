import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'
import { isolatedDevEnvironment } from '../scripts/dev-isolation.mjs'

// A native sidebar chat with a deterministic offline adapter and an isolated workspace.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/side-chat/', import.meta.url))
await mkdir(evidence, { recursive: true })
const { profile, documents, dshHome, env } = await isolatedProfile('sidechat', {
  base: isolatedDevEnvironment(),
  extraEnv: root => ({ GROK_HOME: join(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok/auth.json'), CODEX_HOME: join(root, 'codex') })
})
const workspace = join(documents, 'side-project')
const cwd = join(workspace, 'subdir')
await mkdir(cwd, { recursive: true })
await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: documents } },
  { insert: ['handoff-probe', 'activity-probe'].map(id => ({
    id, name: fileURLToPath(new URL('./fixtures/' + id + '.mjs', import.meta.url))
  })) }
]))
let app, passed = false
let page
const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({ prefix, endpoint, payload }) =>
  (await fetch('/' + prefix + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload) })).json(), { prefix, endpoint, payload }).then(result => {
  assert.ok(result.ok, JSON.stringify(result.error))
  return result.value
})
const probe = (endpoint, payload) => rpc('handoff-probe', endpoint, payload)
const model = { provider: 'synthetic-activity', model: 'offline', reasoningEffort: 'high' }
async function mainMessage(id, text, response) {
  await rpc('activity-probe', 'configure', { text: response })
  await probe('followup', { id, text })
  await page.locator('[data-slot="main.conversation"]').getByText(response, { exact: true }).waitFor()
  await until(async () => !(await probe('state', { id })).running)
}
try {
  app = await launchFig(env)
  page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30000 }).catch(() => {})
  const { id: main, workspaceId } = await probe('parent', { workspacePath: workspace, cwd, preset: 'workspace-write', route: model, title: 'side probe' })
  await page.evaluate(id => window.__figAttentionNavigate({ sessionId: id, navigationId: 'side-chat-smoke', eventIdentity: 'synthetic' }), main)
  const mainEditor = page.locator('[data-slot="main.conversation"] [data-lexical-editor="true"]').first()
  await mainEditor.waitFor({ timeout: 30000 })
  await mainMessage(main, 'MAIN-QUESTION-1', 'MAIN-ANSWER-1')
  const sidebar = page.locator('[data-slot="sidebar"]').first()
  await page.locator('[data-slot="conversation.header"] button[aria-haspopup="menu"]').last().click()
  assert.equal(await page.getByRole('menuitem', { name: '侧边聊天' }).count(), 0, 'Not in the … menu')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '展开右侧栏', exact: true }).click()
  const card = page.getByRole('button', { name: /侧边聊天/ }).first()
  await card.waitFor({ timeout: 15000 })
  assert.match(await card.innerText(), /⌥\s*⌘\s*S/, 'The card shows the shortcut')
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(evidence, 'smoke-guide.png') })
  await card.click()
  const side = page.locator('[data-fig-side-chat]')
  await side.locator('[data-lexical-editor="true"]').first().waitFor({ timeout: 30000 })
  assert.match(await side.locator('button[aria-label^="访问模式"]').first().getAttribute('aria-label'), /仅可查看/, 'The side chat is read-only')
  assert.equal(await side.getByText(/MAIN-(QUESTION|ANSWER)-1/).count(), 0, 'The main transcript is not rendered in the side chat')
  assert.equal(await side.locator('[data-content-phase="hero"]').count(), 0, 'The sidebar starts with the compact composer')
  assert.match(await side.locator('[data-fig-side-chat-status]').innerText(), /^主会话：side probe · (运行中|空闲)$/)
  await page.screenshot({ path: join(evidence, 'smoke-open.png') })
  const child = await side.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')
  assert.ok(child && child !== main)
  const parent = await probe('inspect', { id: main })
  const inherited = await probe('inspect', { id: child })
  assert.deepEqual(inherited.route, model)
  assert.equal(inherited.agentPreset, parent.agentPreset)
  assert.ok(inherited.agentPreset, 'The main session mode is inherited')
  assert.equal(inherited.workspaceId, workspaceId)
  assert.equal(inherited.cwd, await realpath(cwd))
  assert.equal(inherited.preset, 'read-only')
  assert.ok(!inherited.messages.some(message => message.source === 'user' || message.role === 'assistant'))
  assert.equal(await sidebar.getByText('侧边聊天：side probe').count(), 0, 'An empty side chat does not add a workspace row')
  await mainMessage(main, 'MAIN-QUESTION-2', 'MAIN-ANSWER-2')
  await probe('hold', { id: main })
  await probe('followup', { id: main, text: 'MAIN-STILL-RUNNING' })
  await until(async () => (await probe('state', { id: main })).running)
  await rpc('activity-probe', 'configure', { text: 'SIDE-ANSWER' })
  const sideEditor = side.locator('[data-lexical-editor="true"]').first()
  await sideEditor.click()
  await page.keyboard.type('SIDE-QUESTION')
  await page.keyboard.press('Enter')
  await side.getByText('SIDE-ANSWER', { exact: true }).waitFor({ timeout: 20000 })
  await sidebar.getByText('侧边聊天：side probe', { exact: true }).waitFor()
  const { messages } = await probe('inspect', { id: child })
  const context = messages.find(message => message.source === 'fig-side-chat-context')
  assert.equal(messages.find(message => message.source === 'fig-side-chat-policy')?.text, '只回答问题，不继续或重做主会话的任务。')
  assert.match(context?.text ?? '', /MAIN-QUESTION-1/)
  assert.match(context?.text ?? '', /MAIN-ANSWER-2/)
  assert.deepEqual(messages.filter(message => message.source === 'user').map(message => message.text), ['SIDE-QUESTION'])
  assert.equal(await side.getByText('MAIN-ANSWER-2', { exact: true }).count(), 0)
  assert.equal(await page.locator('[data-slot="main.conversation"]').getByText('SIDE-QUESTION', { exact: true }).count(), 0)
  assert.equal((await probe('state', { id: main })).running, true, 'The main session keeps running')
  // A second question with nothing new in the main session adds no second reference.
  await rpc('activity-probe', 'configure', { text: 'SIDE-ANSWER-2' })
  await sideEditor.click()
  await page.keyboard.type('SIDE-QUESTION-2')
  await page.keyboard.press('Enter')
  await side.getByText('SIDE-ANSWER-2', { exact: true }).waitFor({ timeout: 20000 })
  const again = (await probe('inspect', { id: child })).messages
  assert.equal(again.filter(message => message.source === 'fig-side-chat-context').length, 1, 'Only new main-session messages are referenced')
  assert.equal(again.filter(message => message.source === 'fig-side-chat-policy').length, 1, 'The fixed constraint is present even after an ask without new main context')
  await page.screenshot({ path: join(evidence, 'smoke-context.png') })
  // Main Session is idle when the box opens, then begins a new held turn before confirmation.
  await probe('cancel', { id: main })
  await until(async () => !(await probe('state', { id: main })).running)
  await side.locator('[data-fig-send-main]').last().click()
  const dialog = page.getByRole('dialog', { name: '发到主会话', exact: true })
  const draft = dialog.getByRole('textbox')
  await draft.fill('SYNTHETIC-EDITED-DRAFT')
  await probe('hold', { id: main })
  await probe('followup', { id: main, text: 'MAIN-STARTED-AFTER-CONFIRMATION-OPENED' })
  await until(async () => (await probe('state', { id: main })).running)
  const rejected = await page.evaluate(async child => (await fetch('/fig-side-chat/send', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({child, text: 'SYNTHETIC-BYPASS', requestId: crypto.randomUUID()}) })).json(), child)
  assert.equal(rejected.error.code, 'MAIN_RUNNING')
  await draft.press('Meta+Enter')
  await dialog.getByRole('alert').filter({hasText: '主会话正在运行'}).waitFor()
  assert.equal(await draft.inputValue(), 'SYNTHETIC-EDITED-DRAFT')
  await page.screenshot({ path: join(evidence, 'smoke-send-rejected.png') })
  await probe('cancel', { id: main })
  await until(async () => !(await probe('state', { id: main })).running)
  await probe('hold', { id: main })
  let sends = 0
  const countSend = request => {if (request.url().endsWith('/fig-side-chat/send')) sends++}
  page.on('request', countSend)
  try {
    const submitted = page.waitForResponse(response => response.url().endsWith('/fig-side-chat/send'))
    await dialog.locator('[data-fig-send-confirm]').evaluate(button => {button.click(); button.click()})
    assert.deepEqual((await (await submitted).json()).value, {main, mode: 'queue'})
    await dialog.waitFor({state:'hidden'})
    await until(async () => Boolean((await probe('held', { id: main })).entries.flat().some(message => JSON.stringify(message.content).includes('SYNTHETIC-EDITED-DRAFT'))))
    assert.equal(sends, 1)
    assert.ok(!(await probe('inspect', { id: main })).messages.some(message => message.text.includes('SYNTHETIC-BYPASS')))
  } finally {page.off('request', countSend)}
  await probe('cancel', { id: main })
  await until(async () => !(await probe('state', { id: main })).running)
  // Asking again (⌥⌘S) reveals the open side chat.
  await mainEditor.click()
  await page.keyboard.press('Alt+Meta+KeyS')
  const { chats } = await rpc('fig-side-chat', 'list')
  assert.deepEqual(chats, [child], 'One side chat per main Session')
  assert.equal(await side.locator('[data-conversation-session]').first().getAttribute('data-conversation-session'), child)
  assert.equal(await page.locator('[data-fig-side-chat]').count(), 1)
  await page.locator('[data-dockkit-strip] [aria-label*="关闭"], [data-dockkit-strip] button[title*="关闭"]').first().click()
  await until(async () => (await probe('inspect', { id: child })).archived)
  assert.ok((await sidebar.innerText()).includes('side probe'))
  // ⌥⌘S opens a fresh one for the Session on screen.
  await mainEditor.click()
  await page.keyboard.press('Alt+Meta+KeyS')
  await page.locator('[data-fig-side-chat] [data-lexical-editor="true"]').first().waitFor({ timeout: 30000 })
  const fresh = await side.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')
  assert.ok(fresh && fresh !== child)
  passed = true
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'smoke-failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.close().catch(() => {})
  await cleanUp(profile, passed)
}
console.log('PASS: side chat')
