import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedProfile, launchFig, closeFig, cleanUp, until } from '../scripts/isolated-fig.mjs'
import { evidenceDir, insertProbes, openWorkbench, writeResult } from './helpers/fig-smoke.mjs'

const evidence = await evidenceDir('workbench-extension')
const state = await isolatedProfile('workbench-extension', { extraEnv: root => ({
  FIG_DESKTOP_DEV_EDITION: 'team', PATH: `${join(root, 'bin')}:${process.env.PATH}`, FIG_GH_LOG: join(root, 'gh.log')
}) })
const source = join(state.profile, 'signed-source'), folder = join(source, 'package')
const archive = join(state.profile, 'provider.tgz')
await mkdir(folder, { recursive: true })
await mkdir(join(state.dshHome, 'fig'), { recursive: true })
await mkdir(join(state.profile, 'bin'), { recursive: true })
await writeFile(join(state.profile, 'bin/gh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIG_GH_LOG"\nprintf "[]"\n')
await chmod(join(state.profile, 'bin/gh'), 0o700)
await writeFile(join(folder, 'package.json'), JSON.stringify({ name: '@fig-fixture/workbench-source', version: '1.0.0', type: 'module',
  exports: { '.': './index.js', './package.json': './package.json', './bundle.patch.yml': './bundle.patch.yml' },
  engines: { dsh: '0.2.2-rc.5' }, dsh: { bundle: { patch: './bundle.patch.yml' } },
  figDevelopment: { version: 1, entry: 'test-workbench-source', module: './index.js' } }))
await writeFile(join(folder, 'bundle.patch.yml'), '- insert:\n    - id: test-workbench-source\n      name: "@fig-fixture/workbench-source"\n')
await writeFile(join(folder, 'index.js'), String.raw`
export const inject = ['figDevelopment', 'tools']
const base = 'a'.repeat(40), head = 'b'.repeat(40)
const patch = 'diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+new\n'
const pull = (repo, number) => ({ url: 'https://github.com/' + repo + '/pull/' + number, number, title: 'Fixture ' + number,
  headRefName: 'main', baseRefName: 'base', headRefOid: head, headRepository: repo, state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] })
export function apply(ctx) {
  const report = { state: { accepted: false, actions: 0, calls: [], remotes: [] } }
  globalThis[Symbol.for('fig.workbench.test')] = report
  let revoked = false, scenario
  report.scenario = name => { scenario = name }
  const review = { name: 'fixture_pull_read', description: 'Read fixture pull request',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'fixture' }
  ctx.effect(() => ctx.tools.register(review, { when: () => !revoked }))
  const extension = { version: 1,
    provider: {
      owns({ repo }) { return repo === 'fixture/local' ? 'unmanaged' : ['fixture/managed', 'fixture/other'].includes(repo) && !revoked ? 'managed' : 'unknown' },
      repoFromRemote({ remote }) {
        report.state.remotes.push(remote)
        if (remote.host === 'proxy.example.invalid' && remote.path === 'git/design') return { repo: 'fixture/managed' }
      },
      listPulls({ repo }) { return { repo, pulls: scenario === 'first-delivery' ? [] : [pull(repo, 7)] } },
      viewPull({ repo, url }) {
        report.state.calls.push(repo)
        return pull(scenario === 'wrong-repo' ? 'fixture/managed' : repo, Number(url.split('/').at(-1)))
      },
      reviews({ url }) { return { url, threads: [] } },
      reviewRequests({ repo }) { return { repo, requests: [] } },
      pullDiff({ url }) { return { url, head, patchHead: scenario === 'wrong-head' ? base : head,
        patch: scenario === 'oversize-diff' ? 'x'.repeat(5 * 1024 * 1024) : patch, open: true } },
      compare({ sessionId, grant }) {
        if (!revoked && ['round-fixture', 'second-fixture'].includes(grant)) return { sessionId, repo: 'fixture/managed',
          round: grant === 'round-fixture' ? 'one' : 'two', base, head: grant === 'round-fixture' ? head : 'c'.repeat(40),
          patch: grant === 'round-fixture' ? patch : patch.replace('+new', '+newer') }
      }
    },
    sessionPolicy() { return { deliver: { id: 'deliver', version: 'v1', label: 'Send fixture' },
      linkedPulls: scenario === 'first-delivery' ? [] : ['https://github.com/fixture/other/pull/9'], branchFor: 'fig/fixture' } },
    pullPolicy() { return { managed: true, merge: { label: 'Awaiting acceptance' }, allowed: ['agent-review'], actions: [] } },
    tools: { 'agent-review': review },
    runAction() { report.state.actions++; return { completed: true } }
  }
  void ctx.figDevelopment.register(extension).then(handle => {
    report.state.accepted = true
    report.invalidate = () => { revoked = true; handle.invalidate() }
    report.dispose = () => handle.dispose()
  }, error => { report.state.error = error.message; report.state.entry = ctx.fiber?.entry?.options?.id })
}
`)
execFileSync('tar', ['-czf', archive, '-C', source, 'package'])
const bytes = await readFile(archive), keys = generateKeyPairSync('ed25519')
await writeFile(archive + '.sig.json', JSON.stringify({ algorithm: 'ed25519', keyId: 'fixture', sha256: createHash('sha256').update(bytes).digest('hex'),
  signature: sign(null, bytes, keys.privateKey).toString('base64') }))
await writeFile(join(state.dshHome, 'fig/profile.json'), JSON.stringify({ edition: 'team', id: 'workbench-fixture',
  plugins: [{ source: { kind: 'package', path: archive }, required: true }],
  trustedKeys: [{ id: 'fixture', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] }))
await insertProbes(state, ['handoff-probe', 'workbench-extension-probe'])

const repo = join(state.documents, 'repository')
await mkdir(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
git('init', '-q', '-b', 'main')
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
git('remote', 'add', 'origin', 'https://github.com/fixture/managed.git')
git('update-ref', 'refs/remotes/origin/base', 'HEAD')

let app, passed = false
try {
  app = await launchFig(state.env)
  const page = await openWorkbench(app)
  const post = (prefix, endpoint, data = {}) => page.evaluate(async ({ prefix, endpoint, data }) => {
    const result = await (await fetch(`/${prefix}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })).json()
    if (!result.ok) throw new Error(`${endpoint}: ${JSON.stringify(result.error)}`)
    return result.value
  }, { prefix, endpoint, data })
  const fixture = (endpoint, data) => post('workbench-extension-probe', endpoint, data)
  const wb = (endpoint, data) => post('fig-development-workbench', endpoint, data)
  const registration = await until(async () => { const seen = await fixture('state'); return seen?.accepted || seen?.error ? seen : undefined })
  assert.equal(registration.accepted, true, JSON.stringify(registration))
  assert.equal((await wb('extension-state')).mode, 'mixed')
  assert.equal(await fixture('untrusted'), true)
  const probe = (endpoint, data) => post('handoff-probe', endpoint, data)
  const { id: session } = await probe('parent', { workspacePath: repo, preset: 'workspace-write' })
  await probe('hold', { id: session })
  await fixture('scenario', { name: 'first-delivery' })
  const first = await wb('pulls', { session })
  assert.deepEqual(first.session, [])
  assert.equal(first.sessionPolicy.deliver.label, 'Send fixture')
  assert.deepEqual(await wb('run-action', { session, token: first.sessionPolicy.deliver.token }), { completed: true })
  await fixture('scenario', { name: 'normal' })
  const pulls = await wb('pulls', { session })
  assert.deepEqual(pulls.session.map(row => row.repo).sort(), ['fixture/managed', 'fixture/other'])
  assert.equal(pulls.session.find(row => row.repo === 'fixture/other').current, false)
  assert.equal(pulls.sessionPolicy.branchFor, 'fig/fixture')
  const managed = pulls.session.find(row => row.repo === 'fixture/managed')
  assert.equal((await wb('merge-options', { session, url: managed.url })).refused, 'not-authorized')
  assert.equal((await wb('autofix', { session, url: managed.url, on: true })).refused, 'not-authorized')
  assert.equal((await wb('create-pull', { session, head: git('rev-parse', 'HEAD').toString().trim(), base: 'base' })).refused, 'not-authorized')
  assert.equal((await wb('pull-diff', { session, url: managed.url })).head, managed.head)
  for (const name of ['wrong-head', 'oversize-diff']) {
    await fixture('scenario', { name })
    assert.equal((await wb('pull-diff', { session, url: managed.url })).clear, true)
  }
  await fixture('scenario', { name: 'wrong-repo' })
  assert.deepEqual((await wb('pulls', { session })).session.map(row => row.repo), ['fixture/managed'])
  await fixture('scenario', { name: 'normal' })
  const review = await wb('agent-review', { session, url: managed.url, language: 'zh' })
  assert.equal(review.sent, true, JSON.stringify(review))
  const held = await until(async () => {
    const value = await probe('held', { id: session })
    return value?.entries?.length ? value : undefined
  })
  assert.match(JSON.stringify(held.entries), /fixture_pull_read/)
  assert.doesNotMatch(JSON.stringify(held.entries), /gh pr/)
  await probe('stop', { id: session })
  await until(() => probe('idle', {}))
  const token = pulls.sessionPolicy.deliver.token
  assert.deepEqual(await wb('run-action', { session, token }), { completed: true })
  assert.deepEqual(await wb('run-action', { session, token }), { completed: true })
  assert.equal((await fixture('state')).actions, 2)
  assert.equal(await readFile(join(state.profile, 'gh.log'), 'utf8').catch(() => ''), '')
  const { handle } = await wb('open-comparison', { session, grant: 'round-fixture' })
  assert.equal((await wb('comparison', { session, handle })).files[0].path, 'note.txt')
  const second = await wb('open-comparison', { session, grant: 'second-fixture' })
  assert.notEqual(second.handle, handle)
  const original = await wb('comparison', { session, handle })
  const revised = await wb('comparison', { session, handle: second.handle })
  assert.notEqual(original.head, revised.head)
  assert.equal(original.files[0].hunks[0].lines.at(-1).text, 'new')
  assert.equal(revised.files[0].hunks[0].lines.at(-1).text, 'newer')
  const other = await probe('parent', { workspacePath: repo, preset: 'workspace-write' })
  assert.equal((await wb('comparison', { session: other.id, handle })).clear, true)
  git('remote', 'set-url', 'origin', 'https://fixture-user:fixture-secret@proxy.example.invalid/git/design.git?fixture-query=fixture-secret#fragment')
  assert.equal((await wb('pulls', { session, force: true })).session.find(row => row.url === managed.url).current, true)
  const mapped = (await fixture('state')).remotes.at(-1)
  assert.deepEqual(mapped, { host: 'proxy.example.invalid', path: 'git/design' })
  git('remote', 'set-url', 'origin', 'https://proxy.example.invalid/git/unmapped.git')
  assert.equal((await wb('pulls', { session, force: true })).extensionUnavailable, true)
  await fixture('invalidate')
  assert.equal((await wb('comparison', { session, handle })).clear, true)
  assert.equal((await wb('run-action', { session, token })).refused, 'changed')
  assert.equal((await wb('pulls', { session })).extensionUnavailable, true)
  assert.equal(await readFile(join(state.profile, 'gh.log'), 'utf8').catch(() => ''), '')
  git('remote', 'set-url', 'origin', 'https://github.com/fixture/local.git')
  await wb('pulls', { session, force: true })
  assert.match(await readFile(join(state.profile, 'gh.log'), 'utf8'), /pr list/)
  await fixture('stop')
  assert.equal(await fixture('untrusted'), true)
  assert.equal((await wb('pulls', { session })).extensionUnavailable, true)
  passed = true
  await writeResult(evidence, { status: 'pass', signedRegistration: true, crossRepo: true, rejectsMismatchedResponse: true,
    firstDelivery: true, agentTool: true, proxyMapping: true, invalidation: true, mixedFallback: true })
  console.log('PASS: signed provider, cross-repository routing, action confirmation, Agent tool, proxy mapping, comparison isolation, and fail-closed invalidation')
} finally {
  if (app) await closeFig(app)
  await cleanUp(state.profile, passed)
}
