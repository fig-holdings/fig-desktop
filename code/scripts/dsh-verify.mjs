import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareDshCache } from './dsh-cache.mjs'
import { dshReleasePattern } from '../harness/shared/dsh-range.ts'

// Verifies a DSH release for Fig: locks its dependency tree as resolved today (work/dsh-candidates/), installs it the
// way Fig does, builds with it as FIG_DSH_CANDIDATE, runs the smoke tests against it and writes a report to
// work/verification/dsh/. With --accept, a release that passes everything replaces the one in
// harness/dsh-versions.json and its lockfile replaces code/dsh-runtime/ (until Fig's first release only one release is
// supported), which Fig installs from its next build. --refresh re-locks the verified release's dependencies, for
// upstream fixes; it is verified and accepted the same way. Packaging runs it for a new npm latest (scripts/package-flow.mjs).
//
//   npm run dsh:verify                 npm's current latest, interface and isolated smoke tests only
//   npm run dsh:verify -- 0.2.2-rc.1 --real --accept
//   npm run dsh:verify -- 0.2.2-rc.5 --refresh --real --accept

const code = fileURLToPath(new URL('..', import.meta.url))
const listPath = join(code, 'harness/dsh-versions.json')
const reports = join(code, '../work/verification/dsh')
const quick = ['sidebar-rail-smoke', 'settings-smoke', 'input-history-smoke', 'more-menu-smoke']
// Isolated smokes that guard Fig's dependencies on DSH internals
// with synthetic data and no model calls. All but stale-cookie write evidence into a new folder.
const isolated = ['directory-settings-smoke', 'attention-native-smoke', 'activity-native-smoke', 'rules-native-smoke', 'accounts-native-smoke', 'stale-cookie-smoke',
  // The DSH plugin market sample (harness/plugin-samples.json, threshold ③ c); needs the npm registry. Its table joins the report.
  'plugin-compat-smoke',
  // Each of Fig's packages alone in this DSH's headless profile. Its table joins the report.
  'package-standalone-smoke',
  // The packages in this DSH's own Web profile without Fig's shell, in the local Google Chrome (distribution step 2).
  'official-web-smoke']
const withEvidence = new Set(isolated.filter(test => test !== 'stale-cookie-smoke'))
// Real Grok tests use the current Grok CLI login and take several minutes each.
const real = ['grok-subscription-smoke', 'copy-smoke', 'next-step-smoke']

const args = process.argv.slice(2)
const withReal = args.includes('--real')
const accept = args.includes('--accept')
const run = promisify(execFile)
const list = JSON.parse(await readFile(listPath, 'utf8'))
const version = args.find(arg => !arg.startsWith('--'))
  ?? (await run('npm', ['view', '@deepseek-ai/dsh', 'dist-tags.latest'], { cwd: code })).stdout.trim()
if (!dshReleasePattern.test(version)) throw new Error('Not a DSH release version: ' + version)
const refresh = args.includes('--refresh')
if (list.verified.includes(version) && !refresh) {
  console.log(`DSH ${version} is already verified; --refresh re-locks its dependencies.`)
  process.exit(0)
}

