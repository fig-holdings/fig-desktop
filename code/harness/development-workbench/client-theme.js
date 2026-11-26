// The 研发工作台's look, shared by the card, its dialogs and the right-sidebar tabs: DSH's own tokens with fallbacks,
// the page style sheet, and the style objects several components repeat.

export const CARD_WIDTH = 320
export const GAP = 12
/** Marks the conversation body a card is docked in; the style sheet makes room for the card. */
export const dockedAttribute = 'data-fig-workbench-docked'

/** Code and paths. */
export const mono = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** `added`, `deleted`, `merged`: the dark-mode variables the style sheet sets, with the light colors as fallbacks. */
export const colors = {
  primary: 'var(--dsw-alias-label-primary)', secondary: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.25))', card: 'var(--dsw-alias-bg-layer-1, #fff)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1))', layer: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
  added: 'var(--fig-wb-added, #1a7f37)', deleted: 'var(--fig-wb-deleted, #cf222e)', merged: 'var(--fig-wb-merged, #8250df)',
  addedBg: 'var(--fig-wb-added-bg, rgba(46,160,67,.13))', deletedBg: 'var(--fig-wb-deleted-bg, rgba(248,81,73,.13))',
  selected: 'var(--fig-wb-selected, rgba(84,174,255,.22))', accent: 'var(--dsw-alias-brand-primary, #e8743b)'
}

const css = `
[data-fig-workbench-tasks] [data-testid="todo-panel"] { width: 100%; max-width: 100%; }
@keyframes fig-ci-spin { to { transform: rotate(360deg); } }
.fig-ci-spinning { animation: fig-ci-spin 1.2s linear infinite; }
@media (prefers-reduced-motion: reduce) { .fig-ci-spinning { animation: none; } }

[${dockedAttribute}] { position: relative; box-sizing: border-box; padding-right: ${CARD_WIDTH + GAP * 2}px; }
[data-fig-workbench-button] { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: ${colors.secondary}; cursor: pointer; }
[data-fig-workbench-button]:hover, [data-fig-workbench-button][aria-pressed="true"] { background: ${colors.hover}; color: ${colors.primary}; }
:is([data-fig-workbench], [data-fig-pull-detail]) button.fig-wb-link { border: 0; background: transparent; color: ${colors.secondary}; font: inherit; font-size: 12px;
  padding: 2px 6px; border-radius: 6px; cursor: pointer; }
:is([data-fig-workbench], [data-fig-pull-detail]) button.fig-wb-link:hover { background: ${colors.hover}; color: ${colors.primary}; }
:is([data-fig-workbench], [data-fig-pull-detail]) button.fig-wb-link:disabled { opacity: .5; cursor: default; }
:is([data-fig-workbench], [data-fig-pull-detail]) .fig-wb-row { display: flex; align-items: center; gap: 8px; width: calc(100% + 12px); margin: 0 -6px; padding: 2px 6px;
  min-height: 22px; border: 0; border-radius: 6px; background: transparent; color: ${colors.primary}; font: inherit; font-size: 13px;
  text-align: left; text-decoration: none; cursor: pointer; box-sizing: border-box; }
:is([data-fig-workbench], [data-fig-pull-detail]) .fig-wb-row:hover { background: ${colors.hover}; }
/* light-dark() follows the color-scheme DSH sets for its chosen theme; prefers-color-scheme follows the OS instead. */
:is([data-fig-workbench], [data-fig-development-diff], [data-fig-pull-detail]) { --fig-wb-added: light-dark(#1a7f37, #3fb950);
  --fig-wb-deleted: light-dark(#cf222e, #f85149); --fig-wb-merged: light-dark(#8250df, #a371f7);
  --fig-wb-added-bg: light-dark(rgba(46,160,67,.13), rgba(46,160,67,.2)); --fig-wb-deleted-bg: light-dark(rgba(248,81,73,.13), rgba(248,81,73,.18)); }
`
const styleId = 'fig-development-workbench-style'
let styleUsers = 0
/** @type {HTMLStyleElement | undefined} */
let styleElement

/**
 * Puts the style sheet in the page while anything holds it; the returned release removes it after the last holder.
 * The sheet is this instance's own element, never one found by id: after the plugin is updated, the new sheet goes in
 * (after any an older instance left) and the old instance's release takes only its own.
 */
export function retainStyle() {
  if (styleUsers++ === 0) {
    styleElement = document.createElement('style')
    styleElement.id = styleId
    styleElement.textContent = css
    document.head.append(styleElement)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--styleUsers === 0) { styleElement?.remove(); styleElement = undefined }
  }
}

export const section = { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }
export const heading = { fontSize: 12, color: colors.secondary, display: 'flex', justifyContent: 'space-between' }
export const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: colors.primary, minHeight: 22 }
export const muted = { color: colors.secondary, fontSize: 12 }
export const divider = { height: 0, borderTop: '.5px solid ' + colors.border, margin: '0 14px' }
export const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
/** A dialog's button. */
export const dialogButton = { border: '.5px solid ' + colors.border, background: 'transparent', color: colors.primary, font: 'inherit', fontSize: 13,
  padding: '6px 14px', borderRadius: 8, cursor: 'pointer' }
/** A labelled control in a dialog. */
export const field = { ...rowStyle, gap: 8 }
/** A one-line text input in a dialog (a branch name). */
export const textInput = { flex: 1, font: 'inherit', fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '.5px solid ' + colors.border,
  background: 'transparent', color: colors.primary, fontFamily: mono }
/** A notice in a dialog: an error or a refusal. */
export const alertText = { fontSize: 12.5, color: colors.deleted }

/** A menu under its trigger; each menu adds its own placement, size and shadow. */
export const menuPanel = { position: 'absolute', top: 26, padding: 4, background: colors.card, border: '.5px solid ' + colors.border, display: 'flex', flexDirection: 'column' }
/** The floating row menus (path row, pull request ⋯). */
export const floatingMenu = { ...menuPanel, zIndex: 4, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.16)', gap: 1 }
/** A dialog's dimmed backdrop and its panel. */
export const dialogShell = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.28)' },
  panel: { display: 'flex', flexDirection: 'column', gap: 10, padding: 18, borderRadius: 14, boxSizing: 'border-box', background: colors.card, color: colors.primary,
    boxShadow: '0 12px 40px rgba(0,0,0,.25)' }
}
