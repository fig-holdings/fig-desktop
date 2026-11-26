import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'

// Code block copy buttons reach the system clipboard, and the right-click menu offers 复制路径 on
// delivered files, changed-file cards and file mentions, in a standard Grok Subscription session.
// Overwrites the system clipboard.

if (!process.argv.includes('--real')) {
  throw new Error('Pass --real to run with the current Grok CLI login.')
}

const { profile, workspace, env } = await isolatedProfile('copy', {
  extraEnv: profile => ({ GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: process.env.GROK_AUTH_PATH ?? join(homedir(), '.grok/auth.json') })
})
// The subscription provider sends the CLI version from GROK_HOME; the proxy refuses requests without it.
await mkdir(join(profile, 'grok'))
await copyFile(join(homedir(), '.grok/version.json'), join(profile, 'grok/version.json'))
// The changed-files card needs a git working directory.
await mkdir(workspace, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: workspace })
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspace })

let app
let passed = false

const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText())
const setClipboard = text => app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)

// Record each native context menu instead of showing it, and run its 复制路径 item.
async function recordMenus() {
  await app.evaluate(({ Menu }) => {
    globalThis.figMenus = []
    Menu.prototype.popup = function () {
      globalThis.figMenus.push(this.items.map(item => item.label))
      this.items.find(item => item.label === '复制路径')?.click()
    }
  })
}

async function rightClick(page, locator) {
  await app.evaluate(() => { globalThis.figMenus = [] })
  await locator.click({ button: 'right' })
  await page.waitForTimeout(400)
  return (await app.evaluate(() => globalThis.figMenus))[0] ?? []
}

async function checkPath(page, locator, name, file, { dshMenu = false } = {}) {
  await setClipboard('BEFORE')
  const labels = await rightClick(page, locator)
  let via = '复制路径'
  if (dshMenu) {
    // DSH has its own menu on file mentions and delivered cards, with 复制文件路径; Fig's menu stays closed.
    assert.equal(labels.length, 0, `${name}: Fig menu ${labels.join(', ')}`)
    await page.getByRole('menuitem', { name: '复制文件路径' }).click()
    await page.waitForTimeout(300)
    via = 'DSH 复制文件路径'
  } else {
    assert.ok(labels.includes('复制路径'), `${name}: menu ${labels.join(', ')}`)
  }
  const copied = await clipboardText()
  assert.ok(copied.endsWith('/default-workspace/' + file) && existsSync(copied), `${name}: copied ${copied}`)
  console.log(`PASS: ${name} → ${via}`, copied)
}

async function checkSession(page, label, file, { delivered }) {
  const code = page.locator('.md-code-block').last()
  await code.waitFor({ timeout: 180_000 })
  await page.getByRole('button', { name: /^(停止生成|Stop generating)$/ }).first().waitFor({ state: 'hidden', timeout: 120_000 })
  await setClipboard('BEFORE')
  await code.hover()
  await code.getByRole('button', { name: /^(复制|复制代码|Copy)/ }).first().click()
  await page.waitForTimeout(300)
  assert.match(await clipboardText(), /echo copy-ok-671/)
  console.log(`PASS: ${label} code block copy reaches the clipboard`)

  await checkPath(page, page.locator('button[class*="fileMention"]').filter({ hasText: file }).first(), `${label} file mention`, file, { dshMenu: true })
  await checkPath(page, page.locator('[aria-describedby]').filter({ hasText: file }).last(), `${label} changed-files card`, file)
  if (delivered) await checkPath(page, page.locator('[data-presented-file]').filter({ hasText: file }).last(), `${label} delivered file`, file, { dshMenu: true })

  const plain = await rightClick(page, page.locator('[data-slot="conversation.user.text.node"]').last())
  assert.ok(!plain.includes('复制路径'), `${label}: user message menu ${plain.join(', ')}`)
  const editor = await rightClick(page, page.locator('[contenteditable="true"]').last())
  assert.ok(editor.includes('粘贴'), `${label}: editor menu ${editor.join(', ')}`)
  // Only clipboard writes are allowed to the page; pasting is the editor's own and still works.
  await setClipboard('PASTE-OK-671')
  await page.locator('[contenteditable="true"]').last().click()
  await page.keyboard.press('Meta+V')
  await page.locator('[contenteditable="true"]').last().filter({ hasText: 'PASTE-OK-671' }).waitFor({ timeout: 5000 })
  await page.locator('[contenteditable="true"]').last().fill('')
  console.log(`PASS: ${label} the user message has no 复制路径; the composer offers 粘贴 and Cmd+V pastes`)
}


async function send(page, prompt) {
  const editor = page.locator('[contenteditable="true"]').last()
  await editor.fill(prompt)
  await editor.press('Enter')
}

// One line: a newline in the composer would send the prompt early.
const prompt = (file, deliver) => `Create a file named ${file} in the working directory containing one line "hello".${deliver ? ' Then present that file to me as a deliverable with the present tool.' : ''}`
  + ` In your final reply, mention the file as the markdown link [${file}](${file}) and include a fenced bash code block whose only line is: echo copy-ok-671`

try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await recordMenus()
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: /^选择模型.*DeepSeek/i }).first().click({ timeout: 30_000 })
  await page.getByRole('menuitem', { name: /^模型|^Model/i }).first().click()
  await page.getByRole('menuitemradio', { name: 'Grok 4.7', exact: true }).first().click()
  await send(page, prompt('standard-note.md', true))
  await page.locator('[data-presented-file]').first().waitFor({ timeout: 180_000 })
  await checkSession(page, 'standard', 'standard-note.md', { delivered: true })

  passed = true
} catch (error) {
  await app?.windows().at(-1)?.screenshot({ path: join(profile, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app?.close()
  await cleanUp(profile, passed)
}
