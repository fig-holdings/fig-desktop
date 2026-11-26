import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { uiText } from '../shared/ui-text'
import { mediumDefault } from '../shared/medium-effort.ts'

/** The Grok CLI's state folder and sign-in record; GROK_HOME and GROK_AUTH_PATH apply as in the CLI. */
export function grokPaths(environment: NodeJS.ProcessEnv = process.env): { grokHome: string; authPath: string } {
  const absolute = (value?: string) => value && isAbsolute(value) ? value : undefined
  const grokHome = absolute(environment.GROK_HOME) ?? join(homedir(), '.grok')
  return { grokHome, authPath: absolute(environment.GROK_AUTH_PATH) ?? join(grokHome, 'auth.json') }
}

/** auth.json keys of the CLI's first-party x.ai OIDC sessions. */
export const oidcSessionKey = /^https:\/\/auth\.x\.ai::[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i

export const loginRequired = 'GROK_LOGIN_REQUIRED'
export const loginMessage = () => uiText('Grok CLI 登录不可用。请在设置「Grok 账号」中登录后重试。', 'Grok CLI sign-in is unavailable. Sign in under Settings › Grok Account, then retry.')
const quotaMessage = () => uiText('Grok 订阅额度不足。请在 Grok Usage 查看剩余额度。', 'The Grok subscription is out of quota. Check what is left in Grok Usage.')

/** Maps a provider or CLI failure to a fixed message. Upstream text may contain credentials and is never echoed. */
export function safeFailure(code: string, message = ''): { code: string; message: string } {
  if (code === 'AUTH' || code === loginRequired || /\b(?:401|403)\b|unauthori[sz]ed|re-?auth|not (?:logged|signed) in|login required/i.test(message)) {
    return { code: loginRequired, message: loginMessage() }
  }
  if (code === 'QUOTA' || /\b402\b|credit limit|insufficient.quota|quota exceeded|usage limit/i.test(message)) {
    return { code: 'GROK_QUOTA', message: quotaMessage() }
  }
  if (code === 'RATE_LIMIT' || /\b429\b|rate.?limit/i.test(message)) {
    return { code: 'RATE_LIMIT', message: uiText('Grok 订阅暂时限流，请稍后重试。', 'The Grok subscription is rate-limited for now. Try again shortly.') }
  }
  return { code, message: uiText('Grok 订阅请求失败，请检查连接或稍后重试。', 'The Grok subscription request failed. Check the connection or try again shortly.') }
}

type GrokEffort = { value?: unknown; label?: unknown; description?: unknown }
export type ReasoningInfo = { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string }

/** DSH lists efforts from least to greatest; Grok's catalog lists them greatest first. */
export const reasoningLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Turns a Grok catalog entry's efforts into DSH reasoning metadata.
 * The proxy model list gives each effort as a `{ value, label }` item.
 */
export function grokReasoning(supported: unknown, efforts: unknown, current: unknown): ReasoningInfo | undefined {
  if (supported !== true || !Array.isArray(efforts)) return undefined
  const offered = reasoningLevels.flatMap(level => {
    const item = (efforts as GrokEffort[]).find(effort => effort?.value === level)
    if (!item) return []
    const name = typeof item.label === 'string' && item.label.trim() ? item.label : level
    return [{ id: level, name, ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}) }]
  })
  if (!offered.length) return undefined
  const defaultEffort = offered.find(effort => effort.id === current)?.id
  return mediumDefault({ efforts: offered, ...(defaultEffort ? { defaultEffort } : {}) })
}

/**
 * The largest context window a Grok catalog entry offers. The subscription serves Grok 4.5
 * to 4.7 at 256K by default and 500K on request (`context_windows`); Fig always asks for the
 * largest, as DSH does for DeepSeek. Undefined when the entry names no valid size.
 */
export function largestWindow(current: unknown, choices: unknown): number | undefined {
  const sizes = [current, ...(Array.isArray(choices) ? choices : [])]
    .filter((size): size is number => Number.isSafeInteger(size) && (size as number) > 0)
  return sizes.length ? Math.max(...sizes) : undefined
}
