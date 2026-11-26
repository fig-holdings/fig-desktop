import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentCommand, delegate, locateAgents } from '../harness/delegate/index.js'
import { findExecutable } from '../harness/environment'
import { tempDir } from './helpers/temp-dir.mjs'

test('external review commands pin read-only tools and transport prompts through stdin', () => {
  const codex = agentCommand('codex', '/fixture', '/answer')
  assert.equal(codex.file, 'codex')
  assert.equal(codex.args[codex.args.indexOf('--sandbox') + 1], 'read-only')
  assert.equal(codex.args.at(-1), '-')
  // MCP servers, plugin servers and app connectors run outside Codex's sandbox, so a review loads none of them.
  assert.ok(codex.args.includes('--ignore-user-config'))
  for (const feature of ['apps', 'computer_use']) assert.ok(codex.args.some((arg, i) => arg === feature && codex.args[i - 1] === '--disable'), feature)
  const claude = agentCommand('claude', '/fixture', '/answer')
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], 'Read,Grep,Glob')
  assert.ok(claude.args.includes('--strict-mcp-config'))
  assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.throws(() => agentCommand('unknown', '/', '/answer'), /unknown agent/)
})

test('external review refuses empty tasks or unknown agents before launching a process', async () => {
  await assert.rejects(delegate({ agent: 'codex', task: ' ' }, '/'), /task text/)
  await assert.rejects(delegate({ agent: 'unknown', task: 'read this' }, '/'), /unknown agent/)
})

test('the delegation tool finds CLIs on PATH and in the usual install folders a Finder launch misses', async () => {
  const present = new Set(['/b/claude', '/c/codex'])
  const canRun = async path => present.has(path)
  assert.deepEqual(await locateAgents({ PATH: '/a:/b:/c' }, canRun), { codex: '/c/codex', claude: '/b/claude' })
  assert.deepEqual(await locateAgents({ PATH: '/a:/b' }, canRun), { claude: '/b/claude' })
  assert.deepEqual(await locateAgents({ PATH: 'relative:/a' }, async path => path.startsWith('relative')), {}, 'relative PATH entries are ignored')
  assert.deepEqual(await locateAgents({ PATH: '/b' }, async () => { throw Error('EACCES') }), {})
  const local = join(homedir(), '.local/bin/claude'), brew = '/opt/homebrew/bin/codex'
  assert.deepEqual(await locateAgents({ PATH: '/usr/bin:/bin' }, async path => path === local || path === brew), { codex: brew, claude: local })
})

test('findExecutable takes the first folder holding an executable file of that name', async t => {
  const root = await tempDir(t, 'fig-find-executable-')
  const [plain, folder, runnable] = ['plain', 'folder', 'runnable'].map(name => join(root, name))
  await Promise.all([mkdir(plain), mkdir(join(folder, 'tool'), { recursive: true }), mkdir(runnable)])
  await writeFile(join(plain, 'tool'), '')
  await writeFile(join(runnable, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(await findExecutable('tool', [plain, folder, join(root, 'missing'), runnable]), join(runnable, 'tool'), 'not executable, a folder, or missing is skipped')
  assert.equal(await findExecutable('tool', [plain, folder]), undefined)
})
