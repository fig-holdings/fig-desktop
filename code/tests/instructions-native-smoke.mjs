import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { apply } from '../harness/instructions/index.js'
import { instructionSnapshot } from '../harness/shared/workspace-instructions.js'
import { guidanceDigest, guidanceSnapshot } from '../harness/instructions/harness-guidance.js'

const modules = process.argv.find(arg => arg.startsWith('--modules='))?.slice(10)
const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
assert.ok(modules && evidence, 'Require --modules and a new --evidence directory')
await mkdir(evidence)
const report = { status: 'fail', startedAt: new Date().toISOString(), cases: [] }
const root = await mkdtemp(join(tmpdir(), 'fig-instructions-native-'))
try {
  process.argv[1] = join(modules, '@deepseek-ai/dsh/lib/index.js')
  const { Session } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session/lib/index.js')))
  const { createUserMessage } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm/lib/index.js')))
  // Its own DSH home: the switches live there, and this smoke turns guidance off.
  process.env.DSH_HOME = join(root, 'home')
  await mkdir(join(root, 'home', 'fig'), { recursive: true })
  const project = join(root, 'p')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'SYNTHETIC-NATIVE-RULE')
  let callback, registrations = 0, ensures = 0
  await apply({ on: (name, fn) => { assert.equal(name, 'agent/pre-step'); callback = fn; registrations++ },
    workingDirectory: { ensure: async () => { ensures++; return project } }, inject: () => {}, provide: () => {} }, { startupDirectory: root })
  assert.equal(registrations, 1)
  const session = Session.create('synthetic-source-test')
  const append = snapshot => session.append('user/message', createUserMessage(snapshot), { surfaceOp: 'append' })
  const first = append(instructionSnapshot('SYNTHETIC-NATIVE-RULE', []))
  const second = append(guidanceSnapshot([]))
  // The same public replacement surface used by fixed-version compaction-basic; no new inbox.
  session.append('user/message', createUserMessage({ source: { kind: 'compaction' }, content: [{ type: 'text', text: 'synthetic summary' }] }), {
    surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: second.seq }, sourceEventSeqs: [first.seq, second.seq]
  })
  assert.ok(!session.deriveMessages().some(m => /^fig-/.test(m.source?.kind)))
  const args = { agent: { session }, signal: new AbortController().signal }
  const enter = { kind: 'enter', messages: [] }
  const restored = await callback(args, async () => enter)
  assert.deepEqual(restored.messages.map(m => m.source.kind), ['fig-harness-guidance', 'fig-workspace-instructions'])
  for (const message of restored.messages) session.append('user/message', message, { surfaceOp: 'append' })
  assert.equal(await callback(args, async () => enter), enter, 'next empty enter must not duplicate either source')
  const reject = { kind: 'reject' }
  const before = ensures
  assert.equal(await callback(args, async () => reject), reject)
  assert.equal(ensures, before, 'reject must not resolve cwd or inject')
  await writeFile(join(root, 'AGENTS.md'), 'SYNTHETIC-CHANGED-RULE')
  const changed = await callback(args, async () => enter)
  assert.deepEqual(changed.messages.map(m => m.source.kind), ['fig-workspace-instructions'])
  assert.match(changed.messages[0].content[0].text, /SYNTHETIC-CHANGED-RULE/)
  assert.equal(session.deriveMessages().findLast(m => m.source?.kind === 'fig-harness-guidance').source.digest, guidanceDigest)
  await writeFile(join(process.env.DSH_HOME, 'fig', 'workspace-instructions.json'), JSON.stringify({ schema: 1, harnessGuidance: false }))
  const fresh = { agent: { session: Session.create('synthetic-off') }, signal: args.signal }
  const off = await callback(fresh, async () => enter)
  assert.deepEqual(off.messages.map(m => m.source.kind), ['fig-workspace-instructions'])
  report.cases.push({ id: 'compaction-no-inbox-source-repair-and-dedup', status: 'pass' }, { id: 'reject-unchanged', status: 'pass' },
    { id: 'shared-update-independent-of-guidance', status: 'pass' }, { id: 'guidance-off-preserves-shared-source', status: 'pass' })
  report.status = 'pass'
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  await rm(root, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString()
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(report.status + ': fixed DSH instruction surface / middleware')
}
