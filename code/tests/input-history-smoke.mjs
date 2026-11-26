import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'

// Sent text comes back with ↑ in an empty composer, also after Fig restarts on a new DSH port.
// The model endpoint is unreachable, so the first turn keeps retrying and the second send is queued.
const { profile, env } = await isolatedProfile('history')
let current, passed = false

async function open(first) {
  const app = current = await launchFig(env)
  const page = await workbenchPage(app)
  if (first) await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30000 })
  else await page.getByRole('button', { name: /新建会话|新会话|New session/ }).first().click()
  const editor = page.locator('[data-lexical-editor="true"][contenteditable="true"]').last()
  await editor.waitFor({ timeout: 30000 })
  await page.locator('[data-fig-input-history]').first().waitFor({ state: 'attached', timeout: 15000 })
  return { app, page, editor }
}
const text = editor => editor.evaluate(node => node.innerText.trim())

try {
  let { app, page, editor } = await open(true)
  for (const message of ['first message 101', 'second message 202']) {
    await editor.click(); await editor.fill(message); await editor.press('Enter')
    await page.getByText(message).first().waitFor({ timeout: 30000 })
    await delay(1500)
  }
  await editor.click()
  if (await text(editor) !== '') throw new Error('The composer should be empty after sending.')
  await editor.press('ArrowUp')
  if (await text(editor) !== 'second message 202') throw new Error('↑ did not recall the last message: ' + await text(editor))
  await editor.press('ArrowUp')
  if (await text(editor) !== 'first message 101') throw new Error('↑↑ did not recall the earlier message.')
  await editor.press('ArrowDown'); await editor.press('ArrowDown')
  if (await text(editor) !== '') throw new Error('↓ past the newest entry should restore the empty draft.')
  await editor.type('draft'); await editor.press('ArrowUp')
  if (await text(editor) !== 'draft') throw new Error('↑ must not replace a typed draft.')
  console.log('PASS ↑/↓ recall sent text and leave typed drafts alone')
  await app.close()

  const saved = JSON.parse(await readFile(join(profile, 'dsh/fig/input-history.json'), 'utf8'))
  if (!Object.values(saved.scopes).some(list => list.includes('second message 202'))) throw new Error('History was not saved on the Host.')
  ;({ app, page, editor } = await open(false))
  await editor.click(); await delay(1000); await editor.press('ArrowUp')
  if (await text(editor) !== 'second message 202') throw new Error('History did not survive a restart: ' + await text(editor))
  console.log('PASS history survives a Fig restart')
  await app.close()
  passed = true
} finally {
  await current?.close().catch(() => {})
  await cleanUp(profile, passed)
}
