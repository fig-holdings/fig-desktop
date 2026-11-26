import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pnpmShim, pnpmVersion } from '../app/main/pnpm-shim'
import { tempDir } from './helpers/temp-dir.mjs'

const run = promisify(execFile)
// A stand-in that prints its arguments and the npm settings it was given.
const echo = '#!/bin/sh\n[ "$1" = --version ] && { echo 10.33.0; exit 0; }\nprintf "%s|" "$@"; printf "env:%s,%s" "$npm_config_fetch_retries" "$npm_config_registry"\n'

test('without an installed pnpm the script runs the pinned pnpm through npx, even from an awkward path', async t => {
  const root = await tempDir(t, 'fig-pnpm-shim-')
  const odd = join(root, "Jo's npm dir")
  await mkdir(odd)
  await writeFile(join(odd, 'npx'), echo, { mode: 0o755 })
  const bin = await pnpmShim(join(odd, 'npx'), join(root, 'bin'), [odd, '/usr/bin'].join(delimiter))
  const { stdout } = await run(join(bin, 'pnpm'), ['add', 'some plugin'])
  assert.equal(stdout, `--yes|pnpm@${pnpmVersion}|add|some plugin|env:,`)
  const before = (await stat(join(bin, 'pnpm'))).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 20))
  await pnpmShim(join(odd, 'npx'), bin, [odd, '/usr/bin'].join(delimiter))
  assert.equal((await stat(join(bin, 'pnpm'))).mtimeMs, before, 'An unchanged script is not rewritten')
})

test('an installed pnpm is used, and lookups pass --config flags as npm settings so npm 12 accepts them', async t => {
  const root = await tempDir(t, 'fig-pnpm-shim-')
  const installed = join(root, 'tools')
  await mkdir(installed)
  await writeFile(join(installed, 'pnpm'), echo, { mode: 0o755 })
  const bin = join(root, 'bin')
  // Fig's own directory is skipped when looking for an installed pnpm, even when it is already on PATH.
  await pnpmShim('/nonexistent/npx', bin, [bin, installed].join(delimiter))
  const lookup = await run(join(bin, 'pnpm'), ['view', 'dsh-everforest', 'version', '--json', '--config.fetch-retries=0', '--config.registry=https://r.example/'])
  assert.equal(lookup.stdout, 'view|dsh-everforest|version|--json|env:0,https://r.example/')
  const add = await run(join(bin, 'pnpm'), ['add', 'x', '--config.fetch-retries=0'])
  assert.equal(add.stdout, 'add|x|--config.fetch-retries=0|env:,', 'Only lookups are rewritten')
})

test('an installed pnpm of another major is passed over for the pinned pnpm 10', async t => {
  const root = await tempDir(t, 'fig-pnpm-shim-')
  const installed = join(root, 'tools')
  await mkdir(installed)
  await writeFile(join(installed, 'pnpm'), '#!/bin/sh\necho 11.2.0\n', { mode: 0o755 })
  const bin = join(root, 'bin')
  await pnpmShim('/nonexistent/npx', bin, [installed].join(delimiter))
  const script = await readFile(join(bin, 'pnpm'), 'utf8')
  assert.match(script, new RegExp('pnpm@' + pnpmVersion.replaceAll('.', '\\.')))
  assert.doesNotMatch(script, /tools\/pnpm/)
})
