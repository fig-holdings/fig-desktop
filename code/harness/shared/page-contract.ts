// The names Fig's main process (app/main/) and its page plugins in the DSH page agree on. Main reaches
// the page only through executeJavaScript and window-open/navigation requests, so each convention is a
// plain string; both sides import it from here. The page globals are typed in dsh-page-globals.d.ts.
// app/main/workbench.css cannot import and repeats the `pageAttributes` it styles by hand; a unit test
// (tests/page-contract.test.ts) checks that every data-fig-* attribute there is listed below.

/** Page global: the absolute path of the changed-file card under (x, y), for the native 复制路径 item. */
export const filePathAtGlobal = 'figFilePathAt'
/** Window event main dispatches for the app menu's Settings…; desktop-skin opens Fig's Runtime section. */
export const openSettingsEvent = 'fig:open-settings'
/** Window CustomEvent main dispatches while a native directory change runs; `detail.busy` is a boolean. */
export const directoryStatusEvent = 'fig:directory-status'
/** Page global: whether the open conversation is visible, and its Session id (attention suppression). */
export const attentionContextGlobal = '__figAttentionContext'
/** Read-only preload function (app/preload/dsh-locale.ts) for the native window's visibility and focus. */
export const windowForegroundGlobal = '__figWorkbenchForeground'
/** Page global: opens the Session a clicked notification names and acknowledges the navigation. */
export const attentionNavigateGlobal = '__figAttentionNavigate'
/** Window-open URL prefix of the fixed, pathless native directory actions (app/main/directory-settings.ts). */
export const directoryActionPrefix = 'fig-settings://directory/'
/** Page global main sets to the one-time nonce a directory action must carry. */
export const directoryNonceGlobal = '__figDirectoryNonce'
/** The window-open URL for a directory action: `<prefix><kind>/<nonce>`. */
export const directoryActionUrl = (kind: string, nonce: string | undefined): string => directoryActionPrefix + kind + '/' + (nonce ?? '')

/**
 * The data-fig-* attributes Fig's page plugins put on the DSH page that main's window chrome (app/main/workbench.css)
 * styles, by who sets them. Renaming one means changing its setter and workbench.css together.
 */
export const pageAttributes = {
  /** Main, on <html> while the window is in full screen (no traffic lights to clear). */
  fullScreen: 'data-fig-fullscreen',
  /** desktop-brand: the product name in the top bar, and the welcome mark (`hero-mark`). */
  productTitle: 'data-fig-product-title',
  brand: 'data-fig-brand',
  /** desktop-brand: the welcome headline's group (variant 0 or 1), the replaced headline and the added subtitle. */
  welcome: 'data-fig-welcome',
  welcomeHeadline: 'data-fig-welcome-headline',
  welcomeSubtitle: 'data-fig-welcome-subtitle',
  /** desktop-skin: back and forward buttons in the top bar. */
  pageNavigation: 'data-fig-page-navigation',
  /** desktop-skin: the collapsed rail's open-sidebar button in the conversation header. */
  railToggle: 'data-fig-rail-toggle',
  /** desktop-skin: team plugins' sections in the settings dialog's list, and the first of them carrying the label. */
  settingsGroup: 'data-fig-settings-group',
  settingsGroupFirst: 'data-fig-settings-group-first',
  /** desktop-skin: the settings gear at the sidebar foot. */
  sidebarSettings: 'data-fig-sidebar-settings',
  /** desktop-skin: the Cowork account button in the team settings launcher. */
  coworkTrigger: 'data-fig-cowork-trigger',
  /** desktop-skin: Fig's sidebar open/close icons inside DSH's buttons. */
  sidebarIcon: 'data-fig-sidebar-icon',
  /** desktop-skin: the signed-out account trigger's label. */
  signIn: 'data-fig-sign-in',
  /** desktop-skin: 在本地打开 in the session's … menu. */
  openLocal: 'data-fig-open-local',
  /** composer: the next-step suggestion in the empty input's placeholder. */
  nextStep: 'data-fig-next-step'
} as const
/** Attribute main sets on <html> while the window is in full screen (no traffic lights to clear). */
export const fullScreenAttribute = pageAttributes.fullScreen
