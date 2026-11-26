export type ServicePhase = 'idle' | 'checking' | 'starting' | 'ready' | 'stopping' | 'failed'
type Appearance = 'light' | 'dark' | 'system'
/** The language of Fig's own text: Chinese or English (main/language.ts). */
export type UiLanguage = 'zh' | 'en'
export type EditionAction = 'personal' | 'team' | 'signOut' | 'check' | 'removeDevice'
export interface EditionState {
  edition: 'personal' | 'team'
  available: boolean
  screen?: 'signing-in' | 'waiting' | 'expired' | 'unavailable'
  name?: string
  organization?: string
  adminConsoleUrl?: string
  allowPersonal?: boolean
}

export function appearancePreference(value?: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** A plugin that failed while DSH's page booted, and what the startup page may offer for it (main/plugin-failure.ts). */
export interface PluginFailure {
  /** The failed entries DSH named. */
  plugins: string[]
  /** The profile bundles Fig may turn off for them: the user's own, never DSH's official ones or a required one. */
  disablable: string[]
  /** Required external plugins among them (external-plugins.ts): stopped for one launch only, never turned off. */
  required: string[]
}

/** The UI receives diagnostics, never the authenticated launch URL. */
export interface ServiceState {
  phase: ServicePhase
  message: string
  appVersion?: string
  appearance?: Appearance
  nodeVersion?: string
  workbenchAvailable?: boolean
  /** An automatic workbench reload within the current DSH launch. */
  workbenchRecovery?: 'recovering' | 'rate-limited'
  /** Set while DSH is stopped for a native directory change, so the page does not show startup copy. */
  directoryChange?: boolean
  /** Set on first launch while Fig waits for the user to pick a startup folder; `suggested` is created if accepted. */
  startupChoice?: { suggested: string }
  /** Set when DSH's page could not load a plugin: the failed entries, and the user's bundles Fig can turn off. */
  pluginFailure?: PluginFailure
  /** The language of Fig's own text, following DSH's interface language. */
  language?: UiLanguage
  pid?: number
  error?: string
  logs: string[]
  cowork?: EditionState
}

export interface FigBridge {
  getState(): Promise<ServiceState>
  retry(): Promise<void>
  quit(): Promise<void>
  /** First-run startup folder: the suggested one, or one picked in the native folder dialog. */
  chooseStartup(how: 'suggested' | 'browse'): Promise<void>
  /** After a plugin failure: turn the failed user bundles off and start DSH again. */
  disablePlugins(): Promise<void>
  editionAction(action: EditionAction): Promise<void>
  onState(listener: (state: ServiceState) => void): () => void
}

export const IPC = {
  state: 'fig:state',
  getState: 'fig:get-state',
  retry: 'fig:retry',
  quit: 'fig:quit',
  chooseStartup: 'fig:choose-startup',
  disablePlugins: 'fig:disable-plugins',
  localeRead: 'fig:dsh-locale-read',
  localeChange: 'fig:dsh-locale-change',
  workbenchForeground: 'fig:dsh-foreground',
  editionRead: 'fig:edition-read',
  editionAction: 'fig:edition-action',
  editionChanged: 'fig:edition-changed',
  teamPickFiles: 'fig:dsh-team-pick-files'
} as const
