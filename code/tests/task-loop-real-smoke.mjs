import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parse } from 'yaml'
import { cleanUp, isolatedProfile, launchFig, workbenchPage, until } from '../scripts/isolated-fig.mjs'
import { sessionEvents } from './helpers/session-events.mjs'
import { evidenceRun, BlockedError, extraScenarioIds } from './helpers/verification-run.mjs'
import { dshRuntimeRoot } from '../harness/shared/dsh-runtime.js'
import { prepareDshCache } from '../scripts/dsh-cache.mjs'
import { testedDsh } from './helpers/dsh-launcher.mjs'
import { readdirSync as listDir, existsSync as present } from 'node:fs'

/** Names of the skills DSH ships in its own packages (`<package>/{assets,skills}/<name>/SKILL.md`), for skills DSH registers without a path. */
let shippedSkills
function bundledSkillNames() {
  if (shippedSkills) return shippedSkills
  shippedSkills = new Set()
  const root = dshRuntimeRoot()
  for (const release of present(root) ? listDir(root) : []) {
    const scope = join(root, release, 'node_modules/@deepseek-ai')
    for (const pkg of present(scope) ? listDir(scope) : []) for (const folder of ['assets', 'skills']) {
      const base = join(scope, pkg, folder)
      for (const name of present(base) ? listDir(base) : []) if (present(join(base, name, 'SKILL.md'))) shippedSkills.add(name)
    }
  }
  return shippedSkills
}
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { guidanceDiagnostics } from './helpers/guidance-evidence.mjs'
import {acquireRefreshHandoff} from '../scripts/refresh-handoff.mjs'

