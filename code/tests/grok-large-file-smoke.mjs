import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'
import { sessionEvents } from './helpers/session-events.mjs'

// A standard Grok Subscription session writes a large standalone HTML file in one turn: the
// large-file rule reaches the request, the file is written in several tool calls, and no idle
// timeout or retry occurs. Takes several minutes of real Grok time.

if (!process.argv.includes('--real')) {
  throw new Error('Pass --real to run with the current Grok CLI login.')
}

const { profile, workspace, env } = await isolatedProfile('grok-large-file', {
  extraEnv: profile => ({ GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: process.env.GROK_AUTH_PATH ?? join(homedir(), '.grok/auth.json') })
})
await mkdir(join(profile, 'grok'))
await copyFile(join(homedir(), '.grok/version.json'), join(profile, 'grok/version.json'))

let app
let passed = false
const started = Date.now()

try {
  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: /^选择模型.*DeepSeek/i }).first().click({ timeout: 30_000 })
  await page.getByRole('menuitem', { name: /^模型|^Model/i }).first().click()
  await page.getByRole('menuitemradio', { name: 'Grok 4.7', exact: true }).first().click()
  const editor = page.locator('[contenteditable="true"]').last()
  await editor.fill('Create output/console.html: a complete standalone security operations console page with inline CSS and JavaScript, about 700 lines, '
    + 'with a sidebar, an asset table of 40 rows, an alert list of 30 items, a light/dark switch and a Chinese/English switch. Do not ask questions; just build it and tell me when it is done.')
  await editor.press('Enter')
  const done = () => sessionEvents(join(profile, 'dsh/sessions')).then(events => events.find(event => event.type === 'turn/end' && event.data.turn === 1))
  let end
  for (const deadline = Date.now() + 25 * 60_000; !(end = await done()) && Date.now() < deadline;) await page.waitForTimeout(5000)
  const events = await sessionEvents(join(profile, 'dsh/sessions'))
  const retries = events.filter(event => event.type === 'llm/retry')
  const writes = events.filter(event => event.type === 'tool/call').map(event => event.data?.name ?? event.data?.call?.name)
  const html = await readFile(join(workspace, 'output/console.html'), 'utf8').catch(() => '')
  console.log('minutes', ((Date.now() - started) / 60_000).toFixed(1), 'end', JSON.stringify(end?.data?.reason), 'retries', retries.length,
    'tool calls', JSON.stringify(writes), 'file lines', html.split('\n').length, 'bytes', html.length)
  assert.equal(end?.data?.reason?.kind, 'completed')
  assert.equal(retries.length, 0, JSON.stringify(retries.map(event => event.data.failure)))
  assert.ok(html.length > 20_000 && /<\/html>/i.test(html), 'a complete large file')
  console.log('PASS: the large file was written without an idle timeout or retry')
  passed = true
} catch (error) {
  await app?.windows().at(-1)?.screenshot({ path: join(profile, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app?.close()
  await cleanUp(profile, passed)
}
