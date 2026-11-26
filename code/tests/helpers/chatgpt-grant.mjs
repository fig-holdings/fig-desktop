/** The stored grant payload; the record is plain `key: value` scalars plus the scopes list. */
export function grantPayload(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === 'fig-chatgpt/subscription:')
  if (start < 0) throw new Error('No ChatGPT sign-in in Fig. Sign in under Settings → ChatGPT 账号 first.')
  const payload = { scopes: [] }
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break
    const item = line.match(/^ {8}- (.+)$/)
    if (item) { payload.scopes.push(item[1]); continue }
    const field = line.match(/^ {6}(\w+): (.+)$/)
    if (field) payload[field[1]] = field[1] === 'expires' ? Number(field[2]) : field[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return payload
}
