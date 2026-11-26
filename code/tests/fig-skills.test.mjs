import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import * as figSkills from '../harness/skills-dir/index.js'
import { tempDir } from './helpers/temp-dir.mjs'

const { apply, workspaceSkillsDir } = figSkills

function recordingLogger() {
  const lines = { info: [], warn: [] }
  return { lines, logger: { info: line => lines.info.push(line), warn: line => lines.warn.push(line) } }
}

test('the plugin is named fig-skills, needs only the skills service and is inserted by its patch', async () => {
  assert.equal(figSkills.name, 'fig-skills')
  assert.deepEqual(figSkills.inject, ['skills'])
  const patch = parse(await readFile(new URL('../harness/skills-dir/cordis.patch.yml', import.meta.url), 'utf8'))
  assert.deepEqual(patch, [{ insert: [{ id: 'fig-skills', name: './index.js' }] }])
})

test('the extra skill folder is only the configured absolute one, never one derived from elsewhere', () => {
  assert.equal(workspaceSkillsDir('/w/skills'), '/w/skills')
  assert.equal(workspaceSkillsDir(''), undefined)
  assert.equal(workspaceSkillsDir('relative/skills'), undefined)
  assert.equal(workspaceSkillsDir(undefined), undefined)
  assert.equal(workspaceSkillsDir(42), undefined)
})

test('without an extra skill folder nothing is registered and no warning is logged', async () => {
  const { lines, logger } = recordingLogger()
  await apply({ logger })
  assert.deepEqual(lines.warn, [])
  assert.equal(lines.info.length, 1)
  assert.match(lines.info[0], /no extra skill folder/)
  // A context without a logger is also fine.
  await apply({})
})

test('with an extra skill folder DSH\'s own filesystem provider is registered for that folder only', async t => {
  // A stand-in for the DSH install: fromDsh resolves packages against the running DSH binary (argv[1]).
  const dsh = await tempDir(t, 'fig-skills-dsh-')
  const provider = join(dsh, 'node_modules/@deepseek-ai/dsh-skill-filesystem')
  await mkdir(provider, { recursive: true })
  await writeFile(join(provider, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-skill-filesystem', main: 'index.mjs' }))
  await writeFile(join(provider, 'index.mjs'), 'export const calls = []\nexport function apply(ctx, options) { calls.push({ ctx, options }) }\n')
  await writeFile(join(dsh, 'dsh.mjs'), '')
  const savedArgv = process.argv[1]
  process.argv[1] = join(dsh, 'dsh.mjs')
  t.after(() => { process.argv[1] = savedArgv })

  const { lines, logger } = recordingLogger()
  const ctx = { logger, skills: {} }
  await apply(ctx, { directory: '/workspace/resources/skills' })
  const { calls } = await import(pathToFileURL(join(provider, 'index.mjs')).href)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ctx, ctx)
  assert.deepEqual(calls[0].options, { providerName: 'fig-workspace', includeDefaultRoots: false, customSkillDirs: [join('/workspace', 'resources', 'skills')] })
  assert.deepEqual(lines.warn, [])
  assert.equal(lines.info.length, 1)
  assert.match(lines.info[0], /resources\/skills/)
})
