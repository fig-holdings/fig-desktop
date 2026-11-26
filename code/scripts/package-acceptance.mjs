import assert from 'node:assert/strict'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifySignature } from './macos-bundle.mjs'
import { assertLicensePayload } from './third-party-licenses.mjs'
import { isolatedDevEnvironment } from './dev-isolation.mjs'
import { isolatedProfile, launchFig, workbenchPage, cleanUp } from './isolated-fig.mjs'
import { acceptProfileMigration } from './profile-migration-acceptance.mjs'

// Exact production JS in an isolated dev host: production binary ignores data-dir env.
// This is payload startup acceptance, not a real daily-profile/LaunchServices test.
export async function acceptPackage(bundle, build, evidence) {
  await mkdir(evidence, {recursive: true})
  verifySignature(bundle, false)
  await assertLicensePayload(join(bundle, 'Contents/Resources/app'))
  let files = 0
  async function compare(relative = '') {
    for (const entry of await readdir(join(build, relative), {withFileTypes: true})) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) await compare(path)
      else {assert.deepEqual(await readFile(join(build, path)), await readFile(join(bundle, 'Contents/Resources/app', path)), path); files++}
    }
  }
  await compare()
  const appPath = join(bundle, 'Contents/Resources/app')
  const state = await isolatedProfile('package-acceptance', {base: isolatedDevEnvironment(),
    // The same isolation on this throwaway profile, so the Grok and Codex state lives in it too.
    extraEnv: profile => isolatedDevEnvironment({}, profile)})
  let app, startup = false, migration = false
  try {
    app = await launchFig(state.env, {appPath})
    const page = await workbenchPage(app)
    await page.getByRole('button', {name: /^(继续|Continue)$/}).click({timeout: 60_000})
    await page.locator('[data-slot="sidebar"]').waitFor({timeout: 60_000})
    await page.screenshot({path: join(evidence, 'startup.png')})
    await app.close()
    app = undefined
    startup = true
    await cleanUp(state.profile)
    await acceptProfileMigration({appPath, evidence:join(evidence, 'profile-migration'), scope:'Exact packaged JS payload in isolated development host'})
    migration = true
  } finally {
    if (!startup) {
      await app?.close()
      await cleanUp(state.profile, false)
    }
    await writeFile(join(evidence, 'acceptance.json'), JSON.stringify({status: migration ? 'pass' : 'fail', files, signature: true, startup, migration,
      actualSignedBinaryExecution: false, scope: 'exact packaged payload startup and legacy Profile migration in isolated dev host', at: new Date().toISOString()}, null, 2))
  }
}
