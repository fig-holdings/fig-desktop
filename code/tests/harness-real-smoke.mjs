import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { figCommand } from '../scripts/isolated-fig.mjs'
import { resolveLaunchProxy } from '../harness/environment.ts'
import { dshLauncher, testedDsh } from './helpers/dsh-launcher.mjs'
import { sessionEvents } from './helpers/session-events.mjs'

if (!process.argv.includes('--real')) throw new Error('Pass --real: calls real subscription models using isolated credentials.')
// --evidence=<dir> keeps a run's record apart from earlier ones.
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11) ?? fileURLToPath(new URL('../../work/verification/harness-audit/', import.meta.url))
await mkdir(evidence, { recursive: true })
const built = fileURLToPath(new URL('../../work/build/main/', import.meta.url))
const launcher = await dshLauncher(await testedDsh())
assert.ok(launcher, 'Build Fig once to cache the verified DSH')
const stored = parse(await readFile(join(homedir(), '.fig/.credentials.yaml'), 'utf8'))
// Never rotate the production ChatGPT grant from an isolated copy.
if (stored.records?.['fig-chatgpt/subscription']?.payload) stored.records['fig-chatgpt/subscription'].payload.refresh = 'isolated-no-refresh'
const capture = await figCommand()
const routes = {
  chatgpt: { provider: 'fig-chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'low' },
  grok: { provider: 'fig-grok-oauth', model: 'grok-4.7', reasoningEffort: 'low' },
  deepseek: { provider: 'deepseek-account', model: 'deepseek-flash' }
}
const chosen = process.argv.find(arg => arg.startsWith('--provider='))?.slice(11)
if (chosen && !routes[chosen]) throw new Error('Unknown --provider')
for (const [label, route] of Object.entries(routes).filter(([label]) => !chosen || label === chosen)) {
  const profile = await mkdtemp(join(tmpdir(), 'fig-harness-real-'))
  const home = join(profile, 'dsh'), root = join(profile, 'workspace'), project = join(root, 'projects/probe')
  let passed = false
  try {
    await mkdir(home)
    await mkdir(join(profile, 'agents'))
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(root, 'resources/skills/audit-probe'), { recursive: true })
    await writeFile(join(home, '.credentials.yaml'), JSON.stringify(stored), { mode: 0o600 })
    await writeFile(join(root, 'AGENTS.md'), 'Synthetic harness test. Broad marker BROAD-91. Work only in this test project.\n')
    await writeFile(join(root, 'projects/AGENTS.md'), 'Synthetic harness test. Middle marker MIDDLE-28.\n')
    await writeFile(join(project, 'AGENTS.md'), 'Synthetic harness test. Project marker PROJECT-73.\n')
    await writeFile(join(root, 'resources/skills/audit-probe/SKILL.md'), '---\nname: audit-probe\ndescription: Harness test procedure\n---\nSkill marker SKILL-46.\n')
    await writeFile(join(project, 'seed.txt'), 'SEED-62')
    await writeFile(join(project, 'page.html'), '<!doctype html><meta name="viewport" content="width=device-width"><title>Harness</title><h1>Harness probe</h1>')
    const patch = join(profile, 'model.patch.yml')
    await writeFile(patch, JSON.stringify([
      ...['credentials', 'authorization', 'deepseek-account'].map(id => ({ id, disabled: false })),
      { id: 'agent-default-model', config: route }
    ]))
    // The packages a headless session needs for these models and tools. Their settings are config rows, as Fig writes
    // them (app/main/plugin-config.ts). Handoff needs DSH Web's Session Controller, so it is not exercised here.
    const packages = ['provider-grok', 'provider-chatgpt', 'shell-bridge', 'preview', 'skills-dir', 'instructions', 'delegate'].map(plugin => join(built, plugin, 'cordis.patch.yml'))
    const config = join(profile, 'config.patch.yml')
    await writeFile(config, JSON.stringify([{ id: 'fig-instructions', config: { startupDirectory: root } }, { id: 'fig-skills', config: { directory: join(root, 'resources/skills') } },
      { id: 'fig-shell-bridge', config: { renderer: capture } }]))
    const args = [launcher, '--profile', 'headless', ...[...packages, patch, config].flatMap(path => ['--patch', path]),
      '--permission-mode', 'workspace-write', '--json', '-']
    const prompt = 'This is an authorized integration smoke test. Use skill audit-probe and read seed.txt. '
      + 'From AUTOMATIC instruction context (do not read AGENTS files), get the BROAD, MIDDLE and PROJECT markers. '
      + 'Write parent.txt with those three markers plus the seed and skill markers. Use preview on page.html at widths 390 and 1440. '
      + (label === 'chatgpt' ? 'Use read_image on one screenshot to check it visually. ' : '')
      + 'Do not use other tools except what is needed above. Final reply HARNESS-PARENT-OK.'
    const env = { ...await resolveLaunchProxy(process.env), DSH_HOME: home, DSH_AGENTS_HOME: join(profile, 'agents'), NO_COLOR: '1' }
    delete env.DEEPSEEK_API_KEY
    delete env.DEEPSEEK_BASE_URL
    const started = Date.now()
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: project, env })
      let out = '', err = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('Parent model timed out after 240s')) }, 240_000)
      child.on('error', reject)
      child.stdout.on('data', bytes => { out += bytes })
      child.stderr.on('data', bytes => { err += bytes })
      child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }) })
      child.stdin.end(prompt)
    })
    await writeFile(join(evidence, label + '-parent.jsonl'), output.out)
    await writeFile(join(evidence, label + '-parent.err'), output.err)
    assert.equal(output.code, 0, `${label} parent failed; inspect saved diagnostic`)
    const expected = ['BROAD-91', 'MIDDLE-28', 'PROJECT-73', 'SEED-62', 'SKILL-46']
    const parent = await readFile(join(project, 'parent.txt'), 'utf8')
    for (const marker of expected) assert.ok(parent.includes(marker), label + ' parent missing ' + marker)
    const parentEvents = output.out.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    assert.ok(!parentEvents.some(event => event.type === 'tool_result' && event.status === 'error'), 'Parent tools must succeed')
    const events = await sessionEvents(join(home, 'sessions'))
    const requestRoutes = events.filter(event => event.type === 'request/header').map(event => event.data.header.config)
    assert.ok(requestRoutes.length >= 1 && requestRoutes.every(config => config.provider === route.provider && config.model === route.model), 'The session must keep the selected provider/model')
    const tools = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    for (const tool of ['skill', 'read', 'preview', 'write']) assert.ok(tools.includes(tool), 'Parent missing ' + tool)
    if (label === 'chatgpt') assert.ok(tools.includes('read_image'), 'ChatGPT must actually read a screenshot')
    const summary = { provider: route.provider, model: route.model, elapsedSeconds: Math.round((Date.now() - started) / 1000),
      parentMarkers: expected.every(marker => parent.includes(marker)),
      toolCalls: tools, routes: [...new Set(requestRoutes.map(config => config.provider + '/' + config.model))] }
    await writeFile(join(evidence, label + '-result.json'), JSON.stringify(summary, null, 2))
    console.log('PASS:', JSON.stringify(summary))
    passed = true
  } finally {
    await rm(join(home, '.credentials.yaml'), { force: true })
    if (passed) await rm(profile, { recursive: true, force: true })
    else console.error('Isolated failure data (credential removed):', profile)
  }
}