// The candidate's lockfile: this release with its dependencies resolved now, never changed after this point.
const candidateLock = join(code, '../work/dsh-candidates', `${version}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await mkdir(candidateLock, { recursive: true })
await writeFile(join(candidateLock, 'package.json'), JSON.stringify({ name: '@local/dsh-runtime', version: '0.0.0', private: true,
  description: 'The DSH release Fig runs, with its whole dependency tree locked. Change it only through npm run dsh:verify.',
  dependencies: { '@deepseek-ai/dsh': version } }, null, 2) + '\n')
await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: candidateLock })
process.env.FIG_DSH_CANDIDATE_LOCK = candidateLock
const env = { ...process.env, FIG_DSH_CANDIDATE: version, FIG_DSH_CANDIDATE_LOCK: candidateLock }
/** Runs one command, echoing its output; resolves with the exit code and the output tail. */
function step(command, commandArgs) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd: code, env })
    let output = ''
    const keep = chunk => { output = (output + chunk).slice(-4000); process.stdout.write(chunk) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('close', status => resolve({ passed: status === 0, tail: output.trim().split('\n').slice(-12).join('\n') }))
  })
}

console.log(`Verifying DSH ${version} (verified: ${list.verified.join(', ')})`)
const evidence = join(reports, `${version}-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const results = []
// Install the candidate's tree first: the build's license inventory reads it, and no smoke races a first download.
const cache = await prepareDshCache(version, { code }).then(({ folder }) => ({ passed: true, tail: 'Installed from the candidate lockfile: ' + folder }),
  error => ({ passed: false, tail: String(error?.stderr || error?.message || error).trim().split('\n').slice(-12).join('\n') }))
results.push({ test: 'dsh-install', ...cache })
console.log(cache.tail)
const build = cache.passed ? await step('npm', ['run', 'build']) : { passed: false, tail: 'Not built: the candidate did not install' }
results.push({ test: 'build', ...build })
if (build.passed) {
  await mkdir(evidence, { recursive: true })
  for (const test of [...quick, ...isolated, ...(withReal ? real : [])]) {
    console.log(`\n== ${test}`)
    // The license build reads a preloaded npm tree, but the runtime may still prime its own npx cache on first launch;
    // a timeout of the first test gets one more try.
    let result = await step('node', [...(['package-standalone-smoke', 'official-web-smoke'].includes(test) ? ['--import', 'tsx'] : []), `tests/${test}.mjs`, ...(real.includes(test) ? ['--real'] : []),
      ...(withEvidence.has(test) ? [`--evidence=${join(evidence, test)}`] : [])])
    if (!result.passed && test === quick[0]) result = await step('node', [`tests/${test}.mjs`])
    results.push({ test, ...result })
  }
}

const passed = results.every(result => result.passed) && withReal
const lines = [
  `# DSH ${version} 验证（${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC）`, '',
  `已验证版本：${list.verified.join('、')}。范围：界面与隔离冒烟${withReal ? '、Grok 真实测试' : '（未跑 Grok 真实测试，不能接受）'}。隔离冒烟证据：\`${relative(join(code, '..'), evidence)}\`。`, '',
  '| 测试 | 结果 |', '| --- | --- |',
  ...results.map(result => `| ${result.test} | ${result.passed ? '通过' : '失败'} |`), '',
  ...results.filter(result => !result.passed).flatMap(result => [`## ${result.test}`, '', '```', result.tail, '```', '']),
  await readFile(join(evidence, 'plugin-compat-smoke', 'report.md'), 'utf8').catch(() => ''),
  await readFile(join(evidence, 'package-standalone-smoke', 'report.md'), 'utf8').catch(() => '')
]
await mkdir(reports, { recursive: true })
await writeFile(join(reports, `${version}.md`), lines.join('\n'))

if (passed && accept) {
  // The replaced release stays reachable at the last commit that ran it, through a dsh-compat/<release> tag.
  for (const old of list.verified.filter(old => old !== version)) {
    const tag = `dsh-compat/${old}`
    const tagged = await run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: code }).then(() => true, () => false)
    if (!tagged) await run('git', ['tag', '-a', tag, 'HEAD', '-m', `Last commit that runs and verifies DSH ${old}.`], { cwd: code })
    console.log(`\nDSH ${old} is kept at tag ${tag}; record its adaptations in the compatibility ledger.`)
  }
  list.verified = [version]
  await writeFile(listPath, JSON.stringify(list, null, 2) + '\n')
  for (const name of ['package.json', 'package-lock.json']) await copyFile(join(candidateLock, name), join(code, 'dsh-runtime', name))
  console.log(`\nDSH ${version} passed; harness/dsh-versions.json and code/dsh-runtime/ now hold it${refresh ? ' with its dependencies re-locked' : ''}. Package Fig to start it.`)
} else {
  console.log(`\nDSH ${version}: ${passed ? 'passed' : 'not accepted'}. Report: work/verification/dsh/${version}.md`)
}
// Leave the build as the verified list makes it, not with the candidate.
await new Promise(resolve => spawn('npm', ['run', 'build'], { cwd: code, env: { ...process.env, FIG_DSH_CANDIDATE: '', FIG_DSH_CANDIDATE_LOCK: '' }, stdio: 'ignore' }).on('close', resolve))
process.exit(passed ? 0 : 1)
