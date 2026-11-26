import { sharedText } from './page-locale.js'
import { joinedText } from './message-text.js'

// The row Fig's own tools draw in the conversation, registered in DSH's keyed `tool.call.toolview` slot (one view per
// wire tool name; a tool without one gets DSH's generic row). DSH's own ToolRow is not exported, so this is a small
// row of Fig's own in DSH's theme tokens: a header that opens and closes, an optional strip that always shows, and a
// body shown when open. Each view reads the tool's `meta` (the tool's `presentationMeta`); a result recorded before
// the tool had one falls back to its text.

const styleId = 'fig-tool-view-style'
const secondary = 'var(--dsw-alias-label-secondary)', primary = 'var(--dsw-alias-label-primary)', border = 'var(--dsw-alias-border-l2)'
export const toolViewCss = `
.fig-tool{font-size:13px;line-height:20px;color:${secondary};min-width:0}
.fig-tool-head{display:flex;align-items:center;gap:6px;min-width:0}
.fig-tool-toggle{all:unset;display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;cursor:pointer;border-radius:6px}
.fig-tool-toggle:focus-visible{outline:2px solid ${primary};outline-offset:2px}
.fig-tool-toggle:hover .fig-tool-title{color:${primary}}
.fig-tool-title{flex:none;font-weight:500}
.fig-tool-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fig-tool[data-state="error"] .fig-tool-summary{color:var(--dsw-alias-state-error-primary,#d9534f)}
.fig-tool-chevron{flex:none;width:12px;height:12px;transition:transform .12s}
.fig-tool[data-open="true"] .fig-tool-chevron{transform:rotate(90deg)}
.fig-tool-strip{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 2px 18px}
.fig-tool-body{margin:6px 0 4px 18px;padding:8px 10px;border:1px solid ${border};border-radius:8px;min-width:0}
.fig-tool-text{margin:0;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;color:${secondary};max-height:320px;overflow:auto}
.fig-tool-button{all:unset;flex:none;cursor:pointer;padding:1px 10px;border:1px solid ${border};border-radius:999px;font-size:12px;line-height:20px;color:${primary}}
.fig-tool-button:hover{background:color-mix(in srgb,${primary} 6%,transparent)}
.fig-tool-button:focus-visible{outline:2px solid ${primary};outline-offset:2px}
.fig-tool-button[disabled]{cursor:default;color:${secondary};background:none}
.fig-tool-tag{flex:none;padding:0 7px;border:1px solid ${border};border-radius:999px;font-size:11px;line-height:18px;white-space:nowrap}
.fig-tool-tag[data-tone="danger"]{color:var(--dsw-alias-state-error-primary,#d9534f);border-color:currentColor}
.fig-tool-tag[data-tone="warn"]{color:#b7791f;border-color:currentColor}
.fig-tool-link{all:unset;cursor:pointer;color:${primary};text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}
.fig-tool-link:focus-visible{outline:2px solid ${primary};outline-offset:2px}
.fig-tool-list{list-style:none;margin:0 0 8px;padding:0;display:grid;gap:6px}
.fig-tool-list li{display:flex;gap:8px;align-items:baseline;min-width:0}
.fig-tool-shot{all:unset;cursor:pointer;display:grid;gap:3px;font-size:11px;border-radius:6px}
.fig-tool-shot:focus-visible{outline:2px solid ${primary};outline-offset:2px}
.fig-tool-shot img,.fig-tool-shot span.fig-tool-blank{display:block;width:132px;height:84px;object-fit:cover;object-position:top;border:1px solid ${border};border-radius:6px;background:color-mix(in srgb,${primary} 5%,transparent)}
`

/**
 * Puts the stylesheet in the page once, shared by every plugin that draws tool rows (each bundles its own copy of this
 * module, so the count lives on the element); returns this user's release, and the last release removes it.
 */
