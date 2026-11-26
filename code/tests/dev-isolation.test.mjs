import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, isAbsolute } from 'node:path'
import { devProfile, isolatedDevEnvironment } from '../scripts/dev-isolation.mjs'

test('persistent dev profile isolates daily data and known CLI credential paths', () => {
  const base = { PATH: '/synthetic/bin', HOME: '/synthetic/home', FIG_DESKTOP_DATA_DIR: '/daily', FIG_DESKTOP_WORKSPACE_DIR: '/daily/workspace', FIG_DESKTOP_FIRST_RUN: '1', DSH_HOME: '/daily/dsh', DSH_AGENTS_HOME: '/daily/agents', GROK_HOME: '/daily/grok', GROK_AUTH_PATH: '/daily/auth.json', CODEX_HOME: '/daily/codex', DEEPSEEK_API_KEY: 'synthetic-secret', OPENAI_API_KEY: 'synthetic-secret', ANTHROPIC_API_KEY: 'synthetic-secret', ELECTRON_RENDERER_URL: 'http://localhost:9999', ELECTRON_RUN_AS_NODE: '1' }
  const before = {...base}, env = isolatedDevEnvironment(base)
  assert.deepEqual(base, before)
  assert.ok(isAbsolute(devProfile))
  assert.equal(env.FIG_DESKTOP_DATA_DIR, devProfile)
  assert.equal(env.FIG_DESKTOP_WORKSPACE_DIR, join(devProfile, 'workspace'))
  assert.equal(env.GROK_AUTH_PATH, join(devProfile, 'grok/auth.json'))
  assert.equal(env.CODEX_HOME, join(devProfile, 'codex'))
  assert.equal(env.DSH_AGENTS_HOME, join(devProfile, 'agents'))
  assert.equal(env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:1')
  for (const key of ['DSH_HOME', 'FIG_DESKTOP_FIRST_RUN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) assert.equal(env[key], undefined)
  assert.equal(env.HOME, base.HOME)
  assert.equal(env.PATH, base.PATH)
  assert.deepEqual(isolatedDevEnvironment(base), env)
})

test('the same isolation applies to a profile folder the caller owns', () => {
  const env = isolatedDevEnvironment({ PATH: '/synthetic/bin', GROK_HOME: '/daily/grok', DSH_HOME: '/daily/dsh' }, '/tmp/owned')
  assert.equal(env.FIG_DESKTOP_DATA_DIR, '/tmp/owned')
  assert.equal(env.FIG_DESKTOP_WORKSPACE_DIR, '/tmp/owned/workspace')
  assert.equal(env.GROK_HOME, '/tmp/owned/grok')
  assert.equal(env.CODEX_HOME, '/tmp/owned/codex')
  assert.equal(env.DSH_HOME, undefined)
  assert.equal(env.PATH, '/synthetic/bin')
})
