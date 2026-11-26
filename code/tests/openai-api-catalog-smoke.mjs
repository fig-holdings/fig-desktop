// Real Fig settings, session picker, attachment store and protocol serializer, with four synthetic accounts.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedDevEnvironment } from '../scripts/dev-isolation.mjs'
import { cleanUp, closeFig, isolatedProfile, launchFig } from '../scripts/isolated-fig.mjs'
import { openWorkbench } from './helpers/fig-smoke.mjs'
import { chooseSubscriptionMenuModels, verifySubscriptionMedium } from './helpers/subscription-model-menu.mjs'

const routes = [
  { name: 'ChatGPT 账号', prefix: 'gpt', host: 'api.openai.com', account: 'chatgpt' },
  { name: 'Grok 账号', prefix: 'grok', host: 'cli-chat-proxy.grok.com', account: 'grok' },
  { name: 'openai', prefix: 'gpt', host: 'api.openai.com' },
  { name: 'xai', prefix: 'grok', host: 'api.x.ai' }
].map(route => ({ ...route, id: route.name === 'ChatGPT 账号' ? 'gpt-6.2-sol' : route.prefix + '-' + randomUUID().slice(0, 8), key: 'fig-synthetic-' + randomUUID() }))
const [chatgpt, , openai] = routes
const bundle = process.argv.find(arg => arg.startsWith('--bundle='))?.slice(9)
const appPath = bundle && resolve(bundle, 'Contents/Resources/app')
const receipts = new Map()
const published = new Set()
const textReply = id => 'IMAGE-RECEIVED-' + id
function reply(id) {
  const text = textReply(id)
  const message = { type: 'message', role: 'assistant', id: 'msg_' + id, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  const response = { id: 'resp_' + id, status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }
  const events = [
    { type: 'response.created', response: { ...response, output: [] } },
    { type: 'response.output_item.added', item: { ...message, content: [] }, output_index: 0 },
    { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] }, output_index: 0, content_index: 0 },
    { type: 'response.output_text.delta', delta: text, output_index: 0, content_index: 0 },
    { type: 'response.output_item.done', item: message, output_index: 0 },
    { type: 'response.completed', response }
  ]
  return events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('')
}
let fixtureError
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/developers.openai.com/')) {
      assert.equal(req.headers.authorization, undefined)
      if (req.url.endsWith('/models.md')) return res.end('[' + openai.id + '](/api/docs/models/' + openai.id + '.md)')
      assert.ok(req.url.endsWith('/' + openai.id + '.md'))
      return res.end('- Input modalities: text, image\n- Output modalities: text\n| Responses | `v1/responses` | Supported |')
    }
    const route = routes.find(route => req.headers.authorization === 'Bearer ' + route.key)
    assert.ok(route && req.url.startsWith('/' + route.host + '/v1/'), 'route credential must match vendor')
    if (req.method === 'GET') {
      const id = published.has(route.id) ? route.id : route.prefix + (route.account ? '-previous' : '-api-previous')
      const row = { id, input_modalities: ['text', 'image'] }
      const list = route === openai ? { data: [{ id }] } : route === chatgpt
        ? { models: [
          { slug: 'gpt-previous', visibility: 'list', input_modalities: ['text'] },
          ...(id === route.id ? [{ ...row, slug: id, visibility: 'list' }] : []),
          { slug: 'gpt-unconfirmed', visibility: 'list', api_backend: 'future' }
        ] } : route.account
          ? { data: [
            { id: 'grok-previous' },
            ...(id === route.id ? [{ ...row, api_backend: 'responses', supports_reasoning_effort: true,
              reasoning_efforts: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }], reasoning_effort: 'high' }] : []),
            { id: 'grok-unconfirmed', api_backend: 'future' }
          ] } : { models: [{ ...row, output_modalities: ['text'] }] }
      assert.ok(req.url.endsWith(route === routes[3] ? '/language-models' : '/models'))
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(list))
    }
    assert.ok(req.url.endsWith('/responses'))
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(body.model, route.id)
    const content = body.input.filter(message => message.role === 'user').flatMap(message => message.content)
    const picture = content.findLast(part => part?.type === 'input_image')
    if (picture) {
      // A title or next-step hint may intentionally request a lower effort. Assert the conversation turn.
      if (route.account) assert.equal(body.reasoning?.effort, 'medium')
      receipts.set(route.id, picture.image_url)
    }
    res.setHeader('content-type', 'text/event-stream')
    res.end(reply(route.id))
  } catch (error) {
    fixtureError = error
    res.writeHead(400)
    res.end('Invalid fixture request')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { profile, dshHome, documents, env } = await isolatedProfile('model-discovery', { base: isolatedDevEnvironment() })
env.FIG_MODEL_TEST_SERVER = 'http://127.0.0.1:' + server.address().port
delete env.OPENAI_API_KEY
env.XAI_API_KEY = routes[3].key
await mkdir(env.GROK_HOME)
await writeFile(env.GROK_AUTH_PATH, JSON.stringify({ 'https://auth.x.ai::00000000-0000-0000-0000-000000000001': {
  auth_mode: 'oidc', key: routes[1].key, expires_at: new Date(Date.now() + 3600000).toISOString() } }))
await writeFile(join(dshHome, '.credentials.yaml'), JSON.stringify({ version: 1, records: {
  'fig-chatgpt/subscription': { kind: 'grant', payload: { type: 'oauth', clientId: 'test', refresh: 'test', access: routes[0].key, expires: Date.now() + 3600000 } }
} }), { mode: 0o600 })
await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'workspace-controller', config: { documentsDirectory: documents } },
  { id: 'llm-pi-ai', config: { providers: { xai: { apiKeyEnv: 'XAI_API_KEY' } } } },
  { insert: [{ id: 'model-directory-wire', name: fileURLToPath(new URL('./fixtures/model-directory-wire.mjs', import.meta.url)) }] }
]))
let app, page, passed = false
try {
  app = await launchFig(env, { appPath })
  page = await openWorkbench(app)
  page.setDefaultTimeout(12_000)
  for (const [index, route] of routes.entries()) {
    published.add(route.id)
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
    if (route.account) {
      const openAccount = () => page.getByRole('button', { name: route.name, exact: true }).click()
      await openAccount()
      await page.getByRole('button', { name: '刷新模型' }).click()
      await chooseSubscriptionMenuModels(page, route, dshHome, async () => {
        await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('fig-settings').click())
        await openAccount()
      })
    } else {
      await page.getByRole('button', { name: '模型', exact: true }).click()
      if (route === openai) {
        await page.getByRole('button', { name: '添加模型提供商' }).click()
        await page.getByRole('combobox', { name: '提供商' }).selectOption('openai')
        await page.getByLabel('API 密钥', { exact: true }).fill(route.key)
        await page.getByRole('button', { name: '保存', exact: true }).click()
      }
      await page.getByRole('button', { name: new RegExp('^编辑 ' + route.name + '\\b', 'i') }).click()
      await page.locator('summary').filter({ hasText: '自定义' }).click()
      await page.getByRole('button', { name: '获取可用模型' }).click()
      await page.getByRole('dialog').getByText(route.id, { exact: true }).first().waitFor()
      await page.keyboard.press('Escape')
    }
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^选择模型/ }).first().click()
    await page.getByRole('menuitem', { name: /^模型/ }).first().click()
    const option = page.getByRole('menuitemradio', { name: route === chatgpt ? /GPT-6\.2 Sol/i : new RegExp(route.id) })
    await option.waitFor()
    if (route.account) assert.equal(await page.getByRole('menuitemradio', { name: new RegExp(`${route.prefix}-(previous|unconfirmed)`) }).count(), 0)
    await option.click()
    if (route.account) await verifySubscriptionMedium(page, route.account)
    const color = [30 + index * 50, 50, 200]
    const png = await page.evaluate(color => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 16
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = 'rgb(' + color.join(',') + ')'
      ctx.fillRect(0, 0, 16, 16)
      return canvas.toDataURL().split(',')[1]
    }, color)
    await page.locator('input[type=file]').last().setInputFiles({ name: route.id + '.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    const editor = page.locator('[data-lexical-editor="true"][contenteditable="true"]').last()
    await editor.fill('Read the attached image for ' + route.id)
    await page.locator('button[aria-busy=false]').filter({ has: page.getByAltText(route.id + '.png', { exact: true }) }).waitFor()
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.locator('p').filter({ hasText: new RegExp('^' + textReply(route.id) + '$') }).first().waitFor()
    const received = receipts.get(route.id)
    assert.match(received ?? '', /^data:image\//)
    const pixel = await page.evaluate(async url => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob())
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      return [...ctx.getImageData(5, 5, 1, 1).data]
    }, received)
    for (const [i, channel] of color.entries()) assert.ok(Math.abs(channel - pixel[i]) <= 4, 'received pixels match attachment')
    console.log('PASS', route.name, route.id, 'settings → picker → image received', pixel)
  }
  assert.ifError(fixtureError)
  passed = true
} catch (error) {
  console.error('Isolated UI:', (await page?.locator('body').innerText())?.slice(-1800), fixtureError ?? '')
  throw error
} finally {
  if (app) await closeFig(app)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await cleanUp(profile, passed)
}
