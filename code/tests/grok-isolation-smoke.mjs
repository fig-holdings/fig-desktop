import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

// Test the official CLI's credential-storage operation, not its nested tool sandbox. The OS denies
// networking, Mach services, daily Grok reads and all writes outside this test root. No real grant.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
assert.ok(evidence, 'Require a new --evidence directory')
await mkdir(evidence)
const profile = await realpath(await mkdtemp(join(tmpdir(), 'fig-grok-isolation-')))
const grokHome = join(profile, 'grok'), authPath = join(grokHome, 'auth.json')
await mkdir(grokHome)
const daily = join(homedir(), '.grok')
// Logout addresses the CLI's public OAuth client scope, not an arbitrary UUID. Read only that
// public app identifier for the synthetic fixture; never copy the real grant or account fields.
const profiles = Object.values(JSON.parse(await readFile(join(daily, 'auth.json'), 'utf8'))).filter(value => value?.auth_mode === 'oidc')
const clientId = profiles.length === 1 ? profiles[0].oidc_client_id : undefined
assert.match(clientId ?? '', /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i, 'Require one known public CLI OAuth client scope')
const scope = 'https://auth.x.ai::' + clientId
await writeFile(authPath, JSON.stringify({ [scope]: { auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: clientId,
  key: 'x'.repeat(40), refresh_token: 'isolated-invalid-refresh', expires_at: '2099-01-01T00:00:00Z',
  create_time: '2026-11-07T00:00:00Z', user_id: '00000000-0000-4000-8000-000000000001', email: 'synthetic@example.invalid', first_name: 'Synthetic', last_name: 'Fixture',
  profile_image_asset_id: '00000000-0000-4000-8000-000000000002', principal_type: 'User', principal_id: '00000000-0000-4000-8000-000000000001', team_id: '',
  team_zero_data_retention: false, coding_data_retention_opt_out: true, coding_data_team: 'personal' } }), { mode: 0o600 })
const fingerprint = async name => readFile(join(daily, name)).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null)
const before = Object.fromEntries(await Promise.all(['auth.json', 'version.json', 'config.toml'].map(async name => [name, await fingerprint(name)])))
const report = { schema: 1, status: 'blocked', startedAt: new Date().toISOString(), mode: 'native-logout-isolated-storage', scope: 'synthetic auth; network/Mach denied; daily Grok home read/write denied', cases: [] }
try {
  assert.equal(process.platform, 'darwin', 'This preflight uses macOS sandbox-exec')
  const quote = value => JSON.stringify(value)
  const policy = `(version 1)(allow default)(deny network*)(deny mach-lookup)(deny file-write*)(allow file-write* (subpath ${quote(profile)}) (literal "/dev/null"))(deny file-read* file-write* (subpath ${quote(daily)}))`
  const env = { ...process.env, TSX_DISABLE_CACHE: '1', GROK_HOME: grokHome, GROK_AUTH_PATH: authPath }
  let command = ['grok', '--no-auto-update', 'logout', '--leader-socket', join(profile, 'leader.sock')]
  if (process.argv.includes('--host-helper')) {
    const runner = join(profile, 'logout.mjs')
    await writeFile(runner, `import {logoutCli} from ${JSON.stringify(new URL('../harness/provider-grok/account.js', import.meta.url).href)}; await logoutCli(process.env.GROK_HOME, process.env.GROK_AUTH_PATH);`)
    command = [process.execPath, '--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), runner]
    report.entry = 'Fig account logoutCli (same underlying official CLI and isolation policy)'
  }
  const { stdout, stderr } = await promisify(execFile)('/usr/bin/sandbox-exec', ['-p', policy, ...command], { cwd: profile, env, timeout: 20000 })
  report.cli = { exitCode: 0, diagnostic: (stdout + stderr).slice(0, 1000) }
  const remaining = await readFile(authPath, 'utf8').catch(() => '')
  assert.ok(!remaining.includes('x'.repeat(40)), 'official logout must remove the synthetic access key at the explicitly isolated path')
  const after = Object.fromEntries(await Promise.all(Object.keys(before).map(async name => [name, await fingerprint(name)])))
  assert.deepEqual(after, before, 'daily state must remain byte-identical')
  report.filesCreated = await readdir(grokHome, { recursive: true })
  report.cli.syntheticGrantRemoved = true
  report.cases.push({ id: 'real-cli-credential-writes-stay-in-isolated-state', status: 'pass' })
  report.status = 'pass'
} catch (error) { report.reason = error.message; report.diagnostic = error.stderr?.slice(0, 2000); process.exitCode = 3 }
finally {
  await rm(profile, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString()
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(report.status + ': Grok CLI credential storage isolation')
}
