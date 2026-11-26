// Acceptance sweep for a candidate: every model-free desktop smoke, each with its own new evidence folder when the smoke
// takes one; unlike run-smokes.mjs a failure does not stop the rest. Results go to <evidence root>/results.json.
//   node tests/run-acceptance.mjs <new evidence root>
// Left out: smokes that use real accounts (run them with --real yourself), native smokes that need DSH module paths,
// and smokes that need a signed verification bundle, a real Codex call or a person watching OS notifications.
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const code = fileURLToPath(new URL('..', import.meta.url))
const root = process.argv[2]
if (!root) throw new Error('Usage: node tests/run-acceptance.mjs <new evidence root>')
mkdirSync(root)
const excluded = new Set(['cloud', 'task-loop-real', 'harness-real', 'side-chat-real', 'handoff-ui', 'change-attribution', 'copy',
  'chatgpt-limits', 'chatgpt-subscription', 'grok-subscription', 'grok-reasoning', 'grok-large-file', 'grok-isolation',
  'refresh-handoff-native', 'owned-agent-native', 'instructions-native', 'preview-schema-native', 'profile-migration',
  'attention-finder', 'delegate-package', 'notification-system'])
const names = readdirSync(join(code, 'tests')).filter(file => file.endsWith('-smoke.mjs')).map(file => file.slice(0, -10)).filter(name => !excluded.has(name)).sort()
const results = []
const save = () => writeFileSync(join(root, 'results.json'), JSON.stringify({ code, results }, null, 2) + '\n')
for (const name of names) {
  const file = join(code, 'tests', `${name}-smoke.mjs`)
  const args = ['--import', 'tsx', file, ...readFileSync(file, 'utf8').includes('--evidence=') ? [`--evidence=${join(root, name)}`] : []]
  const started = Date.now(), at = new Date().toISOString()
  let tail = ''
  const status = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: code, env: process.env })
    const keep = (/** @type {Buffer} */ chunk) => { tail = (tail + chunk).slice(-3000) }
    child.stdout.on('data', keep); child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGTERM'), 900_000)
    child.on('close', code => { clearTimeout(timer); resolve(code) })
  })
  const lines = tail.trim().split('\n')
  results.push({ name, passed: status === 0, status, seconds: Math.round((Date.now() - started) / 1000), at, tail: lines.slice(status === 0 ? -3 : -25).join('\n') })
  console.log(`${status === 0 ? 'PASS' : 'FAIL'}  ${name}  ${results.at(-1)?.seconds}s`)
  save()
}
console.log(`\n${results.filter(result => result.passed).length}/${results.length} passed`)
process.exitCode = results.every(result => result.passed) ? 0 : 1
