// The Profile facts main hands to Fig's packages at each start (app/main/profile.ts writes them as plugin config):
// the shell reads them, the page gets them as the `figProfile` service (desktop-skin), and other plugins read the
// public part through `shellCapabilities.profile` (shell-bridge). Shared by main and the packages.

export type Edition = 'personal' | 'team'

/** How the shell around DSH looks in this Profile. Decided by the Profile, never by a plugin. */
export interface ShellProfile {
  /** DSH's "Browse more plugins" / "Create your plugin" rows in the More menus. Off: those menus list only panels and views. */
  pluginMenuActions: boolean
  /** Sidebar panels shown by default; the rest go under More. Undefined: DSH's own default (all shown). */
  pinnedPanels?: string[]
  /** What Task activity shows of its own; every part on unless the descriptor
   * turns it off. A team Profile turns them all off and its plugins draw the rest through figActivity. */
  activity?: ActivityLayout
}

/** Task activity's own parts. */
export interface ActivityLayout {
  /** The view switch when plugins add views. */
  views: boolean
  /** The needs-attention ring and the four figures. */
  figures: boolean
  /** The usage heat map. */
  usage: boolean
  /** The project filter and 「将这些结果标为已读」. */
  filter: boolean
  /** 「需要你处理」: the session groups. */
  sessionGroups: boolean
}

export const activityLayoutKeys = ['views', 'figures', 'usage', 'filter', 'sessionGroups'] as const

/** Fig's task activity panel id (harness/attention). */
export const taskActivityPanel = 'fig-task-activity'

/** What a Profile looks like when its descriptor does not say, the same in every edition (user decision 2026-11-18):
 * every panel shows in the sidebar and DSH's plugin browse/create rows are off.
 * Panel names never change by edition (Task activity stays Task activity, user decision 2026-11-17). */
export function profileShellDefaults(): ShellProfile {
  return { pluginMenuActions: false, pinnedPanels: undefined, activity: { views: true, figures: true, usage: true, filter: true, sessionGroups: true } }
}

export type ExternalPluginStatus =
  /** Installed and selected. */
  | 'ready'
  /** Switched off by the user (optional plugins only). */
  | 'off'
  /** Not installed: the package failed a check or could not be linked; `reason` says why. */
  | 'failed'
  /** Installed but stopped for this launch after it failed to load; it is tried again at the next start. */
  | 'suspended'
  /** A business plugin's package that is not available to this organization (teamPlugins: paused by the platform, not
   * subscribed, or switched off by the tenant); not loaded, not a failure. `unavailable` says which. */
  | 'disabled'

export interface ExternalPluginState {
  /** Package name, once read. */
  name?: string
  version?: string
  source: 'directory' | 'package'
  /** For a directory source, its path; for a package, the archive's file name. */
  origin: string
  required: boolean
  /** The plugin group it belongs to. A failure in the group's base layer stops all of it;
   * a failure in a business plugin stops that plugin only. */
  group?: string
  /** The business plugin it belongs to; absent for the base layer and for packages outside a group. */
  plugin?: string
  /** The business plugin's display name, as its packages declare it (`fig.pluginTitle`). */
  pluginTitle?: string
  /** package.json `description`: one line for the Plugins page. */
  description?: string
  /** Why a `disabled` business plugin is not available. */
  unavailable?: TeamPluginOff
  status: ExternalPluginStatus
  reason?: string
}

/** The Profile as packages see it. */
export interface ProfileState {
  id: string
  edition: Edition
  /** DSH starts in this Profile so far, this one included. */
  dshGeneration: number
  shell: ShellProfile
  plugins: ExternalPluginState[]
  coworkOrigin?: string
  teamModels?: import('./team-models.ts').TeamModels
}

/** What any package may know about the Profile, through `shellCapabilities.profile`. */
export type PublicProfile = Pick<ProfileState, 'id' | 'edition' | 'dshGeneration'>

/** The public part of a Profile, checked: main writes it as shell-bridge config, shell-bridge reads it back. */
export function publicProfile(value: any): Readonly<PublicProfile> | undefined {
  return value && typeof value.id === 'string' && (value.edition === 'team' || value.edition === 'personal') && Number.isSafeInteger(value.dshGeneration)
    ? Object.freeze({ id: value.id, edition: value.edition, dshGeneration: value.dshGeneration }) : undefined
}

/** A required plugin that is not running: the Profile's own features that depend on it are off. */
export const blockedRequired = (state: Pick<ProfileState, 'plugins'>): ExternalPluginState[] =>
  state.plugins.filter(plugin => plugin.required && plugin.status !== 'ready' && plugin.status !== 'disabled')

/** Why a business plugin is not available, highest priority first: the platform paused it (security or
 * fault), the tenant has no subscription, or the tenant admin switched it off. */
export type PluginOffCause = 'platform' | 'unsubscribed' | 'tenant'
export interface TeamPluginOff {
  active: false
  off: PluginOffCause
  /** With `off: "platform"`: the category, Ops' reason and when. */
  platformOff?: { kind: 'security' | 'fault', reason: string, at?: string }
}
const offCauses: readonly PluginOffCause[] = ['platform', 'unsubscribed', 'tenant']

/** A plugin group's or business plugin's name, as a descriptor entry and a package's `fig` block give it. */
export const groupName = /^[a-z0-9][\w.-]{0,63}$/

/**
 * The organization's business plugin availability, from Cowork's `/api/desktop/session` `plugins` or the descriptor's
 * `teamPlugins` (same shape, so reading is idempotent). Each value is a boolean (the earlier form: false = the tenant
 * switched it off) or `{ active, off?, platformOff? }`. Only unavailable plugins are kept; a missing name is on.
 */
export function teamPluginPolicy(value: unknown): Record<string, TeamPluginOff> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, TeamPluginOff> = {}
  for (const [name, item] of Object.entries(value).slice(0, 64)) {
    if (!groupName.test(name)) continue
    if (item === false) { result[name] = { active: false, off: 'tenant' }; continue }
    if (!item || typeof item !== 'object' || (item as any).active !== false) continue
    const raw = item as any
    const platform = raw.platformOff && typeof raw.platformOff === 'object' && (raw.platformOff.kind === 'security' || raw.platformOff.kind === 'fault')
      ? { kind: raw.platformOff.kind, reason: typeof raw.platformOff.reason === 'string' ? raw.platformOff.reason.trim().slice(0, 200) : '',
        ...typeof raw.platformOff.at === 'string' ? { at: raw.platformOff.at.slice(0, 40) } : {} } as TeamPluginOff['platformOff'] : undefined
    const off: PluginOffCause = offCauses.includes(raw.off) ? raw.off : platform ? 'platform' : 'tenant'
    result[name] = { active: false, off, ...off === 'platform' && platform ? { platformOff: platform } : {} }
  }
  return result
}
