const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Launch links and credential-shaped strings cannot enter renderer diagnostics or Fig's logs. */
export function sanitizeLog(text: string): string {
  return stripAnsi(text)
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, '$1?[授权参数已隐藏]')
    .replace(/\b(?:sk-|xai-)[A-Za-z0-9_-]{12,}\b/g, '[凭据已隐藏]')
    .replace(/(["']?[\w-]*(?:token|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
}

/** One sanitized, trimmed and bounded diagnostic line; empty when nothing is left. */
export function logLine(text: string): string {
  return sanitizeLog(text).trim().slice(0, 1500)
}

/** An error's message, or the thrown value as text when it is not an Error. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
