import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The DSH Web profile's package.json: the plugin packages installed into it (`dependencies`) and the bundles DSH loads
// (`dsh.profile.bundles`). DSH's Plugins page switches a bundle off by deselecting it, the package staying installed;
// Fig does the same for Fig's bundles (bundles.ts), the Profile's plugins (external-plugins.ts) and a plugin that
// failed at startup (plugin-failure.ts). The file is DSH's, so Fig writes it the way DSH does: two-space JSON.

/** The Web profile's packages as its package.json lists them. */
export interface WebProfileManifest {
  /** dependency name → spec */
  dependencies: Record<string, string>
  /** the selected bundles */
  bundles: string[]
}

const manifestPath = (dshHome: string) => join(dshHome, 'profiles', 'web', 'package.json')

/** The Web profile's packages, or undefined when its package.json is missing or unreadable. */
export async function readWebProfile(dshHome: string): Promise<WebProfileManifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath(dshHome), 'utf8'))
    return { dependencies: { ...manifest?.dependencies ?? {} }, bundles: Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [] }
  } catch { return undefined }
}

/**
 * Rewrites the selected bundles with `change`, which returns the new selection and the bundles it changed. Nothing is
 * written when nothing changed or the manifest lists no selection. Rejects when the manifest cannot be read.
 */
export async function updateSelectedBundles(dshHome: string,
  change: (selected: unknown[], dependencies: Record<string, unknown>) => { next: unknown[], changed: string[] }): Promise<string[]> {
  const path = manifestPath(dshHome)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const selected = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(selected)) return []
  const { next, changed } = change(selected, manifest.dependencies ?? {})
  if (!changed.length) return []
  manifest.dsh.profile.bundles = next
  const temporary = path + '.fig-' + process.pid
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n')
  await rename(temporary, path)
  return changed
}

/** Deselects `bundles` in the Web profile, keeping their packages installed. Returns the bundles it turned off. */
export function deselectBundles(dshHome: string, bundles: readonly string[]): Promise<string[]> {
  return updateSelectedBundles(dshHome, selected => {
    const off = selected.filter((item): item is string => typeof item === 'string' && !item.startsWith('@deepseek-ai/') && bundles.includes(item))
    return { next: selected.filter(item => !off.includes(item as string)), changed: off }
  })
}

/** Selects `bundles` that are installed in the Web profile but not selected. Returns the bundles it turned on. */
export async function selectBundles(dshHome: string, bundles: readonly string[]): Promise<string[]> {
  if (!bundles.length) return []
  return updateSelectedBundles(dshHome, (selected, dependencies) => {
    const on = bundles.filter(name => Object.hasOwn(dependencies, name) && !selected.includes(name))
    return { next: [...selected, ...on], changed: on }
  })
}
