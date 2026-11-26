import { figOrange } from '../shared/brand-colors.js'
import { watchPage } from '../shared/page-observer.js'
import { installNavPill, navPillCss } from './client-nav-pill.js'

// Fig VI v0.4. Color uses the public ThemeRuntime override layer. DSH 0.2.2-rc.1 has no slot for the rest, so this
// file keeps those local adapters scoped here: the creation buttons' fill, the running state mark and the 推理执行中
// running label. Re-check them on each DSH upgrade (npm run dsh:verify).
export const brandTokens = Object.fromEntries(Object.entries({
  'brand-primary': [figOrange, figOrange],
  'brand-primary-invert': [figOrange, figOrange],
  'brand-text': ['#b64000', '#ff8a4c'],
  'state-business-primary': ['#b64000', '#ff8a4c'],
  'state-business-tertiary': ['#fff0e6', '#382218'],
  'label-primary-bluish': ['#b64000', '#ff8a4c'],
  'label-deep-diving': ['#b64000', '#ff8a4c'],
  'label-deep-diving-shimmer': [figOrange, '#ffc29f'],
  'link': ['#b64000', '#ff8a4c'],
  'button-info-fill': [figOrange, figOrange],
  'button-info-hover': ['#e85a0c', '#ff843f'],
  'button-primary-fill': [figOrange, figOrange],
  'button-primary-hover': ['#e85a0c', '#ff843f'],
  'button-primary-dimmed': ['#ffd6bd', '#6b351b']
}).map(([key, [light, dark]]) => [`--dsw-alias-${key}`, {light, dark}]))