// Real-model end-to-end check of task control, context management, artifact review and the tool loop,
// driven through Fig's own workbench UI. Everything the model sees is synthetic: the shared Workspace root,
// project, rules and files live in a throwaway profile (FIG_DESKTOP_WORKSPACE_DIR). Access-only
// credentials are removed afterwards; exclusive ChatGPT refresh returns the latest grant first.
if (!process.argv.includes('--real')) { console.error('Pass --real: drives models through the Fig UI with synthetic data.'); process.exit(2) }
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7)
const routes = {
  deepseek: { provider: 'deepseek-account', model: 'deepseek-flash' },
  chatgpt: { provider: 'fig-chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'low' },
  grok: { provider: 'fig-grok-oauth', model: 'grok-4.7', reasoningEffort: 'low' },
  // API-key routes: the key reference DSH saved (credentials `refs`) is copied, never a login grant.
  'deepseek-api': { provider: 'deepseek-official', model: 'deepseek-flash' },
  claude: { provider: 'anthropic', model: 'claude-opus-4-8' }
}
const provider = process.argv.find(arg => arg.startsWith('--provider='))?.slice(11) ?? 'deepseek'
const route = routes[provider]

let run
try { run = await evidenceRun({ provider, only, route, evidenceRoot: process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11) }) }
catch (error) { console.error(error.message); process.exit(2) }
const evidence = run.directory
let state, credential, app, page, fatal
let refreshHandoff, retainCredentials = false
const refreshMode = process.argv.find(arg => arg.startsWith('--refresh-mode='))?.slice(15) ?? 'auto'
const results = run.manifest.results
async function safeScreenshot(path) {
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  // Account identity lives in the native footer. Crop that band from evidence; assertions still
  // address the full live UI, including composer actions and the actual document/frame contents.
  await page.screenshot({ path, clip: { x: 0, y: 0, width: size.width, height: Math.max(1, size.height - 100) } })
}
run.manifest.screenshotScope = 'Live workbench excluding bottom 100 CSS pixels (account identity); full UI assertions are independent.'
let finishing
async function finishRun(error) {
  if (finishing) return finishing
  fatal ??= error
  finishing = (async () => {
  try {
    const summary = { finishedAt: new Date().toISOString(), route, results }
    await writeFile(join(evidence, `task-loop-${provider}-result.json`), JSON.stringify(summary, null, 2))
    await writeFile(join(evidence, `task-loop-${provider}-events.json`), JSON.stringify(await sessionEvents(join(state?.dshHome ?? '/nonexistent', 'sessions'))
      .then(events => events.map(e => ({ type: e.type, name: e.data?.name, title: e.data?.title, kind: e.data?.kind, source: e.data?.source?.kind }))), null, 1))
    const previewRoot = state && join(state.dshHome, 'fig/preview')
    if (previewRoot && await access(previewRoot).then(() => true, () => false)) await cp(previewRoot, join(evidence, 'preview'), { recursive: true, force: false })
    if (state?.fixtureRoot) await cp(state.fixtureRoot, join(evidence, 'synthetic-workspace'), { recursive: true, force: false })
  } catch (error) { fatal ??= error }
  let closed = false
  try { await app?.close(); closed = true } catch (error) { fatal ??= error; if (refreshHandoff) retainCredentials = true }
  if (refreshHandoff && closed) {
    try {run.manifest.refreshHandoff = await refreshHandoff.release()}
    catch {retainCredentials = true; fatal ??= new BlockedError('Latest grant return unconfirmed; isolated credential and recovery journal retained')}
  }
  retainCredentials ||= Boolean(fatal?.retainCredentials)
  if (retainCredentials) run.manifest.credentialRecovery = {status: 'blocked', isolatedCredentialRetained: true}
  if (credential && !retainCredentials) await rm(credential, { force: true })
  if (state) await rm(join(state.profile, 'grok/auth.json'), { force: true })
  process.exitCode = await run.finish(fatal)
  if (state) await cleanUp(state.profile, process.exitCode === 0 && !retainCredentials)
  })()
  return finishing
}
let emergencyStarted = false
const emergency = error => {
  if (emergencyStarted) return
  emergencyStarted = true
  // Playwright may emit a second process-level rejection while its driver tears down. Remove the
  // credential copy and synchronously checkpoint the non-pass manifest before any asynchronous work.
  if (credential && !refreshHandoff && !error?.retainCredentials) rmSync(credential, { force: true })
  if (state) rmSync(join(state.profile, 'grok/auth.json'), { force: true })
  run.emergency(error)
  console.error(error instanceof Error ? error.message : String(error))
  setTimeout(() => process.exit(1), 10_000).unref()
  void finishRun(error instanceof Error ? error : new Error(String(error))).then(() => process.exit(process.exitCode || 1), () => process.exit(1))
}
process.on('unhandledRejection', emergency)
process.on('uncaughtException', emergency)
try {
if (!['auto','access-only','exclusive'].includes(refreshMode)) throw new BlockedError('Unknown refresh mode')
run.manifest.refreshMode = refreshMode
state = await isolatedProfile('task-loop', { extraEnv: profile => ({ GROK_HOME: join(profile, 'grok'), GROK_AUTH_PATH: join(profile, 'grok/auth.json') }) })
delete state.env.DEEPSEEK_API_KEY
delete state.env.DEEPSEEK_BASE_URL
const profileReal = await realpath(state.profile)
const root = join(profileReal, 'ws-root'), project = join(root, 'projects/probe'), outside = join(profileReal, 'outside')
state.fixtureRoot = root
await mkdir(join(project, '.git'), { recursive: true })
await mkdir(outside)
await mkdir(join(state.profile, 'agents'), { recursive: true })
await mkdir(join(root, 'resources/skills/synthetic-probe'), { recursive: true })
await writeFile(join(root, 'resources/skills/synthetic-probe/SKILL.md'), '---\nname: synthetic-probe\ndescription: Only when explicitly asked for the synthetic skill marker.\n---\nReturn SYNTHETIC-SKILL-MARKER.\n')
await writeFile(join(root, 'AGENTS.md'), 'Synthetic test workspace. Broad marker BROAD-91.\n')
await writeFile(join(root, 'projects/AGENTS.md'), 'Synthetic test projects. Middle marker MIDDLE-28.\n')
await writeFile(join(project, 'AGENTS.md'), 'Synthetic test project. Project marker PROJECT-73. This is an authorized integration test.\n')
Object.assign(state.env, { DSH_AGENTS_HOME: join(state.profile, 'agents'), FIG_DESKTOP_WORKSPACE_DIR: root })
// The synthetic skills are registered as the extra skill folder, saved where the isolated desktop instance reads it.
await writeFile(join(state.profile, 'skill-directory.json'), JSON.stringify({ schema: 1, path: join(root, 'resources/skills') }))
credential = join(state.dshHome, '.credentials.yaml')
let stored
try { stored = parse(await readFile(join(homedir(), '.fig/.credentials.yaml'), 'utf8')) }
catch { throw new BlockedError('Required Fig credential store is unavailable') }
const records = Object.fromEntries(Object.entries(stored.records ?? {}).filter(([id]) => provider === 'deepseek' ? /deepseek/i.test(id) : provider === 'chatgpt' && id === 'fig-chatgpt/subscription'))
// An API-key route gets its own key reference and nothing else.
const apiKeyRef = { 'deepseek-api': 'DEEPSEEK_API_KEY', claude: 'ANTHROPIC_API_KEY' }[provider]
const refs = {}
if (apiKeyRef) {
  if (typeof stored.refs?.[apiKeyRef] !== 'string' || !stored.refs[apiKeyRef]) throw new BlockedError(`${apiKeyRef} is not saved in Fig; no other channel is authorized`)
  refs[apiKeyRef] = stored.refs[apiKeyRef]
  run.manifest.credentialScope = `API key reference ${apiKeyRef} only`
}
if (provider === 'deepseek' && !Object.entries(records).some(([id, record]) => /deepseek/i.test(id) && typeof record.payload?.token === 'string')) {
  throw new BlockedError('DeepSeek account grant is unavailable; no fallback channel is authorized')
}
if (provider === 'chatgpt') {
  const grant = records['fig-chatgpt/subscription']
  if (!grant?.payload?.access || !Number.isFinite(grant.payload.expires)) throw new BlockedError('ChatGPT grant missing; no fallback authorized')
  const exclusive = refreshMode === 'exclusive' || refreshMode === 'auto' && grant.payload.expires < Date.now()+5*60_000
  if (exclusive) {
    refreshHandoff = await acquireRefreshHandoff({source: join(homedir(), '.fig/.credentials.yaml'), target: credential,
      // The locked DSH install under test (shared/dsh-runtime.js) unless a path is given.
      modules: process.argv.find(arg => arg.startsWith('--dsh-modules='))?.slice(14) ?? (await prepareDshCache(await testedDsh(), { code: fileURLToPath(new URL('..', import.meta.url)) })).folder})
    // The native transaction selected the actual current grant, not the earlier unlocked read.
    records['fig-chatgpt/subscription'] = parse(await readFile(credential, 'utf8')).records['fig-chatgpt/subscription']
    run.manifest.refreshHandoff = refreshHandoff.metadata
    run.manifest.scope = 'synthetic isolated profile; exclusive native grant transfer, real refresh permitted, latest grant returned; no parallel refresher or paid fallback'
  } else {
    if (grant.payload.expires < Date.now()+5*60_000) throw new BlockedError('Access-only credential too near expiry; exclusive refresh mode is available')
    run.manifest.credentialValidUntil = grant.payload.expires
    records['fig-chatgpt/subscription'] = { ...grant, payload: { ...grant.payload, refresh: 'isolated-no-refresh' } }
  }
}
if (provider === 'grok') {
  const proofPath = process.argv.find(arg => arg.startsWith('--grok-isolation='))?.slice(17)
  if (!proofPath) throw new BlockedError('Grok requires a passing --grok-isolation evidence file before a real access copy')
  try {
    const bytes = await readFile(proofPath), proof = JSON.parse(bytes)
    if (proof.status !== 'pass' || proof.mode !== 'native-logout-isolated-storage' || !proof.cli?.syntheticGrantRemoved) throw new Error('unverified')
    const document = JSON.parse(await readFile(join(homedir(), '.grok/auth.json'), 'utf8'))
    const sessions = Object.entries(document).filter(([key, value]) => /^https:\/\/auth\.x\.ai::[\da-f-]+$/i.test(key) && value?.auth_mode === 'oidc')
    if (sessions.length !== 1) throw new Error('ambiguous')
    const [key, value] = sessions[0]
    if (typeof value.key !== 'string' || value.key.startsWith('xai-') || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) < Date.now() + 15 * 60_000) throw new Error('expired')
    const version = JSON.parse(await readFile(join(homedir(), '.grok/version.json'), 'utf8')).version
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || !proof.filesCreated?.includes('bin/grok-' + version)) throw new Error('version changed')
    run.manifest.credentialValidUntil = Date.parse(value.expires_at)
    await mkdir(state.env.GROK_HOME, { recursive: true })
    await writeFile(state.env.GROK_AUTH_PATH, JSON.stringify({ [key]: { auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: value.oidc_client_id,
      key: value.key, expires_at: value.expires_at } }), { mode: 0o600 })
    await writeFile(join(state.env.GROK_HOME, 'version.json'), JSON.stringify({ version }))
    run.manifest.grokIsolationEvidence = { path: proofPath, sha256: createHash('sha256').update(bytes).digest('hex'), cliVersion: version, copiedRefresh: false }
  } catch { throw new BlockedError('Grok isolation proof, CLI version or sufficiently valid access token is unavailable; daily refresh was not used') }
}
await writeFile(credential, JSON.stringify({ version: 1, records, ...apiKeyRef ? { refs } : {} }), { mode: 0o600 })
// A pi-ai API-key provider (Claude) is registered in the daily profile's patch layer; copy only that provider's block
// (its models and key reference name, never a key).
const piProviders = {}
if (provider === 'claude') {
  let block
  try {
    const daily = parse(await readFile(join(homedir(), '.fig/profiles/web/cordis.patch.yml'), 'utf8'))
    block = daily?.find?.(entry => entry?.id === 'llm-pi-ai')?.config?.providers?.anthropic
  } catch {}
  if (!block?.models?.some(model => model.id === route.model) || block.apiKeyEnv !== 'ANTHROPIC_API_KEY')
    throw new BlockedError(`Fig's anthropic provider with ${route.model} is not configured; no other channel is authorized`)
  piProviders.anthropic = block
}
await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  ...Object.keys(piProviders).length ? [{ id: 'llm-pi-ai', config: { providers: piProviders } }] : [],
  { id: 'workspace-controller', config: { documentsDirectory: state.documents } },
  { id: 'goal', config: {defaultMaxGoalRounds: 6} },
  { insert: [{ id: 'handoff-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url)) }] }
]))

