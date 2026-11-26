// The DSH plugin packages Fig loads, one row each. The build
// (electron.vite.config.ts), the app's web patches and their config (app/main/plugin-config.ts) and the real harness
// smoke all derive from this table. Each package lives in harness/<name>/ and is built to work/build/main/<name>/.

export interface FigPlugin {
  /** Directory under harness/ and under the build output. */
  name: string
  /** The package's insert id in its cordis.patch.yml; Fig's config rows name it. Kept from earlier releases. */
  id: string
  /** Files DSH loads from the package directory; `client.js` is bundled as a classic page script. */
  assets: readonly string[]
  /** Host scripts bundled by Rollup as `<name>/<entry>.js`; `index` is the package's host entry. */
  entries: readonly string[]
  /** Installed into the Web profile as a plugin bundle (app/main/bundles.ts), so DSH's Plugins page lists it and the
   * user can switch it off; otherwise patched in at launch as part of Fig itself. */
  bundle: boolean
}

const page = ['package.json', 'cordis.patch.yml', 'client.js']
const host = ['package.json', 'cordis.patch.yml']
// A bundle's display title and description on the Plugins page, per interface language.
const locale = ['locale/zh.json', 'locale/en.json']
// A bundle also carries bundle.patch.yml, which inserts it by package name (see bundle.patch.yml).
const bundled = [...locale, 'bundle.patch.yml']

// Order is the app's patch order.
export const figPlugins: readonly FigPlugin[] = [
  { name: 'provider-grok', id: 'fig-grok-provider', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'provider-chatgpt', id: 'fig-chatgpt-provider', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'web-search', id: 'fig-web-search', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'desktop-skin', id: 'fig-desktop-skin', assets: page, entries: ['index'], bundle: false },
  // The shell's channel: bootstrap.js is run by main around DSH, not loaded by it.
  { name: 'shell-bridge', id: 'fig-shell-bridge', assets: [...page, 'bootstrap.js', 'openai-catalog-bootstrap.js'], entries: ['index'], bundle: false },
  { name: 'side-chat', id: 'fig-side-chat', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'project-navigation', id: 'fig-project-navigation', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'composer', id: 'fig-composer', assets: [...page, ...bundled, 'NOTICE', 'LICENSE-dsh-codex-ui'], entries: ['index'], bundle: true },
  { name: 'rule-sources', id: 'fig-rule-sources', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'preview', id: 'fig-preview', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'skills-dir', id: 'fig-skills', assets: [...host, ...bundled], entries: ['index'], bundle: true },
  { name: 'instructions', id: 'fig-instructions', assets: [...host, ...bundled], entries: ['index'], bundle: true },
  { name: 'delegate', id: 'fig-agents', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'handoff', id: 'fig-session', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'attention', id: 'fig-attention', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  { name: 'development-workbench', id: 'fig-development-workbench', assets: [...page, ...bundled], entries: ['index'], bundle: true },
  // Shared page pieces (the figUi service) for Fig's panels and team plugins. Part of Fig itself, so it is patched in
  // and cannot be switched off; it still carries a bundle patch for a Profile without Fig's shell (DSH Web in the cloud).
  { name: 'ui-kit', id: 'fig-ui-kit', assets: [...page, 'index.js', ...bundled], entries: [], bundle: false },
  // The brand is a page plugin only; its small host file is copied rather than bundled.
  { name: 'desktop-brand', id: 'fig-sidebar-brand', assets: [...page, 'index.js'], entries: [], bundle: false }
]

/** The packages installed as Web profile bundles; the rest are patched in at launch. */
export const bundlePlugins = figPlugins.filter(plugin => plugin.bundle)
