import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fullScreenAttribute, pageAttributes } from '../harness/shared/page-contract'

// workbench.css cannot import page-contract.ts, so every data-fig-* attribute it styles must be registered there.
test('every data-fig-* attribute app/main/workbench.css styles is listed in pageAttributes', async () => {
  const css = await readFile(new URL('../app/main/workbench.css', import.meta.url), 'utf8')
  const used = new Set(css.match(/data-fig-[a-z-]*[a-z]/g) ?? [])
  const registered = new Set<string>(Object.values(pageAttributes))
  assert.ok(used.size > 0)
  assert.deepEqual([...used].filter(name => !registered.has(name)), [])
  assert.equal(fullScreenAttribute, pageAttributes.fullScreen)
})
