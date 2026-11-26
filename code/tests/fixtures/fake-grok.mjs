// A scripted stand-in for the Grok CLI: login, logout, and the ACP sign-in and billing calls Fig makes.
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.env.FAKE_GROK_RECORD) appendFileSync(process.env.FAKE_GROK_RECORD, 'spawn ' + process.argv.slice(2).join(' ') + (process.env.FIG_DEV_RUNTIME_DIR ? ' devRuntime=' + process.env.FIG_DEV_RUNTIME_DIR : '') + '\n')
if (process.argv.includes('logout')) {
  if (process.env.FAKE_GROK_LOGOUT === 'fail') process.exit(1)
  if (process.env.GROK_AUTH_PATH) writeFileSync(process.env.GROK_AUTH_PATH, '{}')
  process.exit(0)
}
if (process.argv.includes('login')) {
  // Mirrors `grok login --oauth`: the sign-in URL goes to stderr, success exits 0.
  process.stderr.write('Signing in with Grok...\n\nOpen this URL to sign in:\n  https://auth.x.ai/oauth2/authorize?response_type=code&state=fake\n')
  setTimeout(() => process.exit(process.env.FAKE_GROK_LOGIN === 'fail' ? 1 : 0), process.env.FAKE_GROK_LOGIN === 'hang' ? 30000 : 100)
}
process.stderr.write('auth refreshed token=fake-secret-token-value-1234567890\n')

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

// Fig only uses the CLI's ACP connection to renew the sign-in and read billing.
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line)
  if (method === undefined) return
  switch (method) {
    case 'initialize':
      return send({ id, result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] } })
    case 'authenticate':
      return process.env.FAKE_GROK_AUTH === 'fail'
        ? send({ id, error: { code: -32000, message: '401 unauthorized' } })
        : send({ id, result: {} })
    case '_x.ai/billing': return send({ id, result: { config: {
      creditUsagePercent: 2, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-04T03:00:00+00:00', end: '2026-11-11T03:00:00+00:00' },
      prepaidBalance: { val: 0 }, isUnifiedBillingUser: true
    }, subscription_tier: 'SuperGrok' } })
    default: return send({ id, error: { code: -32601, message: 'unsupported' } })
  }
})
