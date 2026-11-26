// Threshold ③ e: DSH market plugins that do what Fig already does natively. Installing one is allowed; Fig reminds
// before installing (the 添加插件 dialog) and after (the Plugins page). Only clear overlaps are listed; a suite that
// covers much more is left out. First batch picked from the dshmarket index on 2026-11-08;
// add packages when Fig gains a native feature.

/** @typedef {'side-chat' | 'keep-awake' | 'input-history' | 'usage-heatmap' | 'chatgpt' | 'grok' | 'subscriptions' | 'codex-ui' | 'development-workbench'} Feature
 * The Fig feature, named in the page's dictionary (client-locale.js, `plugin-overlaps.feature.<id>`). */
/** @typedef {{feature: Feature, packages: string[], partial?: boolean}} Overlap */

/** @type {Overlap[]} */
export const pluginOverlaps = [
  { feature: 'side-chat', packages: ['@michengai/dsh-btw', 'dsh-btw-marginalia', 'dsh-quick-ask', '@wlv-zedd/dsh-btw-plugin', 'dsh-btw-plugin',
    'dsh-side-chat-plus', 'dsh-side-chat-plus-plus', 'dsh-sidenote', 'dsh-assist-chat'] },
  { feature: 'keep-awake', packages: ['dsh-keep-awake', 'dsh-mac-keep-awake', '@zi7tian/dsh-keep-awake'] },
  { feature: 'input-history', packages: ['dsh-nonead-prompt-recall', 'dsh-keyboard-history', 'dsh-composer-history', '@wenaixi/dsh-prompt-history',
    'dsh-composer-recall', 'dsh-prompt-history', '@sunshaobei/dsh-input-history'] },
  { feature: 'usage-heatmap', packages: ['dsh-token-total', 'dsh-usage-statistics-panel', 'dsh-token-pulse', '@kidli1412/dsh-token-heatmap',
    '@duke-dsh-plugins/dsh-token-stats', 'dsh-token-usage-counter'] },
  { feature: 'chatgpt', packages: ['dsh-gpt-link', '@tnnevol/dsh-codex-auth', 'dsh-plugin-chatgpt', 'dsh-codex-connect',
    'dsh-codex-connect-plus', 'dsh-codex-auth', '@sunshaobei/dsh-codex-auth', 'dsh-codex-subscription', 'dsh-codex-subscription-en', 'dsh-codex-community',
    'dsh-codex-switch', '@wnjxyk/dsh-codex-oauth'] },
  { feature: 'grok', packages: ['dsh-xai-oauth', 'dsh-grok-provider', 'dsh-grok-kit'] },
  { feature: 'subscriptions', partial: true,
    packages: ['@goodandready/dsh-subscriptions', 'dsh-plugin-subscriptions', 'dsh-coding-subscription-oauth'] },
  { feature: 'codex-ui', partial: true, packages: ['@michengai/dsh-codex-ui'] },
  // DSH's own experimental Forge is turned on from the Plugins page, so it shows up in the profile's bundles, not its
  // dependencies. Fig keeps its development workbench while Forge is experimental.
  { feature: 'development-workbench', partial: true, packages: ['@deepseek-ai/dsh-experimental-forge-bundle'] }
]

/** The package a spec names: drops a version or tag (`name@1.2.0`, `@scope/name@latest`) and surrounding space. */
export function packageOf(spec) {
  const value = String(spec ?? '').trim()
  const match = /^(@[^/@\s]+\/[^@\s]+|[^@\s]+)(@\S*)?$/.exec(value)
  return match ? match[1].toLowerCase() : ''
}

/** The Fig feature a package duplicates, if listed. */
export function overlapOf(spec) {
  const name = packageOf(spec)
  return name ? pluginOverlaps.find(overlap => overlap.packages.includes(name)) : undefined
}
