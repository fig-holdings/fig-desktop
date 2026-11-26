import assert from 'node:assert/strict'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pruneSiblings } from '../scripts/dev-runtime.mjs'
import { tempDir } from './helpers/temp-dir.mjs'

test('after a prepare only the current finished host stays; foreign and in-progress folders are kept', async t => {
  const base = await tempDir(t, 'fig-dev-runtime-')
  for (const name of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'not-a-key']) {
    await mkdir(join(base, name, 'Fig Desktop.app'), { recursive: true })
    if (name !== 'cccccccccccc') await writeFile(join(base, name, 'identity.json'), '{}\n')
  }
  await writeFile(join(base, 'dddddddddddd'), 'a file, not a host')
  await pruneSiblings(base, 'aaaaaaaaaaaa')
  assert.deepEqual((await readdir(base)).sort(), ['aaaaaaaaaaaa', 'cccccccccccc', 'dddddddddddd', 'not-a-key'])
  await pruneSiblings(join(base, 'missing'), 'aaaaaaaaaaaa')
})
