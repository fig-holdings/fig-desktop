import { join } from 'node:path'
import { writeRecord } from '../../harness/shared/atomic-json.ts'
import { publicProfile, type ProfileState } from '../../harness/shared/profile-contract.ts'
import type { WorkbenchProviderEntry } from './external-plugins'

// Fig's plugin packages take their settings as plugin config, not environment variables
// (DSH hands each package its own plugin config). At each start main writes a patch layer of config rows for the Web
// profile, one per package that needs settings, under the DSH home. A row `{ id, config }` replaces that entry's
// config. Being rewritten at every start, an edit to this file lasts only until Fig starts DSH again.

export interface PluginSettings {
  /** Where Fig starts DSH; parent AGENTS.md rules are read from here down to the project's Git root. */
  startupDirectory: string
  /** The data folder before the last move, while it can still be restored. */
  previousDshHome?: string
  /** The extra skill folder. */
  skillDirectory?: string
  /** How the shell-bridge starts this app in capture mode for the `preview` tool. */
  previewRenderer?: { executable: string, args: string[] }
  /** This Profile (profile.ts): desktop-skin applies its shell look, shell-bridge lends its public facts. */
  profile?: ProfileState
  workbenchProvider?: WorkbenchProviderEntry
}

type Row = { id: string, config: Record<string, unknown> } | { id: string, disabled: true }

const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))

/** The Web profile's rows. */
export function webConfigRows(settings: PluginSettings): Row[] {
  return [
    { id: 'fig-desktop-skin', config: defined({ startupDirectory: settings.startupDirectory, previousDshHome: settings.previousDshHome, skillDirectory: settings.skillDirectory, profile: settings.profile }) },
    { id: 'fig-rule-sources', config: { startupDirectory: settings.startupDirectory } },
    { id: 'fig-instructions', config: { startupDirectory: settings.startupDirectory } },
    { id: 'fig-skills', config: defined({ directory: settings.skillDirectory }) },
    { id: 'fig-shell-bridge', config: defined({ renderer: settings.previewRenderer, profile: publicProfile(settings.profile), coworkOrigin: settings.profile?.coworkOrigin, teamModels: settings.profile?.teamModels }) },
    { id: 'fig-development-workbench', config: defined({ githubSource: settings.profile?.edition === 'team' ? 'mixed' : 'local', workbenchProvider: settings.workbenchProvider }) },
    ...settings.profile?.edition === 'team' ? [
      ...['deepseek-account', 'llm-deepseek-account', 'ui-settings-account', 'ui-account-notifications'].map(id => ({ id, disabled: true as const })),
      { id: 'web', config: { searchProvider: 'fig-follow-model' } },
      { id: 'fig-web-search', config: { team: true, organizationProviders: settings.profile.teamModels?.organizationProviders ?? [] } },
      ...settings.profile.teamModels?.defaultModel ? [{ id: 'agent-default-model', config: { ...settings.profile.teamModels.defaultModel } }] : []
    ] : [],
    // The Profile turns DSH's plugin browse/create rows off by switching off the package that adds them
    // (dsh-client-ui-entry-customization, inserted by dsh-web-app); desktop-skin then fills the More menus itself.
    ...settings.profile?.shell.pluginMenuActions === false ? [{ id: 'entry-customization', disabled: true as const }] : []
  ]
}

/** Writes the Web profile's layer under `<dshHome>/fig/launch/` and returns it, to load after the packages.
 * `switchedOff`: insert ids of bundles the user switched off on the Plugins page; their rows are left out, since a
 * row naming an absent entry makes DSH warn. */
export async function writePluginConfig(dshHome: string, settings: PluginSettings, switchedOff: ReadonlySet<string> = new Set()): Promise<string> {
  const web = join(dshHome, 'fig', 'launch', 'web.patch.yml')
  // JSON is YAML; DSH reads the layer as a patch list.
  await writeRecord(web, webConfigRows(settings).filter(row => !switchedOff.has(row.id)))
  return web
}
