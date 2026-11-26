// Runs desktop smokes one after another against the current build: `node tests/run-smokes.mjs desktop error …`
// runs tests/<name>-smoke.mjs for each name, stops at the first failure and prints each result.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const names = process.argv.slice(2)
if (!names.length) throw new Error('Name at least one smoke, e.g. node tests/run-smokes.mjs desktop error')
const files = names.map(name => fileURLToPath(new URL(`./${name}-smoke.mjs`, import.meta.url)))
const missing = names.filter((_, index) => !existsSync(files[index]))
if (missing.length) throw new Error('No such smoke: ' + missing.join(', '))

const results = []
for (const [index, name] of names.entries()) {
  const started = Date.now()
  const code = await new Promise(resolve => spawn(process.execPath, [files[index]], { stdio: 'inherit' }).on('close', resolve))
  const seconds = Math.round((Date.now() - started) / 1000)
  results.push(`${code === 0 ? 'PASS' : 'FAIL'}  ${name}  ${seconds}s`)
  console.log(`\n[smokes] ${results.at(-1)}\n`)
  if (code !== 0) break
}
console.log('[smokes] ' + results.length + '/' + names.length + ' run\n' + results.map(line => '  ' + line).join('\n'))
const skipped = names.slice(results.length)
if (skipped.length) console.log('  not run: ' + skipped.join(', '))
process.exitCode = results.every(line => line.startsWith('PASS')) && !skipped.length ? 0 : 1
