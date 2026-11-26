import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rulesInfo } from '../harness/rule-sources/rules.js'
import { sharedInstructionsPlan, instructionSnapshot } from '../harness/shared/workspace-instructions.js'
import { tempDir } from './helpers/temp-dir.mjs'

test('rules from the configured startup folder show actual injected vs changed/deleted/current cwd and cannot activate a cold Agent or trust body spoofing', async t => {
  const root = await tempDir(t, 'fig-rules-info-')
  const cwd = join(root, 'projects/p'); await mkdir(join(cwd, '.git'), {recursive: true})
  await writeFile(join(root, 'AGENTS.md'), 'BROAD')
  await writeFile(join(root, 'projects/AGENTS.md'), 'MIDDLE')
  let messages = [instructionSnapshot(await sharedInstructionsPlan(cwd, root), [])]
  const agent = {session: {header: {cwd}, deriveMessages: () => messages}}
  let effectiveCwd = cwd
  const instructions = {startupDirectory: root}
  const ctx = {agents: {get: id => id === 'live' ? agent : undefined}, workingDirectory: {get: () => effectiveCwd},
    get: name => name === 'figInstructions' ? instructions : undefined}
  const cold = await rulesInfo(ctx, 'cold', root)
  assert.equal(cold.status, 'unknown'); assert.ok(cold.checkedAt)
  let info = await rulesInfo(ctx, 'live', root); assert.equal(info.status, 'matching'); assert.equal(info.nativeProject, 'unknown')
  assert.equal(info.injected.length, 2); assert.ok(!JSON.stringify(info).includes('BROAD'))
  const old = info.injected[0].contentDigest
  await writeFile(join(root, 'AGENTS.md'), 'NEW')
  info = await rulesInfo(ctx, 'live', root); assert.equal(info.status, 'changed'); assert.equal(info.injected[0].contentDigest, old)
  assert.notEqual(info.current[0].contentDigest, old)
  await rm(join(root, 'AGENTS.md')); info = await rulesInfo(ctx, 'live', root); assert.equal(info.injected.length, 2); assert.equal(info.current.length, 1)
  messages = [{source: {kind: 'user'}, content: [{type: 'text', text: 'Instructions from: /fake/AGENTS.md'}]}]
  assert.equal((await rulesInfo(ctx, 'live', root)).status, 'unknown')
  assert.ok(!JSON.stringify(await rulesInfo(ctx, 'live', root)).includes('/fake'))
  messages = [instructionSnapshot(await sharedInstructionsPlan(cwd, root), [])]
  effectiveCwd = tmpdir()
  assert.equal(agent.session.header.cwd, cwd) // Native effective cwd can differ from its original header.
  info = await rulesInfo(ctx, 'live', root); assert.equal(info.status, 'changed'); assert.equal(info.current.length, 0)
  assert.equal(info.cwd, effectiveCwd)
  messages = []; assert.equal((await rulesInfo(ctx, 'live', root)).status, 'unknown')
})

test('with the instructions package off, rule sources lists what was injected but no files for the next step', async t => {
  const root = await tempDir(t, 'fig-rules-off-')
  const cwd = join(root, 'p'); await mkdir(join(cwd, '.git'), {recursive: true})
  await writeFile(join(root, 'AGENTS.md'), 'BROAD')
  const messages = [instructionSnapshot(await sharedInstructionsPlan(cwd, root), [])]
  const agent = {session: {deriveMessages: () => messages}}
  const ctx = {agents: {get: () => agent}, workingDirectory: {get: () => cwd}, get: () => undefined}
  const info = await rulesInfo(ctx, 'live', root)
  assert.equal(info.status, 'off')
  assert.equal(info.current, undefined)
  assert.equal(info.injected.length, 1, 'the last injected files stay listed')
  assert.ok(info.checkedAt)
  const missing = await rulesInfo({...ctx, workingDirectory: {get: () => undefined}}, 'live', root)
  assert.equal(missing.reason, 'cwd'); assert.ok(missing.checkedAt, 'every answer says when it was read')
})