// Dark mode keeps two surfaces and two text greys. Surfaces:
// the page (bg-base) and the sidebar's fill, which every card, panel, composer card and popover takes instead of
// DSH's layer-1/layer-2 and input-major; depth comes from DSH's borders and hover tint. Controls drawn with layer-3
// or brand fills are untouched. Text, as white opacity (user 2026-11-20):
// primary 95%, secondary 50% (about openllm.sh's muted #8a8a8a on either surface); tertiary and caption (placeholders,
// hints) fold into secondary. Light (§4.3 items 7, 8) keeps three surfaces: the sidebar #f9fafb, the page bg-base
// #f5f6f7 (DSH's neutral-bluish-60, its module-platform fill) and white cards; text is black 95% and 60%.
// DSH's Plugins page paints no page background, so it showed the frame's sidebar fill under a sticky header whose
// ::before paints bg-base, a visible seam in dark. brandCss gives its panel bg-base in both themes (user 2026-11-20).
// Local adaptation on DSH 0.2.2-rc.5's section[data-plugin-panel]; remove once DSH paints the page itself.
// Its header tabs (DSH SegmentedTabs: a track and a sliding indicator) are redrawn as the 自动化任务 page's filter
// pills (TaskManagerPage filterTab: 28px, radius 14, 14/22 text, hover tint for hover and selection; user 2026-11-20),
// scoped to [data-plugin-header-part="tabs"]; remove once DSH draws the two alike.
// DSH's module panel ([data-global-panel]: 任务动态, 插件, 自动化任务) has the conversation body's 12px corner and line
// but does not clip, so the page's own square background hid the corner. overflow:clip (no scroll container, sticky
// headers unaffected) shows it like 新会话 (user 2026-11-20); remove once DSH clips the panel itself.
export const surfaceTokens = {
  ...Object.fromEntries(['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-specific-input-major']
    .map(name => [name, {light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-specific-sidebar-fill)'}])),
  '--dsw-alias-bg-base': {light: 'var(--dsw-static-neutral-bluish-60)', dark: 'var(--dsw-static-neutral-bluish-950)'},
  '--dsw-alias-label-primary': {light: 'rgba(0, 0, 0, .95)', dark: 'rgba(255, 255, 255, .95)'},
  '--dsw-alias-label-secondary': {light: 'rgba(0, 0, 0, .6)', dark: 'rgba(255, 255, 255, .5)'},
  '--dsw-alias-label-tertiary': {light: 'rgba(0, 0, 0, .6)', dark: 'rgba(255, 255, 255, .5)'},
  '--dsw-alias-label-caption': {light: 'rgba(0, 0, 0, .6)', dark: 'rgba(255, 255, 255, .5)'}
}

// Team Profiles in dark take OpenLLM's two layers instead (the personal
// edition keeps the two surfaces above): page #010101; sidebar, top bar, cards, panels and popovers #09090b (layer-1 follows the
// sidebar fill through surfaceTokens); the composer card one step lighter #18181b with its attachment button #2c2c2e;
// borders l2 10% and l3 14% (l1 unchanged); hover and selection 6%; layer-2, the in-card wash, white 5%. Text keeps the
// two greys above. Light values are DSH's own or surfaceTokens', so both editions stay identical in light. The
// personal edition keeps #151517 / #1b1b1c.
export const teamDarkTokens = {
  '--dsw-alias-bg-base': {light: 'var(--dsw-static-neutral-bluish-60)', dark: '#010101'},
  '--dsw-specific-sidebar-fill': {light: 'var(--dsw-static-neutral-bluish-50)', dark: '#09090b'},
  '--dsw-alias-bg-layer-2': {light: 'var(--dsw-static-neutral-bluish-00)', dark: 'rgba(255, 255, 255, .05)'},
  '--dsw-specific-input-major': {light: 'var(--dsw-static-neutral-bluish-00)', dark: '#18181b'},
  '--dsw-specific-selector': {light: 'var(--dsw-static-neutral-bluish-60)', dark: '#2c2c2e'},
  '--dsw-alias-border-l2': {light: '#0000001a', dark: 'rgba(255, 255, 255, .1)'},
  '--dsw-alias-border-l3': {light: '#0000001f', dark: 'rgba(255, 255, 255, .14)'},
  '--dsw-alias-interactive-bg-hover': {light: '#2631480f', dark: 'rgba(255, 255, 255, .06)'}
}

// Fig's own cards (figUi Card, Metric, RingMetric, GroupCard) follow the team plugins' .cw-pn in team dark: no border,
// a 6.5% white ring and a faint shadow. Light keeps the thin border. light-dark() follows the scheme DSH sets.
export const teamCss = `
:root[data-fig-team] .fig-ui-card{border-color:light-dark(var(--dsw-alias-border-l2),transparent);box-shadow:0 0 0 1px light-dark(transparent,rgb(255 255 255 / 6.5%)),0 1px 3px light-dark(transparent,rgb(0 0 0 / 10%)),0 1px 2px -1px light-dark(transparent,rgb(0 0 0 / 10%))}
`

export const brandCss = `
body{--fig-orange:${figOrange};--fig-orange-hover:light-dark(#e85a0c,#ff843f);--fig-orange-active:light-dark(#cf4e06,#e85a0c);--fig-on-orange:#14161b;--fig-control-on-orange:#fff;--fig-mark-ink:light-dark(#14161b,#f3f1ec)}
[data-slot="sidebar"] button[class*="_newSession"],button[data-fig-create]{background:var(--fig-orange)!important;color:var(--fig-on-orange)!important;border-color:transparent!important;transition:background-color .15s}
[data-slot="sidebar"] button[class*="_newSession"]:hover:not(:disabled),button[data-fig-create]:hover:not(:disabled){background:var(--fig-orange-hover)!important}
[data-slot="sidebar"] [class*="_newSessionShortcut"]{color:var(--fig-on-orange)}
[data-slot="sidebar"] button[class*="_newSession"]:active:not(:disabled),button[data-fig-create]:active:not(:disabled){background:var(--fig-orange-active)!important}
button[class*="_primary"],button[data-sending]{--dsw-alias-label-primary-foreground:var(--fig-on-orange)}
[data-composer-seat] button[class*="_primary"]{color:var(--fig-control-on-orange)}
[role="switch"][aria-checked="true"]{background:var(--fig-orange)}
[role="switch"][aria-checked="true"]:hover:not(:disabled){background:var(--fig-orange-hover)}
[role="switch"][aria-checked="true"]>span{background:#fff}
[data-chat-running] [class*="_runningIcon"]{width:20px;height:21px;contain:none;overflow:visible}
[data-chat-running] [class*="_runningIcon"]>:not([data-fig-state-mark]){display:none!important}
[data-fig-state-mark]{display:block;flex:none;overflow:visible;color:var(--fig-mark-ink)}
[data-fig-state-mark] .fig-signal{fill:var(--fig-orange);transform-origin:112px 72px;animation:fig-signal-breathe 1.4s ease-in-out infinite}
[data-fig-state-mark="waiting"] .fig-signal{animation:none}
[data-fig-state-mark] .fig-ripple{fill:none;stroke:var(--fig-orange);stroke-width:3;transform-origin:112px 72px;animation:fig-signal-ripple 1.6s ease-out infinite}
@keyframes fig-signal-breathe{0%,100%{transform:scale(1)}50%{transform:scale(.625)}}
@keyframes fig-signal-ripple{from{transform:scale(1);opacity:1}to{transform:scale(2.125);opacity:0}}
[data-fig-task-state="waiting"]{color:var(--dsw-alias-label-deep-diving)}
section[data-plugin-panel]{background:var(--dsw-alias-bg-base)}
[data-global-panel]{overflow:clip}
[data-plugin-header-part="tabs"] [role="tablist"]{display:flex!important;flex-wrap:wrap;align-items:center;gap:8px 12px;width:auto;min-width:0;height:auto;padding:0!important;border-radius:0;background:transparent!important}
[data-plugin-header-part="tabs"] [role="tablist"]>[aria-hidden="true"]{display:none!important}
[data-plugin-header-part="tabs"] [role="tab"]{flex:none;width:auto!important;height:28px!important;padding:0 10px!important;border:0!important;border-radius:14px!important;background:transparent!important;color:var(--dsw-alias-label-tertiary)!important;font-size:14px!important;font-weight:400!important;line-height:22px!important;white-space:nowrap}
[data-plugin-header-part="tabs"] [role="tab"]:hover,[data-plugin-header-part="tabs"] [role="tab"][aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover)!important}
[data-plugin-header-part="tabs"] [role="tab"][aria-selected="true"]{color:var(--dsw-alias-label-primary)!important}
@media(prefers-reduced-motion:reduce){[data-fig-state-mark] .fig-signal,[data-fig-state-mark] .fig-ripple{animation:none}[data-fig-state-mark] .fig-ripple{transform:scale(1.5);opacity:.65}[data-sending] svg{animation:none!important}}
`

function stateMark(state) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '-16 -16 176 168')
  svg.setAttribute('width', '20'); svg.setAttribute('height', '21')
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('data-fig-state-mark', state)
  svg.innerHTML = '<path d="M0 0h112v32H0Z M0 56h32v80H0Z M0 56h84v32H0Z" fill="currentColor"/>'
    + (state === 'waiting' ? '<circle class="fig-ripple" cx="112" cy="72" r="16"/>' : '')
    + '<circle class="fig-signal" cx="112" cy="72" r="16"/>'
  return svg
}

export function installBrand(ctx, profile) {
  const source = '@local/dsh-desktop-skin'
  let disposeTokens = ctx.theme.overrideTokens(source, {...brandTokens, ...surfaceTokens})
  const style = document.createElement('style'); style.textContent = brandCss; document.head.append(style)
  // The edition is known once the Profile is read; a second call with the same source replaces the whole layer.
  let active = true, stopPill = () => {}
  void profile?.ready.then(value => {
    if (!active || value?.edition !== 'team') return
    disposeTokens = ctx.theme.overrideTokens(source, {...brandTokens, ...surfaceTokens, ...teamDarkTokens})
    style.textContent = brandCss + teamCss + navPillCss
    document.documentElement.setAttribute('data-fig-team', '')
    stopPill = installNavPill()
  })
  const owned = new Set(), marked = new Set()
  const labels = new Map(), shimmerLabels = new Map()
  function syncRunningLabels() {
    for (const row of document.querySelectorAll('[data-chat-running]')) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = /** @type {Text} */ (walker.currentNode)
        if (!node.data.includes('深度求索中')) continue
        const original = node.data, applied = original.replace('深度求索中', '推理执行中')
        labels.set(node, {original, applied}); node.data = applied
      }
      // TextShimmer paints its highlight through ::after content: attr(data-shimmer-text),
      // not a text node. Both copies must change before the browser paints the sweep.
      for (const node of row.querySelectorAll('[data-shimmer-text]')) {
        const original = node.getAttribute('data-shimmer-text') ?? ''
        if (!original.includes('深度求索中')) continue
        const applied = original.replace('深度求索中', '推理执行中')
        shimmerLabels.set(node, {original, applied}); node.setAttribute('data-shimmer-text', applied)
      }
    }
    for (const node of labels.keys()) if (!node.isConnected) labels.delete(node)
    for (const node of shimmerLabels.keys()) if (!node.isConnected) shimmerLabels.delete(node)
  }
  let frame = 0
  function markCreateButtons() {
    // Neutral/outline creation controls do not consume the primary-button token. Mark only
    // native settings/plugin creation buttons, never destructive actions or user transcript text.
    for (const button of document.querySelectorAll('[data-shortcut-modal="settings"] button,[data-slot="main"] button')) {
      const label = (button.getAttribute('aria-label') || button.textContent || '').trim()
      const create = /^(新建|创建|添加插件|安装插件|New\b|Create\b|Add plugin\b|Install plugin\b)/i.test(label)
        && !button.closest('[data-conversation-content],[role="menu"]')
      if (create) {button.setAttribute('data-fig-create', '');marked.add(button)}
      else if (marked.has(button)) {button.removeAttribute('data-fig-create');marked.delete(button)}
    }
  }
  function scan() {
    frame = 0
    const statuses = ctx.uiSession.sessionStatus.getSnapshot()
    for (const row of document.querySelectorAll('[data-chat-running]')) {
      const id = row.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
      const state = statuses.get(id)?.pendingInteraction ? 'waiting' : 'running'
      row.setAttribute('data-fig-task-state', state);marked.add(row)
      const host = row.querySelector('[class*="_runningIcon"]')
      const previous = host?.querySelector('[data-fig-state-mark]')
      if (!host || previous?.getAttribute('data-fig-state-mark') === state) continue
      if (previous) {previous.remove();owned.delete(previous)}
      const mark = stateMark(state); host.append(mark);owned.add(mark)
    }
    for (const node of owned) if (!node.isConnected) owned.delete(node)
    for (const node of marked) if (!node.isConnected) marked.delete(node)
  }
  const schedule = () => {if (!frame) frame = requestAnimationFrame(scan)}
  // The page observer runs at the microtask checkpoint, before paint; deferring the labels to requestAnimationFrame
  // can expose the original text for a frame. Only changes in a running row wake this while a reply streams.
  const stopLabels = watchPage({ name: 'brand running label', timing: 'sync', childList: true, characterData: true,
    attributes: ['data-shimmer-text'], within: '[data-chat-running]', ignore: null, run: () => { syncRunningLabels(); schedule() } })
  // Streaming replies change only the conversation's content, which holds no creation button: the default ignore skips it.
  const stopButtons = watchPage({ name: 'brand create buttons', childList: true, characterData: true, run: markCreateButtons })
  const unsubscribe = ctx.uiSession.sessionStatus.subscribe(schedule)
  syncRunningLabels(); markCreateButtons(); scan()
  return () => {
    stopLabels();stopButtons();unsubscribe();cancelAnimationFrame(frame)
    for (const node of owned) node.remove()
    for (const node of marked) {node.removeAttribute('data-fig-create');node.removeAttribute('data-fig-task-state')}
    for (const [node, {original, applied}] of labels) if (node.data === applied) node.data = original
    for (const [node, {original, applied}] of shimmerLabels) if (node.getAttribute('data-shimmer-text') === applied) node.setAttribute('data-shimmer-text', original)
    active = false; stopPill(); document.documentElement.removeAttribute('data-fig-team'); style.remove(); disposeTokens()
  }
}