const exists = path => access(path).then(() => true, () => false)
const running = pattern => { try { return execFileSync('pgrep', ['-f', pattern]).toString().trim() !== '' } catch { return false } }
await mkdir(join(state.dshHome, 'fig'), { recursive: true })
await mkdir(join(state.dshHome, 'fig/attention'), {recursive: true})
await writeFile(join(state.dshHome, 'fig/attention/preferences.json'), JSON.stringify({schema: 1, notifications: false, dock: false}))
await writeFile(join(state.dshHome, 'fig/next-step.json'), JSON.stringify({ enabled: false }))
  app = await launchFig(state.env)
  page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout: 30_000 })
  const rpc = async (endpoint, payload) => {
    const result = await page.evaluate(async ({ endpoint, payload }) => (await fetch('/handoff-probe/' + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    })).json(), { endpoint, payload })
    assert.ok(result.ok, result.error?.message)
    return result.value
  }
  // A blank Session is listed only after its first message, so the first prompt goes through native followup.
  const session = async (title, first, preset = 'workspace-write') => {
    const created = await rpc('parent', { workspacePath: project, preset, route, title })
    const skills = await rpc('skillInfo', { id: created.id })
    // Besides the synthetic skill, only skills shipped inside the DSH release itself (dsh-doc, office…, from 0.2.2-rc.5) may be
    // visible; anything from the user's own folders breaks isolation.
    const bundled = skill => skill.path ? skill.path.startsWith(dshRuntimeRoot() + '/') && skill.path.includes('/node_modules/@deepseek-ai/')
      : bundledSkillNames().has(skill.name)
    const synthetic = skill => skill.name === 'synthetic-probe' && skill.path?.startsWith(root + '/')
    if (!skills.complete || !skills.skills.some(synthetic) || skills.skills.some(skill => !synthetic(skill) && !bundled(skill)))
      throw new BlockedError('Model-facing skill isolation is not established: ' + JSON.stringify({ complete: skills.complete,
        skills: skills.skills.map(skill => skill.name + (synthetic(skill) ? '' : bundled(skill) ? ' (bundled with DSH)' : ' (outside the synthetic root: ' + String(skill.path).replace(homedir(), '~') + ')')) }))
    run.manifest.isolation = { ...run.manifest.isolation, profile: state.profile, sharedRoot: root, agentsRoot: state.env.DSH_AGENTS_HOME, skills }
    await rpc('followup', { id: created.id, text: first })
    const row = page.getByText(title, { exact: true }).first()
    if (!(await row.isVisible({ timeout: 3_000 }).catch(() => false))) await page.getByText('probe', { exact: true }).first().click()
    await row.click({ timeout: 30_000 }).catch(async error => {
      await safeScreenshot(join(evidence, 'task-loop-setup-failure.png'))
      await writeFile(join(evidence, 'task-loop-setup-failure.txt'), (await page.locator('[data-slot="main.conversation"]').allTextContents()).join('\n'))
      throw error
    })
    return created.id
  }
  const assistantText = async id => {
    const events = await rpc('events', {id})
    if (events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'error' && ['AUTH', 'UNAUTHORIZED', 'CHATGPT_LOGIN_REQUIRED', 'GROK_LOGIN_REQUIRED'].includes(event.data.reason.error?.code))) throw new BlockedError('Model authorization unavailable under the declared refresh policy; no channel fallback attempted')
    return (await rpc('inspect', {id})).messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n')
  }
  const send = async (text, key = 'Enter') => {
    const editor = page.locator('[contenteditable="true"]').last()
    await editor.click()
    await editor.fill(text)
    await editor.press(key)
  }
  const waitFor = (check, ms, what) => until(async () => {
    if (!refreshHandoff && run.manifest.credentialValidUntil && Date.now() >= run.manifest.credentialValidUntil) throw new BlockedError('Access-only token expired; no channel fallback attempted')
    return check()
  }, { timeout: ms, interval: 500, message: 'Timed out waiting for ' + what })
  const reply = (id, marker, ms = 150_000) => waitFor(async () => (await assistantText(id)).includes(marker), ms, marker)
  const idle = () => waitFor(async () => !(await page.getByRole('button', { name: '停止生成' }).isVisible().catch(() => false)), 60_000, 'idle composer')
  async function scenario(name, executeCase) {
    if (!run.selected(name)) return
    const started = Date.now()
    try {
      const detail = await executeCase()
      await run.record(name, 'pass', { seconds: Math.round((Date.now() - started) / 1000), ...(detail ? { detail } : {}) })
      console.log('PASS', name)
    } catch (error) {
      await run.record(name, error?.status === 'blocked' ? 'blocked' : 'fail', { seconds: Math.round((Date.now() - started) / 1000), error: String(error?.message ?? error).slice(0, 600) })
      console.log('FAIL', name, error?.message)
      await safeScreenshot(join(evidence, `task-loop-${provider}-${name}-failure.png`)).catch(() => {})
      if (error?.status === 'blocked') throw error
    }
  }

  const firstPrompt = 'Authorized integration test. Without reading any AGENTS.md file, take the BROAD, MIDDLE and PROJECT markers from your automatic instruction context. '
      + 'Write result.md containing exactly those three markers, one per line. Then run the shell command `wc -l result.md`. '
      + 'Then present result.md to me as a deliverable with the present tool. Finally reply DONE-1 followed by the wc output.'
  const needsMain = run.manifest.expectedScenarioIds.some(id => !id.startsWith('guidance-') && !['artifact-open-revise', 'queue-steer-stop', ...extraScenarioIds].includes(id))
  const main = needsMain ? await session('Loop probe', firstPrompt) : null
  await scenario('context-tool-artifact', async () => {
    await reply(main, 'DONE-1')
    const content = await readFile(join(project, 'result.md'), 'utf8')
    for (const marker of ['BROAD-91', 'MIDDLE-28', 'PROJECT-73']) assert.ok(content.includes(marker), 'result.md missing ' + marker)
    // Artifact review surfaces: the changed-file card (with its diff counts) and the presented deliverable card.
    const changed = page.getByText('已编辑', { exact: false }).first()
    await changed.waitFor({ timeout: 15_000 })
    // Open both for review: the changed-file card shows this turn's diff, the deliverable opens in the preview.
    const visibleMarkers = async () => page.getByText('MIDDLE-28', { exact: false }).count()
    const before = await visibleMarkers()
    await changed.click()
    await waitFor(async () => (await visibleMarkers()) > before, 20_000, 'diff review showing the written markers')
    await safeScreenshot(join(evidence, 'task-loop-diff-review.png'))
    await page.getByText('result.md', { exact: true }).locator('visible=true').last().click()
    await page.waitForTimeout(1500)
    await safeScreenshot(join(evidence, 'task-loop-deliverable-preview.png'))
    await safeScreenshot(join(evidence, 'task-loop-artifact.png'))
    const tools = (await sessionEvents(join(state.dshHome, 'sessions'))).filter(e => e.type === 'tool/call').map(e => e.data.name)
    for (const tool of ['write', 'bash', 'present']) assert.ok(tools.includes(tool), 'model did not call ' + tool + ' (' + tools.join(',') + ')')
    assert.ok(!tools.includes('read'), 'markers must come from automatic context, not file reads')
    return { tools }
  })
  await idle()
  for (const [name, button, file, expectFile] of [['approval-allow', '允许一次', 'allow.txt', true], ['approval-reject', '拒绝', 'reject.txt', false]]) {
    await scenario(name, async () => {
      const target = join(outside, file)
      await send(`Authorized test of the approval prompt. Call the bash tool exactly once with command \`touch ${target}\`, `
        + 'sandbox_permissions "danger-full-access" and justification "approval test". Do not retry or use any other tool. '
        + `Afterwards reply ${name.toUpperCase()}-SEEN and say whether it was approved.`)
      const control = page.getByRole('button', { name: button, exact: true })
      await control.first().waitFor({ timeout: 120_000 })
      await safeScreenshot(join(evidence, `task-loop-${name}.png`))
      await control.first().click()
      await reply(main, name.toUpperCase() + '-SEEN')
      assert.equal(await exists(target), expectFile, expectFile ? 'approved command did not run' : 'rejected command ran anyway')
    })
    await idle()
  }
  await scenario('ask-user', async () => {
    await send('Authorized test. Use the ask_user_question tool once to ask me "Pick a color" with exactly two options: "Red" and "Blue". '
      + 'Then reply COLOR= followed by my answer.')
    const option = page.getByText('Blue', { exact: true })
    await option.first().waitFor({ timeout: 120_000 })
    await safeScreenshot(join(evidence, 'task-loop-question.png'))
    await option.first().click()
    await page.getByRole('button', { name: '提交', exact: true }).first().click({ timeout: 10_000 })
    await reply(main, 'COLOR=')
    assert.match(await assistantText(main), /COLOR=\s*Blue/i)
  })
  await idle()
  await scenario('instruction-update', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Synthetic test workspace. Broad marker BROAD-55 (updated).\n')
    await send('Without reading any files, what is the BROAD marker in your automatic instruction context now? Reply BROAD-NOW= followed by it.')
    await reply(main, 'BROAD-NOW=')
    assert.match(await assistantText(main), /BROAD-NOW=\s*BROAD-55/)
  })
  await idle()
  await scenario('compact-reinject', async () => {
    const before = (await rpc('inspect', { id: main })).messages.length
    await send('/compact')
    await waitFor(async () => (await sessionEvents(join(state.dshHome, 'sessions'))).some(e => /compact/i.test(e.type)), 120_000, 'compaction event')
    await idle()
    const after = await rpc('inspect', { id: main })
    await send('Without reading any files, list the BROAD, MIDDLE and PROJECT markers from your automatic instruction context. Reply MARKERS= followed by them.')
    await reply(main, 'MARKERS=')
    const text = await assistantText(main)
    const line = text.slice(text.lastIndexOf('MARKERS='))
    for (const marker of ['BROAD-55', 'MIDDLE-28', 'PROJECT-73']) assert.ok(line.includes(marker), 'after compaction missing ' + marker + ': ' + line.slice(0, 200))
    const sources = (await rpc('inspect', { id: main })).messages.map(m => m.source)
    return { messagesBefore: before, messagesAfterCompact: after.messages.length, injectedSources: sources.filter(s => /instructions/.test(s ?? '')) }
  })
  await idle()
  await scenario('stop', async () => {
    await send('Authorized test. Run the shell command `sleep 47` in the foreground (not as a background job), then reply SLEPT.')
    await waitFor(async () => running('sleep 47'), 120_000, 'sleep 47 to start')
    const started = Date.now()
    await page.getByRole('button', { name: '停止生成' }).click()
    await waitFor(async () => !running('sleep 47'), 15_000, 'sleep process to end after stop')
    await idle()
    assert.ok(!(await assistantText(main)).includes('SLEPT'), 'turn continued after stop')
    return { stopSeconds: Math.round((Date.now() - started) / 100) / 10 }
  })
  await idle()
  await scenario('handoff-background-approval', async () => {
    const target = join(outside, 'background.txt')
    await send('Authorized test. Call handoff_session once with title "Bg approval" and this prompt: '
      + `"Authorized test. Call the bash tool once with command \`touch ${target}\`, sandbox_permissions danger-full-access and justification approval test; then reply BG-DONE." `
      + 'Then reply HANDED-OFF.')
    await reply(main, 'HANDED-OFF')
    await page.getByText(/等待审批|待审批/).first().waitFor({ timeout: 120_000 })
    await safeScreenshot(join(evidence, 'task-loop-background-approval.png'))
    await page.getByText('Bg approval', { exact: true }).first().click()
    await page.getByRole('button', { name: '允许一次', exact: true }).first().click({ timeout: 30_000 })
    await waitFor(() => exists(target), 120_000, 'approved background command')
  })
  await scenario('subagent', async () => {
    await page.getByText('Loop probe', { exact: true }).first().click() // the previous scenario left the handed-off session open
    await idle()
    await send('Authorized test. Use the subagent tool to start exactly one subagent with the task: "Read AGENTS.md in the current directory and return only the PROJECT marker." '
      + 'Wait for its result, then reply SUB= followed by the marker it returned.')
    await waitFor(async () => /SUB=\s*PROJECT-73/.test(await assistantText(main)), 150_000, 'native subagent result, not its announced placeholder')
    assert.match(await assistantText(main), /SUB=\s*PROJECT-73/)
    const tools = (await sessionEvents(join(state.dshHome, 'sessions'))).filter(e => e.type === 'tool/call').map(e => e.data.name)
    assert.ok(tools.includes('subagent'), 'model did not call subagent')
  })
  await idle()
  await scenario('goal', async () => {
    await writeFile(join(project, 'goal-check.mjs'), "import{readFileSync}from'node:fs';const s=readFileSync('goal-value.txt','utf8').trim();if(s!=='CORRECT'){console.error('SYNTHETIC-KNOWN-FAILURE');process.exit(7)}console.log('SYNTHETIC-TEST-PASS')\n")
    const before = (await rpc('events', {id: main})).at(-1)?.seq ?? -1, started = Date.now()
    await send('/goal Authorized bounded synthetic three-step goal in this task directory only: (1) generate goal-value.txt containing WRONG; (2) run exactly `node goal-check.mjs` and observe the expected known failure; (3) change only goal-value.txt to CORRECT, run exactly `node goal-check.mjs` again and observe SYNTHETIC-TEST-PASS, then write goal.txt containing GOAL-OK. Do not edit goal-check.mjs. Mark the goal complete only after the successful real test. Maximum six continuation rounds or five minutes; report the actual tests and stop. No other task.')
    let events, goal, stopReason
    try {
      for (;;) {
        events = (await rpc('events', {id: main})).filter(e => e.seq > before)
        const rounds = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'goal').length
        goal = await rpc('goalState', {id: main})
        if (rounds > 6 || Date.now()-started >= 300000) {stopReason = 'fixture-bound'; throw new BlockedError('Bounded goal stopped; six rounds/five minutes is not evidence of long-term stability')}
        const authFailure = events.find(e => e.type === 'turn/end' && e.data.reason?.kind === 'error' && /AUTH|LOGIN_REQUIRED/.test(e.data.reason.error?.code ?? ''))
        if (authFailure) throw new BlockedError('Goal model authorization unavailable; no refresh or fallback used')
        if (goal?.phase === 'complete' && !(await rpc('state', {id: main})).running) {stopReason = 'native-goal-complete'; break}
        if (['blocked','paused'].includes(goal?.phase)) {stopReason = 'native-'+goal.phase; throw new BlockedError('Native goal stopped before the evidence target: '+goal.phase)}
        await delay(200)
      }
    } finally {
      if (stopReason !== 'native-goal-complete') {await rpc('goalState', {id: main, disarm: true}); await rpc('cancel', {id: main})}
      await writeFile(join(evidence, 'bounded-goal-observation.json'), JSON.stringify({scope:'Three synthetic steps only; not a long-term stability claim', bounds:{continuationRounds:6,milliseconds:300000}, elapsedMs:Date.now()-started, stopReason:stopReason??'fixture-error', goal, events},null,2))
    }
    assert.equal((await readFile(join(project, 'goal-value.txt'),'utf8')).trim(),'CORRECT')
    assert.match(await readFile(join(project,'goal.txt'),'utf8'),/GOAL-OK/)
    assert.equal(await readFile(join(project,'goal-check.mjs'),'utf8'), "import{readFileSync}from'node:fs';const s=readFileSync('goal-value.txt','utf8').trim();if(s!=='CORRECT'){console.error('SYNTHETIC-KNOWN-FAILURE');process.exit(7)}console.log('SYNTHETIC-TEST-PASS')\n")
    const bashCalls = events.filter(e => e.type === 'tool/call' && e.data.name === 'bash')
    assert.ok(bashCalls.filter(e => e.data.arguments.includes('node goal-check.mjs')).length >= 2, 'Both actual test runs must exist')
    const outputs = events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data)).join('\n')
    assert.match(outputs,/SYNTHETIC-KNOWN-FAILURE/); assert.match(outputs,/SYNTHETIC-TEST-PASS/)
    assert.ok(events.some(e => e.type === 'tool/call' && e.data.name === 'update_goal'))
    await safeScreenshot(join(evidence, `task-loop-${provider}-goal.png`))
    return {stopReason, continuationRounds:events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'goal').length, elapsedMs:Date.now()-started, fileAndTestEvidence:true, longTermStability:'not covered'}
  })
  await idle()
  await scenario('plan-review', async () => {
    const plan = await session('Plan probe', 'Reply READY.')
    await reply(plan, 'READY')
    await idle()
    await send('/plan Authorized test: plan to create plan.txt containing PLAN-OK. Keep the plan to two lines, then ask me to review it.')
    const approve = page.getByRole('button', { name: '同意执行', exact: true })
    await approve.first().waitFor({ timeout: 150_000 })
    await safeScreenshot(join(evidence, 'task-loop-plan.png'))
    await approve.first().click()
    await waitFor(async () => (await readFile(join(project, 'plan.txt'), 'utf8').catch(() => '')).includes('PLAN-OK'), 150_000, 'plan.txt after approval')
    return { session: plan }
  })
  await scenario('artifact-open-revise', async () => {
    const md = join(project, 'artifact-note-a9.md'), html = join(project, 'artifact-view-k4.html')
    const id = await session('Artifact revisions', `Authorized task. Create exactly two small deliverables: ${md} containing a heading NOTE-A9, a paragraph MD-KEEP-A9 and a paragraph MD-V1-Z7; `
      + `${html} as a self-contained HTML page with a visible heading VIEW-K4, paragraph HTML-KEEP-K4 and paragraph HTML-V1-J2. Present both files exactly once with the present tool. Finish with ARTIFACT-READY.`)
    await reply(id, 'ARTIFACT-READY'); await idle()
    const open = async (path, marker, previous) => {
      const button = page.getByTitle(path, { exact: true }).and(page.locator('[data-presented-file] button'))
      assert.equal(await button.count(), 1, 'must uniquely identify the original deliverable by absolute path')
      await button.click()
      const scope = path.endsWith('.md') ? page.locator('[data-document-markdown]') : page.frameLocator('iframe[data-html-preview]')
      await scope.getByText(marker, { exact: true }).waitFor({ timeout: 20_000 })
      if (previous) assert.equal(await scope.getByText(previous, { exact: true }).count(), 0, 'reopened preview must not retain the old version')
      return { path, marker, carrier: path.endsWith('.md') ? 'native markdown' : 'native HTML iframe' }
    }
    const initial = [await open(md, 'MD-V1-Z7'), await open(html, 'HTML-V1-J2')]
    await safeScreenshot(join(evidence, 'artifact-original.png'))
    await send(`Authorized revision. In ${md} replace only MD-V1-Z7 with MD-V2-Z7; in ${html} replace only HTML-V1-J2 with HTML-V2-J2. Preserve every other paragraph. Do not present new cards. Finish with ARTIFACT-REVISED.`)
    await reply(id, 'ARTIFACT-REVISED'); await idle()
    const contents = [await readFile(md, 'utf8'), await readFile(html, 'utf8')]
    for (const [index, keep, current, old] of [[0, 'MD-KEEP-A9', 'MD-V2-Z7', 'MD-V1-Z7'], [1, 'HTML-KEEP-K4', 'HTML-V2-J2', 'HTML-V1-J2']]) {
      assert.ok(contents[index].includes(keep) && contents[index].includes(current) && !contents[index].includes(old))
    }
    const revised = [await open(md, 'MD-V2-Z7', 'MD-V1-Z7'), await open(html, 'HTML-V2-J2', 'HTML-V1-J2')]
    await safeScreenshot(join(evidence, 'artifact-revised.png'))
    await writeFile(join(evidence, 'artifact-revisions.json'), JSON.stringify({ sessionId: id, initial, revised, contents, events: await rpc('events', { id }) }, null, 2))
    return { sessionId: id, initial, revised }
  })
  await scenario('queue-steer-stop', async () => {
    const started = join(project, 'queue-started.txt')
    const command = `printf READY > '${started.replaceAll("'", "'\\''")}'; sleep 15`
    const id = await session('Queue control', `Authorized task. Run bash command \`${command}\` in the foreground. Then reply BASE-DONE and include any acknowledgement markers received in later messages.`)
    await waitFor(() => exists(started), 120_000, 'controlled slow tool')
    await send('Please include QUEUE-ACK in your reply.')
    let queued
    await waitFor(async () => { queued = (await rpc('state', { id })).queue?.find(item => JSON.stringify(item.content).includes('QUEUE-ACK')); return !!queued }, 5000, 'Enter queue receipt')
    assert.equal(queued.placement, 'queued')
    await rpc('prompt', { id, requestId: queued.rpcId, mode: 'queue', content: queued.content })
    assert.equal((await rpc('state', { id })).queue.filter(item => item.rpcId === queued.rpcId).length, 1, 'same request retry must not duplicate')
    const editor = page.locator('[contenteditable="true"]').last()
    await editor.fill('Please include STEER-ACK in your reply.')
    await editor.press('Shift+Enter')
    assert.match(await editor.innerText(), /STEER-ACK/)
    await editor.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    let steered
    await waitFor(async () => { steered = (await rpc('state', { id })).queue?.find(item => JSON.stringify(item.content).includes('STEER-ACK')); return !!steered }, 5000, 'accelerated steering receipt')
    assert.equal(steered.placement, 'steering')
    const removeRequest = 'remove-' + Date.now()
    await rpc('prompt', { id, requestId: removeRequest, mode: 'queue', content: [{ type: 'text', text: 'REMOVE-ME' }] })
    const removable = (await rpc('state', { id })).queue.find(item => item.rpcId === removeRequest)
    await rpc('updateQueue', { id, itemId: removable.id, action: { kind: 'remove' } })
    assert.ok(!(await rpc('state', { id })).queue.some(item => item.id === removable.id))
    await reply(id, 'STEER-ACK'); await reply(id, 'QUEUE-ACK'); await idle()
    await assert.rejects(rpc('updateQueue', { id, itemId: queued.id, action: { kind: 'remove' } }), /queue-item-not-found|not found|no longer pending|不存在/)
    const stopStarted = join(project, 'stop-started.txt')
    await send(`Authorized task. Run bash \`printf READY > '${stopStarted}'; sleep 30\` in foreground, then reply SHOULD-NOT-FINISH.`)
    await waitFor(() => exists(stopStarted), 120_000, 'stop slow tool')
    const stoppedTurn = (await rpc('events', { id })).findLast(event => event.type === 'turn/start').data.turn
    await send('Authorized follow-up. Reply AFTER-STOP-QUEUED.')
    let beforeStop
    await waitFor(async () => { beforeStop = await rpc('state', { id }); return beforeStop.queue?.some(item => JSON.stringify(item.content).includes('AFTER-STOP-QUEUED')) }, 5000, 'stop queued message acceptance')
    await page.getByRole('button', { name: '停止生成' }).click()
    const afterStop = await rpc('state', { id })
    await idle()
    const settled = await rpc('state', { id })
    const retained = settled.queue?.some(item => JSON.stringify(item.content).includes('AFTER-STOP-QUEUED'))
    if (retained) await send('Continue the retained queued follow-up, including its acknowledgement marker.')
    await reply(id, 'AFTER-STOP-QUEUED'); await idle()
    const events = await rpc('events', { id })
    const stoppedEnd = events.find(event => event.type === 'turn/end' && event.data.turn === stoppedTurn)
    assert.equal(stoppedEnd?.data.reason.kind, 'aborted', 'the stopped native turn must have an aborted end reason')
    await writeFile(join(evidence, 'queue-control.json'), JSON.stringify({ sessionId: id, queued, steered, beforeStop, afterStop, settled, explicitlyResumed: retained, stoppedTurn, stoppedEnd, events }, null, 2))
    return { sessionId: id, stoppedRound: true, queuedMessageContinued: true, explicitlyResumed: retained }
  })
  for (const variant of ['off', 'on']) {
    await scenario('guidance-page-selfcheck:' + variant, async () => {
      await rpc('guidance', { enabled: variant === 'on' })
      const target = join(project, 'guidance.html')
      await writeFile(target, '<!doctype html><meta name="viewport" content="width=device-width"><title>Signal</title><h1>SIGNAL-CARD</h1><div style="width:720px">Synthetic status</div>')
      const id = await session('Guidance page ' + variant,
        'Authorized task. Finish the existing guidance.html as a simple status card. Keep the heading SIGNAL-CARD and add the status "Ready". Deliver the finished file and briefly report what you did. End with PAGE-DONE.')
      await reply(id, 'PAGE-DONE')
      await idle()
      const output = (await rpc('inspect', { id })).messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
      const events = await rpc('events', { id })
      const previewCalls = events.filter(e => e.type === 'tool/call' && e.data.name === 'preview')
      const diagnostics = events.filter(e => e.type === 'tool/result' && JSON.stringify(e.data).includes('Preview of '))
      const correlated = guidanceDiagnostics(output, events)
      const detail = { sessionId: id, variant, ...correlated,
        realPathReported: output.includes(target) || /\bguidance\.html\b/.test(output), narrowReported: /390|窄屏|移动|narrow|mobile/i.test(output),
        boundaryReported: /交互|interactiv|未验证|未测|not (?:verified|tested)|静态|static|渲染|render/i.test(output) }
      assert.match(await readFile(target, 'utf8'), /SIGNAL-CARD/)
      await writeFile(join(evidence, 'guidance-page-' + variant + '.json'), JSON.stringify({ detail, output, events, pathResolution: { cwd: project, relative: 'guidance.html', absolute: target } }, null, 2))
      if (variant === 'on') {
        assert.ok(previewCalls.length > 0 && diagnostics.length > 0, 'ON must actually execute preview and receive diagnostics')
        assert.ok(correlated.narrowObserved, 'must receive the narrow viewport diagnostic for this preview call')
        for (const key of ['realPathReported', 'narrowReported', 'diagnosticReferenced', 'boundaryReported']) assert.ok(detail[key], key + ' missing in final response')
        assert.ok(!events.some(e => e.type === 'tool/call' && e.data.name === 'ask_user_question'), 'authorized task must not ask again')
      }
      await safeScreenshot(join(evidence, 'guidance-page-' + variant + '.png'))
      return detail
    })
    await scenario('guidance-plain-qa:' + variant, async () => {
      await rpc('guidance', { enabled: variant === 'on' })
      const id = await session('Guidance QA ' + variant, 'What is 19 + 23? Answer briefly.')
      await reply(id, '42')
      await idle()
      const output = await assistantText(id)
      const events = await rpc('events', { id })
      const calls = events.filter(e => e.type === 'tool/call').map(e => e.data.name)
      const emptyColumns = /(?:已完成|已验证|未验证|需用户决定|Completed|Verified|Unverified)[:：]?\s*(?:无|none|N\/A|[-—])\s*$/im.test(output)
      if (variant === 'on') {
        assert.deepEqual(calls, [], 'plain QA must not call preview, goal, ask-user or other tools')
        assert.equal(emptyColumns, false)
      }
      await writeFile(join(evidence, 'guidance-qa-' + variant + '.json'), JSON.stringify({ sessionId: id, output, calls, emptyColumns, events }, null, 2))
      return { sessionId: id, variant, calls, emptyColumns }
    })
  }
  await rpc('guidance', { enabled: true })

  // Launch-gate checks outside the 17 (--only=web-search,goal-controls,keep-awake,side-chat-forward).
  await scenario('web-search', async () => {
    const id = await session('Web search', 'Authorized test. Use web search once to find one technology news headline published today. '
      + 'Reply SEARCH-DONE, then the headline, then at least one source URL from the search results.')
    await reply(id, 'SEARCH-DONE', 240_000); await idle()
    const events = await rpc('events', { id }), text = await assistantText(id)
    const calls = events.filter(e => e.type === 'tool/call').map(e => e.data.name)
    const urls = [...new Set(text.match(/https?:\/\/[^\s)\]>"'`]+/g) ?? [])]
    await writeFile(join(evidence, `web-search-${provider}.json`), JSON.stringify({ sessionId: id, route, calls, urls, text, events }, null, 2))
    await safeScreenshot(join(evidence, `web-search-${provider}.png`))
    assert.ok(calls.includes('web_search'), 'the model did not call web_search (' + calls.join(',') + ')')
    const results = events.filter(e => e.type === 'tool/result' && /https?:\/\//.test(JSON.stringify(e.data))).length
    assert.ok(results > 0, 'web_search returned no linked results')
    assert.ok(urls.length > 0, 'the reply cites no source URL')
    return { calls, urls: urls.slice(0, 5), linkedResults: results }
  })
  await scenario('goal-controls', async () => {
    const id = await session('Goal controls', 'Reply READY.')
    await reply(id, 'READY'); await idle()
    await send('/goal Authorized synthetic goal in this task directory only: create step-1.txt, step-2.txt and step-3.txt, one per round, '
      + 'and run `sleep 20` in the foreground before each file. Mark the goal complete after step-3.txt exists. No other task.')
    const state = () => rpc('goalState', { id })
    const button = name => page.getByRole('button', { name, exact: true }).first()
    try {
      await waitFor(async () => (await state())?.phase === 'active', 120_000, 'an active goal')
      await button('暂停目标').click({ timeout: 30_000 })
      await waitFor(async () => (await state())?.phase === 'paused', 30_000, 'the paused goal')
      await page.getByText('已暂停的目标').first().waitFor({ timeout: 10_000 })
      await safeScreenshot(join(evidence, 'goal-paused.png'))
      const edited = 'Authorized synthetic goal in this task directory only: create step-1.txt and step-2.txt, one per round. EDITED-GOAL-K5. No other task.'
      await button('编辑目标').click({ timeout: 10_000 })
      const field = page.getByRole('textbox', { name: '目标内容' }).first()
      await field.waitFor({ timeout: 10_000 })
      await field.fill(edited)
      await button('保存目标').click({ timeout: 10_000 })
      await waitFor(async () => (await state())?.objective?.includes('EDITED-GOAL-K5'), 20_000, 'the edited objective')
      const pausedAfterEdit = (await state())?.phase
      await safeScreenshot(join(evidence, 'goal-edited.png'))
      await button('恢复目标').click({ timeout: 10_000 })
      await waitFor(async () => (await state())?.phase === 'active', 20_000, 'the resumed goal')
      await safeScreenshot(join(evidence, 'goal-resumed.png'))
      await button('清除目标').click({ timeout: 10_000 })
      await waitFor(async () => !(await state()), 20_000, 'the cleared goal')
      return { pausedAfterEdit, objective: edited }
    } finally {
      if (await state().catch(() => null)) await rpc('goalState', { id, disarm: true }).catch(() => {})
      await rpc('cancel', { id }).catch(() => {})
      await idle().catch(() => {})
    }
  })
  await scenario('keep-awake', async () => {
    const pid = app.process().pid
    // Electron's prevent-app-suspension holds an idle-sleep assertion (pmset lists it as NoIdleSleepAssertion or PreventUserIdleSystemSleep).
    const assertions = () => execFileSync('pmset', ['-g', 'assertions']).toString()
    const held = () => assertions().split('\n').filter(line => line.includes(`pid ${pid}(`) && /NoIdleSleep|PreventUserIdleSystemSleep|PreventSystemSleep/.test(line))
    await waitFor(async () => held().length === 0, 30_000, 'no sleep assertion while nothing runs')
    const id = await session('Keep awake', 'Authorized test. Run the shell command `sleep 25` in the foreground, then reply AWAKE-DONE.')
    await waitFor(async () => running('sleep 25'), 120_000, 'sleep 25 to start')
    await waitFor(async () => held().length > 0, 20_000, 'a sleep assertion while the session runs')
      .catch(async error => { await writeFile(join(evidence, 'keep-awake-pmset.txt'), `pid ${pid}\n` + assertions()); throw error })
    const during = held().map(line => line.trim())
    await reply(id, 'AWAKE-DONE'); await idle()
    await waitFor(async () => held().length === 0, 30_000, 'the sleep assertion released after the turn')
    await writeFile(join(evidence, 'keep-awake.json'), JSON.stringify({ pid, during, releasedAfterTurn: true }, null, 2))
    return { pid, during }
  })
  await scenario('side-chat-forward', async () => {
    const id = await session('Side forward', 'Authorized test. Run the shell command `sleep 45` in the foreground, then reply FORWARD-MAIN-DONE.')
    await waitFor(async () => running('sleep 45'), 120_000, 'the main Session busy')
    await page.locator('[contenteditable="true"]').last().click()
    await page.keyboard.press('Alt+Meta+KeyS')
    const side = page.locator('[data-fig-side-chat]')
    await side.waitFor({ timeout: 30_000 })
    await side.locator('[data-lexical-editor="true"]').first().click()
    await page.keyboard.type('Reply with exactly two lines and nothing else. Line 1: 给主会话： Line 2: FORWARD-NOTE-Q8')
    await page.keyboard.press('Enter')
    await side.getByText('FORWARD-NOTE-Q8').last().waitFor({ timeout: 180_000 })
    assert.ok(running('sleep 45'), 'the main Session must still be running when the forward is tried')
    await side.locator('[data-fig-send-main]').last().click()
    const box = page.locator('[data-fig-send-box] textarea').last()
    await box.waitFor({ timeout: 20_000 })
    const draft = await box.inputValue()
    await page.locator('[data-fig-send-confirm]').last().click()
    await page.getByText('主会话正在运行，空闲后再发。').first().waitFor({ timeout: 20_000 })
    assert.equal(await box.inputValue(), draft, 'the refused draft stays in the box')
    await safeScreenshot(join(evidence, 'side-forward-refused.png'))
    const before = (await rpc('inspect', { id })).messages.filter(m => m.role === 'user' && m.text?.includes('FORWARD-NOTE-Q8')).length
    assert.equal(before, 0, 'nothing reached the running main Session')
    await reply(id, 'FORWARD-MAIN-DONE', 180_000)
    await waitFor(async () => !(await rpc('state', { id })).running, 60_000, 'the main Session idle')
    await page.locator('[data-fig-send-confirm]').last().click()
    await side.getByText('已发到主会话').last().waitFor({ timeout: 20_000 })
    await waitFor(async () => (await rpc('inspect', { id })).messages.some(m => m.role === 'user' && m.text?.includes('FORWARD-NOTE-Q8')), 30_000, 'the forwarded note in the main Session')
    await safeScreenshot(join(evidence, 'side-forward-sent.png'))
    return { draft: draft.trim(), refusedWhileRunning: true, sentWhenIdle: true }
  })
} catch (error) { fatal = error; console.error(error.message) } finally {
  await finishRun(fatal)
}
console.log(JSON.stringify(results, null, 1))
console.log('Evidence:', evidence)
