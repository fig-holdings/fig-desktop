// First use on an empty Profile: the default Workspace is `<startup directory>/default-workspace`, shown as 默认工作区,
// and DSH's own `<Documents>/deepseek-harness` location is not created. The isolated Profile points DSH's Documents
// override inside the Profile, so a failed claim would show up there and never in the real Documents folder.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedProfile, launchFig, workbenchPage, cleanUp, until } from '../scripts/isolated-fig.mjs'
import { evidenceDir, openWorkbench, writeResult } from './helpers/fig-smoke.mjs'

const evidence = await evidenceDir('default-workspace')
const state = await isolatedProfile('default-workspace', { extraEnv: root => ({ GROK_HOME: join(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok/auth.json'), CODEX_HOME: join(root, 'codex') }) })
const exists = path => stat(path).then(info => info.isDirectory(), () => false)
const registry = () => readFile(join(state.dshHome, 'storages/workspace.json'), 'utf8').then(JSON.parse, () => undefined)
let app, page, passed = false
const checks = {}
try {
  app = await launchFig(state.env); page = await openWorkbench(app)
  await until(async () => (await registry())?.global?.defaultWorkspaceId, { timeout: 30_000, interval: 200, message: 'no default workspace was registered' })
  const stored = await registry()
  const workspaces = Object.values(stored.tables.workspaces)
  checks.registered = workspaces.map(workspace => ({ path: workspace.path.replace(state.documents, '<startup>').replace(/^\/private/, ''), title: workspace.title }))
  assert.equal(workspaces.length, 1)
  assert.equal(workspaces[0].title, 'default-workspace')
  assert.ok(workspaces[0].path.endsWith(join(state.documents, 'default-workspace').replace(/^\/private/, '')), workspaces[0].path)
  checks.folderCreated = await exists(state.workspace)
  assert.ok(checks.folderCreated)
  checks.dshLocationAbsent = !await exists(join(state.documents, 'deepseek-harness'))
  assert.ok(checks.dshLocationAbsent, "DSH's own default location must not be created")
  // The page settles on the same Workspace and names it in the reader's language.
  await page.getByText('默认工作区').first().waitFor({ timeout: 20_000 })
  checks.shownAsDefault = true
  await page.screenshot({ path: join(evidence, 'first-use.png') })
  // A second start changes nothing.
  await app.close(); app = undefined
  // The preview notice was dismissed on the first start, so the page is taken as it loads.
  app = await launchFig(state.env); page = await workbenchPage(app)
  await page.getByText('默认工作区').first().waitFor({ timeout: 30_000 })
  checks.stableAfterRestart = Object.keys((await registry()).tables.workspaces).length === 1 && !await exists(join(state.documents, 'deepseek-harness'))
  assert.ok(checks.stableAfterRestart)
  passed = true
  await writeResult(evidence, { date: new Date().toISOString().slice(0, 10), scope: 'first-use default workspace under the startup directory; empty isolated Profile, no model', status: 'pass', checks,
    not_verified: ['packaged app', 'a real new macOS account without the Documents override'] })
  console.log('PASS', JSON.stringify(checks))
} catch (error) { await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined); throw error } finally { await app?.close(); await cleanUp(state.profile, passed) }
