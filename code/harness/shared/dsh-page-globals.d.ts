export {}

// Globals in the DSH page. The Fig names are declared in harness/shared/page-contract.ts.
declare global {
  /** A notification's Session for the page to open (app/main/attention.ts). */
  interface FigAttentionTarget { sessionId: string; eventIdentity: string; navigationId: string }

  interface Window {
    /** Set by desktop-skin; main reads it for 复制路径 in the native context menu. */
    figFilePathAt?: (x: number, y: number) => string | undefined
    /** Set by shell-bridge; main calls it when a notification is clicked. Input is checked again in the page. */
    __figAttentionNavigate?: (target: FigAttentionTarget) => Promise<{ navigationId?: string; accepted: boolean }>
    /** Set by shell-bridge; whether the open conversation is visible, and its Session id. */
    __figAttentionContext?: () => { visible: boolean; sessionId?: string | null }
    /** Set by the DSH page's preload (app/preload/dsh-locale.ts); task activity asks it before marking anything read. */
    __figWorkbenchForeground?: () => Promise<boolean>
    /** Set by main on each page load and after each use; Fig's settings section sends it with a directory action. */
    __figDirectoryNonce?: string
    __ModuleLoader__: {
      load(definition: { id: string; factory(require: (id: string) => any): object }): void
    }
  }

  interface WindowEventMap {
    /** Main asks the page to open Fig's Runtime settings section (the app menu's Settings…). */
    'fig:open-settings': Event
    /** Main reports a native directory change starting or ending. */
    'fig:directory-status': CustomEvent<{ busy: boolean }>
  }

  // Page clients run as classic scripts, so `globalThis` is the window.
  var figFilePathAt: Window['figFilePathAt']

  const __FIG_BRAND_ICON__: string
  const __FIG_BRAND_ICON_DARK__: string
}
