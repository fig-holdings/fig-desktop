import { join } from 'node:path'
import type { DirectorySettings } from './directory-settings'

// Fig does not assume a startup folder: on first launch the user picks one, with ~/Fig suggested.

/** The folder the first-run step suggests, created when accepted. */
export const suggestedStartup = (home: string): string => join(home, 'Fig')

export type StartupPlan =
  | {kind: 'saved'}
  | {kind: 'choose'; suggested: string}

/** With no saved startup folder the user is asked. A saved choice is left to DirectorySettings.load. */
export async function planStartup(settings: DirectorySettings, {home}: {home: string}): Promise<StartupPlan> {
  if ((await settings.read()).startup) return {kind: 'saved'}
  return {kind: 'choose', suggested: suggestedStartup(home)}
}
