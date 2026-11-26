import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanUp, closeFig, isolatedProfile, launchFig, until } from '../scripts/isolated-fig.mjs'

// Plugin updates in the real app: a signed side-chat update made
// from this build replaces the built-in copy without rebuilding Fig; an update whose page part fails to load is
// recorded, and Fig restarts DSH with the built-in copy by itself. Needs a build (npm run build) and the development
// key (work/plugin-keys/dev.json, listed in harness/plugin-update-keys.json).
const work = fileURLToPath(new URL('../../work/', import.meta.url))
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11) ?? join(work, 'verification/plugin-update/')
await mkdir(evidence, { recursive: true })
const key = JSON.parse(await readFile(join(work, 'plugin-keys/dev.json'), 'utf8'))
const scratch = await mkdtemp(join(tmpdir(), 'fig-plugin-update-src-'))

/** A signed side-chat update from this build: `version`, with `client` replacing or prefixing its page script. */
async function sideChatUpdate(version, client) {
  const source = join(scratch, version, 'package')
  await cp(join(work, 'build/main/side-chat'), source, { recursive: true })
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await writeFile(join(source, 'package.json'), JSON.stringify({ ...manifest, version }, null, 2))
  await writeFile(join(source, 'client.js'), client(await readFile(join(source, 'client.js'), 'utf8')))
  const archive = join(scratch, `side-chat-${version}.tgz`)
  execFileSync('tar', ['-czf', archive, '-C', join(scratch, version), 'package'])
  const bytes = await readFile(archive)
  await writeFile(archive + '.sig.json', JSON.stringify({ keyId: key.id, algorithm: 'ed25519', sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: sign(null, bytes, createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64') }))
  return archive
}

async function place(dshHome, archive) {
  const updates = join(dshHome, 'fig/updates')
  await mkdir(updates, { recursive: true })
  for (const file of [archive, archive + '.sig.json']) await cp(file, join(updates, file.split('/').at(-1)))
}

const state = dshHome => readFile(join(dshHome, 'fig/updates/state.json'), 'utf8').then(JSON.parse)
const linked = async dshHome => JSON.parse(await readFile(join(dshHome, 'profiles/web/package.json'), 'utf8')).dependencies['@local/dsh-side-chat']

/** Starts Fig, waits for a workbench page that has opened its input (after any restart Fig makes), reads the probe. */
async function openWorkbench(env, shot) {
  const app = await launchFig(env)
  try {
    const startup = await app.firstWindow()
    const page = await until(async () => {
      for (const item of app.context().pages()) {
        if (item === startup || item.isClosed() || !item.url().startsWith('http://127.0.0.1:')) continue
        await item.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 500 }).catch(() => {})
        if (await item.locator('[data-lexical-editor="true"]').count().catch(() => 0)) return item
      }
    }, { timeout: 300_000, interval: 500, message: 'The workbench did not open' })
    const probe = await page.evaluate(() => globalThis.__figUpdateProbe)
    await page.screenshot({ path: join(evidence, shot) })
    return probe
  } finally {
    await closeFig(app)
  }
}

const { profile, dshHome, env } = await isolatedProfile('plugin-update')
let passed = false
try {
  const good = await sideChatUpdate('9.0.1', code => `globalThis.__figUpdateProbe = '9.0.1';\n` + code)
  await place(dshHome, good)
  assert.equal(await openWorkbench(env, 'update-in-use.png'), '9.0.1', 'The update\'s page script runs')
  assert.deepEqual((await state(dshHome)).active, { '@local/dsh-side-chat': '9.0.1' })
  assert.match(await linked(dshHome), /fig\/updates\/unpacked\/[0-9a-f]{16}\/package$/)

  for (const file of [good, good + '.sig.json']) await rm(join(dshHome, 'fig/updates', file.split('/').at(-1)))
  await place(dshHome, await sideChatUpdate('9.0.2', () => `throw new Error('fig-plugin-update-probe: deliberate page failure')\n`))
  assert.equal(await openWorkbench(env, 'fallback-built-in.png'), undefined, 'The built-in side-chat is back')
  const after = await state(dshHome)
  assert.deepEqual(after.active, {})
  assert.ok(after.failed['@local/dsh-side-chat@9.0.2'], 'The failed update is recorded and not used again')
  assert.match(await linked(dshHome), /fig\/packages\/[0-9a-f]{16}\/side-chat$/)
  passed = true
} finally {
  await cleanUp(profile, passed)
  await rm(scratch, { recursive: true, force: true })
}
console.log('PASS: plugin update and fallback')
