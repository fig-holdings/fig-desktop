import assert from 'node:assert/strict'
import test from 'node:test'
import { localeBootstrap, onUiLanguageChange, setUiLanguage, tr, uiLanguage, uiLanguageOf } from '../app/main/language'
import { uiText } from '../harness/shared/ui-text'

test('only Chinese and English: any zh tag is Chinese, every other tag English', () => {
  assert.equal(uiLanguageOf('zh'), 'zh'); assert.equal(uiLanguageOf('zh-Hans-CN'), 'zh'); assert.equal(uiLanguageOf('ZH_tw'), 'zh')
  assert.equal(uiLanguageOf('en-US'), 'en'); assert.equal(uiLanguageOf('ja'), 'en'); assert.equal(uiLanguageOf('pt-BR'), 'en')
  assert.equal(uiLanguageOf(''), undefined); assert.equal(uiLanguageOf(null), undefined); assert.equal(uiLanguageOf(42), undefined)
})

test('the DSH page only ever sees zh or en, so its automatic choice stays within what Fig offers', () => {
  assert.deepEqual(localeBootstrap(['ja-JP', 'zh-Hans-CN', 'fr'], undefined), { languages: ['en', 'zh'], preference: null })
  assert.deepEqual(localeBootstrap([], 'zh'), { languages: ['en'], preference: 'zh' })
  assert.deepEqual(localeBootstrap(['zh-CN'], 'ja'), { languages: ['zh'], preference: 'en' }, 'A hidden language stored earlier opens in English')
})

test('main text and the harness text main runs both follow one language, and listeners hear only changes', () => {
  const heard: string[] = []
  const off = onUiLanguageChange(language => heard.push(language))
  setUiLanguage('zh'); assert.equal(tr('设置…', 'Settings…'), '设置…'); assert.equal(uiText('中', 'en'), '中')
  setUiLanguage('en'); setUiLanguage('en')
  assert.equal(uiLanguage(), 'en'); assert.equal(tr('设置…', 'Settings…'), 'Settings…'); assert.equal(uiText('中', 'en'), 'en')
  assert.deepEqual(heard, ['en'])
  off(); setUiLanguage('zh'); assert.deepEqual(heard, ['en'])
})

test('the DSH page preload repeats the shared channel names, since it cannot import them', async () => {
  const { readFile } = await import('node:fs/promises')
  const { IPC } = await import('../app/shared/protocol')
  const source = await readFile(new URL('../app/preload/dsh-locale.ts', import.meta.url), 'utf8')
  assert.ok(source.includes(`'${IPC.localeRead}'`) && source.includes(`'${IPC.localeChange}'`))
  assert.ok(!/from '\.\.\/shared/.test(source))
})
