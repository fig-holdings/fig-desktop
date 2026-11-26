import type { PluginFailure } from '../shared/protocol'
import { readWebProfile } from './web-profile'

// A plugin that fails while the DSH page boots keeps the whole workbench from opening: DSH replaces its loading card
// with "Failed to load plugins" and the failed entries, and offers no way out in the page. Fig reads that card,
// shows the failure on its own startup page and can turn the user's plugin bundles off, as DSH's Plugins page does
// (it deselects the bundle in the Web profile's package.json; the package stays installed).

/** Runs in the DSH page. While the boot card is up: 'loading', or 'failed' with its lines; 'gone' once DSH mounted. */
export const bootStateScript = `(() => {
  const root = document.querySelector('[data-dsh-boot]')
  if (!root) return { state: 'gone' }
  const lines = root.innerText.split('\\n').map(line => line.trim()).filter(Boolean)
  const at = lines.indexOf('Failed to load plugins')
  return at < 0 ? { state: 'loading' } : { state: 'failed', lines: lines.slice(at + 1, at + 41).map(line => line.slice(0, 400)) }
})()`

export type { PluginFailure }

// From DSH 0.2.2-rc.2 an optional plugin that fails no longer stops the boot: the workbench opens without it and DSH
// warns in the page console, e.g. "web boot: warning: 1 entry did not activate\nfig-broken-probe: import failed (…)".
// That warning is how Fig learns a plugin update did not load. It is DSH's console text, not an interface: re-check
// it on each DSH upgrade (npm run dsh:verify); removal condition: DSH reports inactive client entries through an interface.
const bootWarning = /^web boot: warning: \d+ entr(?:y|ies) did not activate\n/

/** The entries a DSH boot warning names, or none when `message` is not that warning. */
export function inactiveEntries(message: string): string[] {
  if (!bootWarning.test(message)) return []
  return failedPlugins(message.split('\n').slice(1).map(line => line.split(':')[0]?.trim() ?? ''))
}

const packageName = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.-]+)*$/i

/** The failed entry names among the card's lines; the other lines are DSH's error text. */
export function failedPlugins(lines: readonly string[]): string[] {
  return [...new Set(lines.filter(line => packageName.test(line)))]
}

/** The selected profile bundles that own `plugins` (the bundle itself or one of its subpaths), excluding DSH's own. */
export function bundlesFor(plugins: readonly string[], bundles: readonly string[]): string[] {
  return bundles.filter(bundle => !bundle.startsWith('@deepseek-ai/')
    && plugins.some(plugin => plugin === bundle || plugin.startsWith(bundle + '/')))
}

/** What the startup page offers for this failure. `required`: the Profile's required external plugins. */
export async function describeFailure(dshHome: string, lines: readonly string[], required: ReadonlySet<string> = new Set()): Promise<PluginFailure> {
  const plugins = failedPlugins(lines)
  const bundles = (await readWebProfile(dshHome))?.bundles ?? []
  const owners = bundlesFor(plugins, bundles.filter(item => typeof item === 'string'))
  return { plugins, disablable: owners.filter(name => !required.has(name)), required: owners.filter(name => required.has(name)) }
}
