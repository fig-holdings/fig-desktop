import assert from 'node:assert/strict'
import { cleanUp, isolatedProfile, launchFig, workbenchPage } from '../scripts/isolated-fig.mjs'

// Every DSH start leaves a dsh-auth-* cookie for 127.0.0.1 in the workbench partition. With dozens
// of them the request headers outgrow DSH's limit, DSH answers 431 and the workbench stays blank.
// Fig clears the stale ones before loading, so a profile full of them still opens.

const { profile, env } = await isolatedProfile('stale-cookie')
let app
let passed = false
const authCookies = () => app.evaluate(async ({ session }) =>
  (await session.fromPartition('persist:fig-dsh').cookies.get({ domain: '127.0.0.1' })).filter(cookie => cookie.name.startsWith('dsh-auth-')).length)

try {
  app = await launchFig(env)
  await workbenchPage(app)
  await app.evaluate(async ({ session }) => {
    const cookies = session.fromPartition('persist:fig-dsh').cookies
    const expirationDate = Date.now() / 1000 + 30 * 24 * 3600
    for (let i = 0; i < 80; i++) {
      await cookies.set({ url: 'http://127.0.0.1/', name: 'dsh-auth-stale' + String(i).padStart(32, '0'), value: 'x'.repeat(128), path: '/', httpOnly: true, expirationDate })
    }
    await cookies.flushStore()
  })
  assert.ok(await authCookies() >= 80)
  await app.close()

  app = await launchFig(env)
  const page = await workbenchPage(app)
  await page.getByText(/^(新会话|New session)$/).first().waitFor({ timeout: 60_000 })
  assert.ok(await authCookies() <= 1, 'stale dsh-auth cookies remain')
  console.log('PASS: 80 stale DSH sign-in cookies are cleared and the workbench loads')
  passed = true
} finally {
  await app?.close()
  await cleanUp(profile, passed)
}
