import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { figPlugins } from '../harness/plugins.ts'
import { dshLauncher, testedDsh } from './helpers/dsh-launcher.mjs'

// Each package alone in official DSH: the headless profile, the
// package's own patch, and the config a deployment would give it — no Fig shell, no other Fig package. It passes when
// DSH boots, starts a session and reports no entry of the package as failed to activate. The model address is closed on
// purpose: the turn fails after startup, so no credentials or model calls are involved. Needs a build (npm run build).
// An entry may wait for a service only the Web profile provides (task activity needs the Session Controller): that is
// the feature staying off where it has nothing to show, reported as such rather than as a failure.
const webOnly = new Set(['sessionController', 'workspaceRegistry', 'webServer', 'connection'])
// DSH rows a package needs beyond its own, as a deployment would enable them: the headless profile turns DSH's
// credential store off, and the ChatGPT subscription signs in through it (the handoff child enables it the same way).
const needs = { 'fig-chatgpt-provider': ['credentials', 'authorization'].map(id => ({ id, disabled: false })) }
const built = fileURLToPath(new URL('../../work/build/main/', import.meta.url))
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
  ?? fileURLToPath(new URL('../../work/verification/distribution-step1/standalone/', import.meta.url))
await mkdir(evidence, { recursive: true })
const version = await testedDsh()
const launcher = await dshLauncher(version)
if (!launcher) throw new Error(`DSH ${version} is not in Fig's npx cache; build Fig with it first`)

const root = await mkdtemp(join(tmpdir(), 'fig-standalone-'))
const skills = join(root, 'skills')
await mkdir(skills)
// The config each package reads; packages not listed take none.
const configs = {
  'fig-instructions': { startupDirectory: root },
  'fig-rule-sources': { startupDirectory: root },
  'fig-desktop-skin': { startupDirectory: root },
  'fig-skills': { directory: skills },
  'fig-shell-bridge': { renderer: { executable: process.execPath, args: [] } }
}

function run(args, env, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.stdout.on('data', bytes => { out += bytes })
    child.stderr.on('data', bytes => { err += bytes })
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }) })
    child.stdin.end('Reply OK.\n')
  })
}

const rows = []
try {
  for (const plugin of figPlugins) {
    const home = join(root, plugin.name, 'home'), work = join(root, plugin.name, 'work')
    await mkdir(home, { recursive: true }); await mkdir(work, { recursive: true })
    const patch = join(built, plugin.name, 'cordis.patch.yml')
    const ids = parse(await readFile(patch, 'utf8')).flatMap(row => row.insert?.map(entry => entry.id) ?? [])
    const config = join(root, plugin.name, 'config.patch.yml')
    await writeFile(config, JSON.stringify([...needs[plugin.id] ?? [], ...configs[plugin.id] ? [{ id: plugin.id, config: configs[plugin.id] }] : []]))
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
      DEEPSEEK_API_KEY: 'standalone-probe', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1' }
    const { code, out, err } = await run([launcher, '--profile', 'headless', '--patch', patch, '--patch', config, '--json', '-'], env, work)
    const session = out.split('\n').some(line => { try { return JSON.parse(line).type === 'session' } catch { return false } })
    const lines = err.split('\n')
    const reported = ids.flatMap(id => lines.filter(line => line.startsWith(id + ' (') || line.startsWith(id + ':')).map(line => ({ id, line })))
    // `<id> (<url>): pending (waiting for services: a, b)` is a wait; anything else is a failure.
    const waits = reported.map(({ id, line }) => ({ id, services: /pending \(waiting for services?: ([^)]+)\)/.exec(line)?.[1].split(/,\s*/) }))
    const failed = waits.filter(item => !item.services || item.services.some(service => !webOnly.has(service))).map(item => item.id)
    const webWaits = [...new Set(waits.filter(item => item.services && !failed.includes(item.id)).flatMap(item => item.services))]
    const inactive = (err.match(/(\d+) entr(?:y|ies) did not activate/)?.[1] ?? '0') !== String(reported.length) ? 'an entry outside this package did not activate' : ''
    const row = { name: plugin.name, package: JSON.parse(await readFile(join(built, plugin.name, 'package.json'), 'utf8')).name, ids, exit: code, session, failed, webWaits, inactive,
      passed: session && failed.length === 0 && !inactive }
    if (!row.passed) row.stderr = err.split('\n').filter(line => !/SOCKS|TRANSPORT/.test(line)).slice(0, 20).join('\n')
    rows.push(row)
    console.log(`${row.passed ? 'PASS' : 'FAIL'} ${row.package}${webWaits.length ? ' (waits for the Web profile: ' + webWaits.join(', ') + ')' : ''}${row.passed ? '' : '\n' + row.stderr}`)
  }
} finally {
  const passed = rows.length === figPlugins.length && rows.every(row => row.passed)
  const yes = value => value ? '是' : '否'
  const report = [`### 单包加载（DSH ${version}，headless）`, '', `结果：${passed ? '通过' : '未通过'}。每个包单独装进官方 DSH，只带它自己的 patch 和配置。`, '',
    '| 包 | 插入 id | 会话启动 | 激活失败 | 说明 |', '| --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.package} | ${row.ids.join(', ')} | ${yes(row.session)} | ${row.failed.length || row.inactive ? row.failed.join(', ') || row.inactive : '无'} | ${[
      row.webWaits.length ? `等待 Web profile 的服务（${row.webWaits.join('、')}），headless 下保持关闭` : '',
      needs[row.ids[0]] ? '需打开 DSH 凭据存储（headless 默认关闭）' : ''].filter(Boolean).join('；')} |`), ''].join('\n')
  await writeFile(join(evidence, 'report.md'), report)
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ version, passed, packages: rows }, null, 2))
  await rm(root, { recursive: true, force: true })
  assert.ok(passed, 'a package did not load on its own')
  console.log('PASS: every package loads on its own')
}