export function installToolViewStyle(doc = document) {
  let style = doc.getElementById(styleId)
  if (!style) {
    style = doc.createElement('style')
    style.id = styleId
    style.textContent = toolViewCss
    doc.head.append(style)
  }
  style.dataset.figUsers = String(Number(style.dataset.figUsers || 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = Number(style.dataset.figUsers || 1) - 1
    if (left > 0) style.dataset.figUsers = String(left)
    else style.remove()
  }
}

/** The text of a settled call's content blocks, untrimmed: tool output keeps its leading indentation. */
export const resultText = block => joinedText(block?.content)

/** A settled call's `meta` when it is the object this view expects (`kind` names the tool's own shape). */
export function metaOf(props, kind) {
  const meta = props.phase === 'result' ? props.block.meta : undefined
  return meta && typeof meta === 'object' && !Array.isArray(meta) && meta.kind === kind ? meta : undefined
}

/** The call's arguments once they are complete; `{}` while the model is still writing them or when they left the window. */
export function argsOf(props) {
  const raw = props.phase === 'start' ? props.block.argsRaw : props.phase === 'result' ? props.block.call?.argsRaw : undefined
  if (typeof raw !== 'string') return {}
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
}

/** `running` until the result is recorded, then `error` or `done`. */
export const stateOf = props => props.phase !== 'result' ? 'running' : props.block.isError ? 'error' : 'done'

/** A path the tool reported, made absolute against the session's working directory. */
export const absolutePath = (path, cwd) => path.startsWith('/') || !cwd ? path : cwd.replace(/\/$/, '') + '/' + path

/**
 * A preview target for the header: a `file://` address as its path under the working directory (else its file
 * name), anything else unchanged. `/private` is dropped from both sides, since macOS reports temp folders either way.
 */
export function shortTarget(target, cwd) {
  if (!/^file:\/\//i.test(target)) return target
  let path
  try { path = decodeURIComponent(new URL(target).pathname) } catch { return target }
  const plain = value => value.replace(/^\/private(?=\/)/, '')
  const root = cwd ? plain(cwd).replace(/\/$/, '') + '/' : undefined
  return root && plain(path).startsWith(root) ? plain(path).slice(root.length) : path.split('/').pop() || path
}

/** `12s`, `3m 05s`. */
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? seconds + 's' : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** Registers `View` for the wire tool `key`; the registration ends with the plugin. */
export function registerToolView(ctx, key, View) {
  ctx.effect(() => installToolViewStyle())
  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, View)))
}

/** @param {typeof import('react')} react */
export function toolViews(react) {
  const { createElement: h } = react

  /**
   * One tool row. `summary` follows the title on the header line; `aside` sits at its end (a status tag, a button);
   * `strip` always shows under the header; `children` show when the row is open. A row with no children has no chevron.
   * @param {{ owner: any, tool: string, title: any, summary?: any, aside?: any, strip?: any, children?: any }} props
   */
  function Row({ owner, tool, title, summary, aside, strip, children }) {
    const { expanded, toggle } = owner.useDisclosure()
    const state = stateOf(owner), canOpen = Boolean(children)
    const error = state === 'error' ? resultText(owner.block).split('\n')[0] : undefined
    const line = [h('span', { key: 'title', className: 'fig-tool-title' }, title),
      h('span', { key: 'summary', className: 'fig-tool-summary' }, error ?? (state === 'running' ? sharedText('shared.running') : summary))]
    return h('div', { className: 'fig-tool', 'data-fig-tool-view': tool, 'data-state': state, 'data-open': String(canOpen && expanded) },
      h('div', { className: 'fig-tool-head' },
        canOpen
          ? h('button', { type: 'button', className: 'fig-tool-toggle', 'aria-expanded': expanded, onClick: toggle },
            h('svg', { className: 'fig-tool-chevron', viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }, h('path', { d: 'm4.5 2.5 3.5 3.5-3.5 3.5' })),
            line)
          : h('div', { className: 'fig-tool-toggle', style: { cursor: 'default' } }, line),
        aside),
      strip ? h('div', { className: 'fig-tool-strip' }, strip) : null,
      canOpen && expanded ? h('div', { className: 'fig-tool-body' }, children) : null)
  }

  /** The tool's text result, as the model received it. @param {{ children?: any }} props */
  const Text = ({ children }) => h('pre', { className: 'fig-tool-text' }, children)

  return { Row, Text }
}
