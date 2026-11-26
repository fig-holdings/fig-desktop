import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replacedVersion } from '../app/main/bundle-replacement'
import { tempDir } from './helpers/temp-dir.mjs'

test('a bundle replaced under the running app reports its new version', async t => {
  const app = await tempDir(t, 'fig-replaced-')
  assert.equal(await replacedVersion(app, '0.1.59'), undefined)
  await writeFile(join(app, 'package.json'), JSON.stringify({ version: '0.1.59' }))
  assert.equal(await replacedVersion(app, '0.1.59'), undefined)
  await writeFile(join(app, 'package.json'), JSON.stringify({ version: '0.1.60' }))
  assert.equal(await replacedVersion(app, '0.1.59'), '0.1.60')
})
