import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const devProfile = fileURLToPath(new URL('../../work/dev-profile/', import.meta.url))

// Fixed profile, no credential copying and no fallback to daily CLI credentials.
// This is environment/data isolation, NOT an OS/network security sandbox.
// `profile`: the folder that holds the instance's data; the shared development profile unless a caller owns one.
export function isolatedDevEnvironment(base = process.env, profile = devProfile) {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    if (/^(FIG_DESKTOP_|DSH_|GROK_|CODEX_|CHATGPT_|OPENAI_|DEEPSEEK_|ANTHROPIC_)/.test(key)) delete env[key]
  }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    FIG_DESKTOP_DATA_DIR: profile,
    FIG_DESKTOP_WORKSPACE_DIR: join(profile, 'workspace'),
    DSH_AGENTS_HOME: join(profile, 'agents'),
    GROK_HOME: join(profile, 'grok'),
    GROK_AUTH_PATH: join(profile, 'grok/auth.json'),
    CODEX_HOME: join(profile, 'codex'),
    DEEPSEEK_API_KEY: 'fig-dev-catalog-only',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:1'
  })
  return env
}
