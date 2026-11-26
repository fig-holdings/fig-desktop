import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { uiText } from '../harness/shared/ui-text'
import { tempDir } from './helpers/temp-dir.mjs'

// A DSH Host process: no main-process language, so the preference DSH stored decides.
test('Host text follows the stored DSH language, then the process message locale', async t => {
  const home = await tempDir(t, 'fig-ui-text-')
  const keys = ['DSH_HOME', 'LC_ALL', 'LC_MESSAGES', 'LANG'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    process.env.DSH_HOME = home
    for (const key of keys.slice(1)) delete process.env[key]
    assert.equal(uiText('中', 'en'), '中', 'Nothing stored, no locale: Chinese')
    process.env.LANG = 'C'
    assert.equal(uiText('中', 'en'), '中', 'The C locale names no language')
    process.env.LANG = 'zh_CN.UTF-8'
    process.env.LC_MESSAGES = 'en_US.UTF-8'
    assert.equal(uiText('中', 'en'), 'en', 'Nothing stored yet: the message locale, LC_MESSAGES over LANG')
    await mkdir(join(home, 'profiles/web'), { recursive: true })
    const patch = (preference: string) => `- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: dark\n- id: locale\n  name: "@deepseek-ai/dsh-client-locale"\n  config:\n    preference: ${preference}\n`
    await writeFile(join(home, 'profiles/web/cordis.patch.yml'), patch('zh'))
    assert.equal(uiText('中', 'en'), '中', 'The stored choice wins over the locale, and the theme entry is not read as one')
    await writeFile(join(home, 'profiles/web/cordis.patch.yml'), patch('ja'))
    assert.equal(uiText('中', 'en'), 'en', 'A hidden language reads as English')
    await writeFile(join(home, 'cordis.patch.yml'), patch('"zh"'))
    assert.equal(uiText('中', 'en'), '中', 'The home patch applies over the Web profile patch')
  } finally {
    for (const key of keys) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

test('without DSH_HOME, Host text reads the same default home as the plugins (~/.fig)', async t => {
  const home = await tempDir(t, 'fig-ui-text-home-')
  const keys = ['HOME', 'DSH_HOME', 'LC_ALL', 'LC_MESSAGES', 'LANG'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) delete process.env[key]
    process.env.HOME = home
    process.env.LANG = 'zh_CN.UTF-8'
    await mkdir(join(home, '.fig'), { recursive: true })
    await writeFile(join(home, '.fig/cordis.patch.yml'), '- id: locale\n  config:\n    preference: en\n')
    assert.equal(uiText('中', 'en'), 'en')
  } finally {
    for (const key of keys) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})
