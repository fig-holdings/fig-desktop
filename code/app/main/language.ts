// Fig's own text (menus, dialogs, the startup page, notifications) follows the DSH interface language. Fig offers
// Chinese and English only: any other language reads as English, and DSH's other languages are hidden in the page.
import { useUiLanguage } from '../../harness/shared/ui-text'
import type { UiLanguage } from '../shared/protocol'

export type { UiLanguage }

/** Chinese for any zh tag, English for every other tag; undefined when there is no tag. */
export function uiLanguageOf(tag: unknown): UiLanguage | undefined {
  if (typeof tag !== 'string' || !tag.trim()) return undefined
  return /^zh/i.test(tag.trim()) ? 'zh' : 'en'
}


let current: UiLanguage = 'zh'
const listeners = new Set<(language: UiLanguage) => void>()

/** The language Fig's own text uses now. */
export const uiLanguage = (): UiLanguage => current
// Host-side text shared with the packages (harness/shared/ui-text.ts) follows this state in the main process.
useUiLanguage(uiLanguage)

/** Picks the Chinese or English text for the current language. */
export const tr = (zh: string, en: string): string => current === 'zh' ? zh : en

/** Switches Fig's own text; listeners run only on a change. */
export function setUiLanguage(language: UiLanguage): void {
  if (language === current) return
  current = language
  for (const listener of listeners) listener(language)
}

export function onUiLanguageChange(listener: (language: UiLanguage) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * What the DSH page receives through `__DSH_LOCALE__`: the system languages reduced to zh/en, so DSH's own
 * automatic choice never lands on a language Fig hides, and the stored preference reduced the same way (a
 * language chosen before Fig hid it opens in English).
 */
export function localeBootstrap(systemLanguages: readonly string[], preference: string | undefined) {
  const languages = [...new Set(systemLanguages.map(uiLanguageOf).filter((tag): tag is UiLanguage => Boolean(tag)))]
  return { languages: languages.length ? languages : ['en'], preference: uiLanguageOf(preference) ?? null }
}
