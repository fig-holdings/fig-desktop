import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { bundlePlugins } from '../harness/plugins.ts'
import { customPluginNames, customPluginsTab } from '../harness/desktop-skin/client-custom-plugins.js'
import { customPluginMeta } from '../harness/desktop-skin/custom-plugin-meta.js'

test('custom plugin membership and offline display metadata match every shipped bundle exactly', async () => {
  const names = []
  for (const plugin of bundlePlugins) {
    const manifest = JSON.parse(await readFile(new URL(`../harness/${plugin.name}/package.json`, import.meta.url)))
    names.push(manifest.name)
    for (const lang of ['zh', 'en']) {
      const locale = JSON.parse(await readFile(new URL(`../harness/${plugin.name}/locale/${lang}.json`, import.meta.url)))
      assert.deepEqual(customPluginMeta[manifest.name][lang], locale.meta)
    }
  }
  assert.deepEqual([...customPluginNames].sort(), names.sort())
  assert.equal(customPluginNames.has('@local/dsh-unrelated'), false)
  assert.equal(customPluginNames.has('@deepseek-ai/dsh-subagent'), false)
})

test('native list hiding only targets exact custom cards in bundles group, not detail pages', () => {
  const { css } = customPluginsTab({}, {})
  assert.match(css, /\[data-plugin-group="bundles"\]/)
  assert.ok(!css.includes('[data-plugin-package^='))
  for (const name of customPluginNames) assert.ok(css.includes(`[data-plugin-package="${name}"]`))
})
