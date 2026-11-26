import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deliverPackage } from './package-delivery.mjs'

// Packages the trial (npm run package:mac). When npm's DSH latest is a release Fig has not verified,
// it first runs the interface smoke tests against it (once per release) and asks whether to adopt it:
//   new   run the real Grok verification; if it passes the release replaces the verified one and the
//         trial is packaged with it, otherwise nothing is packaged
//   keep  package with the verified release; the answer is remembered for this release
// Without a terminal the question is printed and the run stops; answer with
//   npm run package:mac -- --dsh=new | --dsh=keep

const code = fileURLToPath(new URL('..', import.meta.url))
const reports = join(code, '../work/verification/dsh')
const decisionsPath = join(reports, 'decisions.json')
const args = process.argv.slice(2)
const answer = args.find(arg => arg.startsWith('--dsh='))?.slice(6)
if (answer && answer !== 'new' && answer !== 'keep') throw new Error('Use --dsh=new or --dsh=keep')

/** Runs one command with inherited output; resolves true when it exits 0. */
const step = (command, commandArgs) => new Promise(resolve => {
  const child = spawn(command, commandArgs, { cwd: code, stdio: 'inherit' })
  child.once('error', () => resolve(false))
  child.once('close', status => resolve(status === 0))
})
const readJson = (path, fallback) => readFile(path, 'utf8').then(JSON.parse, () => fallback)

const { verified } = await readJson(join(code, 'harness/dsh-versions.json'), { verified: [] })
let latest
try {
  latest = (await promisify(execFile)('npm', ['view', '@deepseek-ai/dsh', 'dist-tags.latest'], { cwd: code, timeout: 30_000 })).stdout.trim()
} catch {
  console.log('Could not read the DSH npm latest; packaging with the verified release.')
}

if (latest && !verified.includes(latest)) {
  const report = join(reports, `${latest}.md`)
  if (!await readFile(report, 'utf8').then(() => true, () => false)) {
    console.log(`DSH ${latest} is new on npm; running the interface smoke tests against it.`)
    await step('node', ['scripts/dsh-verify.mjs', latest])
  }
  const failed = [...(await readFile(report, 'utf8').catch(() => '')).matchAll(/^\| (\S+) \| 失败 \|$/gm)].map(match => match[1])
  const decisions = await readJson(decisionsPath, {})
  let decision = answer ?? decisions[latest]
  if (!decision) {
    const summary = `DSH ${latest} 界面冒烟${failed.length ? `失败 ${failed.length} 项（${failed.join('、')}）` : '全部通过'}；` +
      `当前已验证版本 ${verified.join('、')}。报告：work/verification/dsh/${latest}.md`
    console.log('\n' + summary)
    if (!process.stdin.isTTY) {
      console.log('是否采用新版？重新运行 npm run package:mac -- --dsh=new（跑真实验证后用新版打包）或 --dsh=keep（用已验证版本打包）。')
      process.exit(2)
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    decision = (await prompt.question('采用新版并跑真实验证？[y/N] ')).trim().toLowerCase().startsWith('y') ? 'new' : 'keep'
    prompt.close()
  }
  if (decision === 'keep') {
    await mkdir(reports, { recursive: true })
    await writeFile(decisionsPath, JSON.stringify({ ...decisions, [latest]: 'keep' }, null, 2) + '\n')
    console.log(`Keeping DSH ${verified.at(-1)}. To adopt ${latest} later: npm run package:mac -- --dsh=new`)
  } else if (!await step('node', ['scripts/dsh-verify.mjs', latest, '--real', '--accept'])) {
    console.log(`DSH ${latest} did not pass the real verification; nothing was packaged. See the report above.`)
    process.exit(1)
  }
}

await deliverPackage(code, step, {rebuild: args.includes('--rebuild')})
