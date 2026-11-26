import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.js'

// Text a person reads (errors, sign-in messages, startup problems) follows the DSH interface language, Chinese or
// English. Fig's main process registers its own language state; a DSH Host process reads the preference DSH stored in
// its home (dshHome(): DSH_HOME, else ~/.fig, the same folder the plugins use),
// and before DSH has stored one, the process's message locale (LC_ALL, LC_MESSAGES, LANG); Chinese when none is set.

type Language = 'zh' | 'en'
let source: (() => Language) | undefined

/** Main process only: its own language state answers instead of the DSH files. */
export function useUiLanguage(current: () => Language): void { source = current }

/** The locale.preference in a DSH patch file; DSH writes `- id: locale` entries with a `config.preference`. */
function preferenceIn(path: string): string | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  let found: string | undefined
  for (const entry of text.split(/^- /m)) {
    if (!/^id:\s*['"]?locale['"]?\s*$/m.test(entry)) continue
    const match = /^\s+preference:\s*['"]?([A-Za-z-]+)/m.exec(entry)
    if (match) found = match[1]
  }
  return found
}

function language(): Language {
  if (source) return source()
  const home = dshHome()
  const stored = preferenceIn(join(home, 'cordis.patch.yml')) ?? preferenceIn(join(home, 'profiles/web/cordis.patch.yml'))
  const tag = stored ?? (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || undefined)
  return tag && !/^(zh|C$|POSIX$)/i.test(tag) ? 'en' : 'zh'
}

/** The Chinese or English text for the current interface language. */
export const uiText = (zh: string, en: string): string => language() === 'en' ? en : zh
