import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

export const scenarioIds = [
  'context-tool-artifact', 'approval-allow', 'approval-reject', 'ask-user', 'instruction-update', 'compact-reinject',
  'stop', 'handoff-background-approval', 'subagent', 'goal', 'plan-review', 'queue-steer-stop', 'artifact-open-revise',
  'guidance-page-selfcheck:off', 'guidance-page-selfcheck:on', 'guidance-plain-qa:off', 'guidance-plain-qa:on'
]
/** Every model route runs the same 17 scenarios (launch gate ①). DSH's subagent and compaction follow the session's own
 * route, so a Grok or ChatGPT run exercises that model throughout, without a DeepSeek credential in its profile. */
/** Launch-gate checks outside the 17 (Codex alignment C3, C7, I5 and the side chat's forwarding guard): run only when
 * named with --only, never part of a full suite. */
export const extraScenarioIds = ['web-search', 'goal-controls', 'keep-awake', 'side-chat-forward']
export const providerSuites = { deepseek: scenarioIds, 'deepseek-api': scenarioIds, grok: scenarioIds, chatgpt: scenarioIds, claude: scenarioIds }

export function declareSuite(provider, only) {
  if (!providerSuites[provider]) throw new Error('Unknown --provider')
  const ids = only === undefined ? [...providerSuites[provider]] : only.split(',')
  if (!ids.length || ids.some(id => !scenarioIds.includes(id) && !extraScenarioIds.includes(id)) || new Set(ids).size !== ids.length) throw new Error('Unknown, empty or duplicate --only scenario IDs')
  if (ids.some(id => !providerSuites[provider].includes(id) && !extraScenarioIds.includes(id))) throw new Error('Scenario outside declared provider coverage')
  return { suite: only === undefined ? 'full' : 'subset', expectedScenarioIds: ids }
}

export function suiteExit(expected, results) {
  if (!expected.length || new Set(expected).size !== expected.length) return 2
  if (results.some(result => !expected.includes(result.id)) || new Set(results.map(r => r.id)).size !== results.length) return 2
  if (results.some(result => result.status === 'fail')) return 1
  if (expected.some(id => !results.some(result => result.id === id)) || results.some(result => result.status !== 'pass')) return 3
  return 0
}

export { BlockedError } from '../../scripts/verification-lifecycle.mjs'

/** A never-overwritten evidence directory, allocated before credentials or browser startup. */
export async function evidenceRun({ provider, only, evidenceRoot, route }) {
  const declared = declareSuite(provider, only)
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const base = evidenceRoot ? resolve(evidenceRoot) : join(root, 'work/verification/implementation/evidence')
  if (evidenceRoot && !isAbsolute(evidenceRoot)) throw new Error('--evidence must be absolute')
  const directory = join(base, runId, provider)
  await mkdir(join(base, runId), { recursive: true })
  await mkdir(directory) // no overwrite
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'code'], { cwd: root }).toString().split('\0').filter(Boolean)
  const sourceFiles = {}
  for (const path of paths) sourceFiles[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex')
  const manifest = {
    schema: 1, runId, provider, route, ...declared,
    startedAt: new Date().toISOString(), finishedAt: null,
    figVersion: JSON.parse(await readFile(join(root, 'code/package.json'), 'utf8')).version,
    dshVersion: JSON.parse(await readFile(join(root, 'code/harness/dsh-versions.json'), 'utf8')).verified.at(-1),
    permissions: 'workspace-write; explicit native approval for escalation', scope: 'synthetic isolated profile; no real refresh credentials',
    sourceFiles, dirty: execFileSync('git', ['status', '--porcelain', '--', 'code'], { cwd: root }).toString(), results: [], status: 'running'
  }
  const persist = () => writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await persist()
  return {
    directory, manifest, selected: id => declared.expectedScenarioIds.includes(id),
    emergency(error) {
      for (const id of declared.expectedScenarioIds) if (!manifest.results.some(result => result.id === id)) manifest.results.push({ id, status: 'fail', reason: String(error?.message ?? error).slice(0, 600) })
      manifest.status = 'fail'; manifest.exitCode = 1; manifest.finishedAt = new Date().toISOString()
      manifest.emergency = 'uncaught process failure; synchronous evidence checkpoint'
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    },
    async record(id, status, detail) {
      if (!declared.expectedScenarioIds.includes(id) || manifest.results.some(result => result.id === id)) throw new Error('Unrequested or repeated result: ' + id)
      manifest.results.push({ id, status, at: new Date().toISOString(), ...detail })
      await persist()
    },
    async finish(error) {
      const status = error?.status === 'blocked' ? 'blocked' : 'fail'
      for (const id of declared.expectedScenarioIds) if (!manifest.results.some(result => result.id === id)) manifest.results.push({ id, status: error ? status : 'skipped', reason: error ? String(error.message).slice(0, 600) : 'scenario did not execute' })
      const exitCode = suiteExit(declared.expectedScenarioIds, manifest.results)
      manifest.finishedAt = new Date().toISOString()
      manifest.status = exitCode === 0 ? 'pass' : exitCode === 3 ? 'blocked' : 'fail'
      manifest.exitCode = exitCode
      manifest.evidenceFiles = ['manifest.json', ...await readdir(directory, { recursive: true }).then(paths => paths.filter(path => path !== 'manifest.json'))]
      await persist()
      return exitCode
    }
  }
}
