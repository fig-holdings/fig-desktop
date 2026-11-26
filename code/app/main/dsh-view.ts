import { BrowserWindow, Menu, WebContentsView, clipboard, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import workbenchCss from './workbench.css?raw'
import { DirectoryNonce, directoryAction, type DirectoryKind } from './directory-settings'
import { tr } from './language'
import { bootStateScript, inactiveEntries } from './plugin-failure'
import { WorkbenchRecovery } from './workbench-recovery'
import { directoryNonceGlobal, filePathAtGlobal, fullScreenAttribute, openSettingsEvent } from '../../harness/shared/page-contract'

const workbenchWindowSize = { width: 1160, height: 790, minWidth: 760, minHeight: 540 }
// macOS hides the title bar; workbench.css fits the DSH page around the traffic lights.
export const frameless = process.platform === 'darwin'

interface DshViewHost {
  /** The page's sandboxed locale and native focus bridge (preload/dsh-locale.ts). */
  preload: string;
  window(): BrowserWindow | undefined;
  /** True once the app has begun quitting; a late load or crash is then ignored. */
  quitting(): boolean;
  /** The launch URL still belongs to the ready DSH child. */
  ready(url: string): boolean;
  /** A fixed, pathless directory action the page asked for (directory-dialogs.ts). */
  directoryAction(contents: WebContents, origin: string, kind: DirectoryKind): void;
  /** The page could not be shown; the startup page reports `message`. */
  failed(message: string): void;
  /** The page's visibility or recovery state changed. */
  changed(): void;
  /** DSH's boot card reports failed plugins (its lines after the title); the workbench will not open. */
  pluginFailure(lines: string[], stillCurrent: () => boolean): void;
  /** The workbench opened without these entries (DSH 0.2.2-rc.2 and later warn instead of stopping). */
  pluginsInactive(entries: string[], stillCurrent: () => boolean): void;
}

// Ordinary links and the Browser sidebar's "Open in system browser" may be HTTP(S), including loopback dev
// servers; the deferred sign-in popup stays HTTPS-only. Other schemes never reach an OS handler.
function openExternal(url: string, { allowHttp = true }: { allowHttp?: boolean } = {}): void {
  try {
    const target = new URL(url)
    const scheme = target.protocol === 'https:' || (allowHttp && target.protocol === 'http:')
    if (scheme && !target.username && !target.password) {
      void shell.openExternal(url).catch(() => { /* DSH still offers Copy login link. */ })
    }
  } catch {
    // Unsupported/non-URL links are not handed to an operating-system handler.
  }
}

// Each DSH start signs the page in with its own long-lived dsh-auth-* cookie for 127.0.0.1, and cookies
// ignore the port, so the persistent partition keeps one per launch. About 70 of them outgrow Node's
// 16 KB request-header limit and DSH answers 431, leaving a blank workbench. Only the DSH about to load
// is useful; its cookie is set again from the token URL.
async function clearStaleDshCookies(session: Electron.Session, origin: string, active: () => boolean): Promise<void> {
  try {
    for (const cookie of await session.cookies.get({ domain: '127.0.0.1' })) {
      if (!active()) return
      if (cookie.name.startsWith('dsh-auth-')) await session.cookies.remove(origin + '/', cookie.name)
    }
  } catch { /* A failed cleanup leaves the page to load as before. */ }
}

/** Whether `link` is an http(s) link off the page's own origin. A link that does not parse is not one, so the menu
 * still shows as for a plain right-click. */
function externalLink(link: string, page: string): boolean {
  if (!/^https?:/i.test(link)) return false
  try { return new URL(link).origin !== new URL(page).origin } catch { return false }
}

/** The DSH workbench page inside Fig's window: its view, popups, links, cookies and context menu. */
export class DshView {
  private current?: WebContentsView
  private recovery?: WorkbenchRecovery
  private opened = false
  constructor(private host: DshViewHost) {}

  /** The page's view while one exists, on screen or loading. */
  get view(): WebContentsView | undefined { return this.current }

  /** Whether the page is on screen in the window. */
  get attached(): boolean {
    const window = this.host.window()
    return Boolean(this.current && window?.contentView.children.includes(this.current))
  }

  get recoveryPhase(): 'recovering' | 'rate-limited' | undefined {
    const phase = this.recovery?.phase
    if (phase === 'recovering' || phase === 'rate-limited') return phase
  }

  cancelRecovery(): void {
    this.recovery?.cancel()
    this.recovery = undefined
  }

  remove(): void {
    this.cancelRecovery()
    const previous = this.current
    this.current = undefined
    if (!previous) return
    this.detach(previous)
    if (!previous.webContents.isDestroyed()) previous.webContents.close()
  }

  private detach(view: WebContentsView): void {
    const window = this.host.window()
    if (window && !window.isDestroyed() && window.contentView.children.includes(view)) window.contentView.removeChildView(view)
  }

  syncFullScreen = (): void => {
    const window = this.host.window()
    if (!frameless || !this.current || !window || window.isDestroyed()) return
    const script = window.isFullScreen()
      ? `document.documentElement.setAttribute('${fullScreenAttribute}', '')`
      : `document.documentElement.removeAttribute('${fullScreenAttribute}')`
    void this.current.webContents.executeJavaScript(script).catch(() => { /* The page may be reloading. */ })
  }

  resize(): void {
    const window = this.host.window()
    if (!this.current || !window) return
    const [width, height] = window.getContentSize()
    this.current.setBounds({ x: 0, y: 0, width, height })
  }

  // Settings live in DSH; the desktop-skin page plugin opens them at Fig's Workspace section.
  openSettings(): void {
    if (!this.current || !this.attached) return
    this.current.webContents.focus()
    void this.current.webContents.executeJavaScript(`window.dispatchEvent(new Event('${openSettingsEvent}'))`).catch(() => {})
  }

  async show(url: string): Promise<void> {
    if (this.host.quitting() || !this.host.ready(url)) return
    this.remove()
    const current = new WebContentsView({ webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, partition: 'persist:fig-dsh', preload: this.host.preload
    } })
    this.current = current
    const origin = new URL(url).origin
    // A directory action must carry the nonce main last gave this page; any other link is refused.
    const nonce = new DirectoryNonce()
    const issueNonce = () => {
      void current.webContents.executeJavaScript(`window.${directoryNonceGlobal} = ${JSON.stringify(nonce.issue())}`).catch(() => { /* The page may be reloading. */ })
    }
    current.webContents.on('dom-ready', () => {
      // workbench.css holds the window chrome and Fig's functional page styles. It is injected only on macOS
      // because Fig ships for macOS only.
      if (frameless) void current.webContents.insertCSS(workbenchCss).then(this.syncFullScreen, () => { /* The page may be reloading. */ })
      issueNonce()
      // DSH may reload its own page (after a plugin change, say) while it is on screen; its boot card is followed
      // again. A first load or a crash recovery is followed once the page is attached.
      if (this.current === current && this.attached) watchBoot()
    })
    const requestDirectory = (target: string): boolean => {
      const action = directoryAction(target)
      if (!action) return false
      if (nonce.consume(action.nonce)) {
        issueNonce()
        this.host.directoryAction(current.webContents, origin, action.kind)
      }
      return true
    }
    let pendingPopup: BrowserWindow | undefined
    const closePopup = () => { pendingPopup?.destroy() }
    current.webContents.once('destroyed', closePopup)
    current.webContents.setWindowOpenHandler(({ url: target }) => {
      if (requestDirectory(target)) return {action: 'deny'}
      // DSH preopens an empty tab from the click, then assigns the OAuth URL.
      if (target === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
      openExternal(target)
      return { action: 'deny' }
    })
    current.webContents.on('did-create-window', popup => {
      pendingPopup?.destroy()
      pendingPopup = popup
      popup.once('closed', () => { if (pendingPopup === popup) pendingPopup = undefined })
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      popup.webContents.on('will-frame-navigate', event => {
        event.preventDefault()
        if (!event.isMainFrame || pendingPopup !== popup) return
        pendingPopup = undefined
        openExternal(event.url, { allowHttp: false })
        setImmediate(() => { if (!popup.isDestroyed()) popup.destroy() })
      })
    })
    current.webContents.on('will-navigate', (event, target) => {
      if (requestDirectory(target)) { event.preventDefault(); return }
      try {
        if (new URL(target).origin === origin) return
      } catch { /* Non-URL navigation is rejected below. */ }
      event.preventDefault()
      openExternal(target)
    })
    current.webContents.on('context-menu', (_event, params) => { void this.showContextMenu(current.webContents, params) })
    // DSH's copy buttons write through navigator.clipboard; reading the clipboard stays denied.
    current.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write' && contents === current.webContents)
    })
    const active = (): boolean => this.recovery === recovery && this.current === current && !current.webContents.isDestroyed()
      && !this.host.quitting() && this.host.ready(url)
    current.webContents.on('console-message', ({ level, message }) => {
      if (level !== 'warning' || !active()) return
      const entries = inactiveEntries(message)
      if (entries.length) this.host.pluginsInactive(entries, active)
    })
    let crashes = 0
    // One boot watch at a time, ending with a crash; a load that starts while one runs is followed once it ends.
    let watching = false, again = false
    const watchBoot = (): void => {
      if (watching) { again = true; return }
      watching = true
      again = false
      const count = crashes
      void this.watchBoot(current, () => active() && count === crashes).finally(() => {
        watching = false
        if (again && active()) watchBoot()
      })
    }
    const attach = () => {
      const count = crashes
      this.attach(current, () => active() && count === crashes, watchBoot)
    }
    const recovery = new WorkbenchRecovery({
      active,
      load: () => this.load(current, url, origin, active),
      changed: () => { this.detach(current); this.host.changed() },
      recovered: attach,
      failed: reason => this.host.failed(reason === 'timeout'
        ? tr('工作台自动恢复超时，请重试。', 'Automatic workbench recovery timed out. Try again.')
        : reason === 'limit'
          ? tr('工作台反复崩溃，已停止自动恢复，请重试。', 'The workbench keeps crashing, so automatic recovery stopped. Try again.')
          : tr('工作台自动恢复失败，请重试。', 'The workbench could not recover automatically. Try again.'))
    })
    this.recovery = recovery
    current.webContents.on('render-process-gone', () => {
      if (!active()) return
      crashes++
      closePopup()
      recovery.crashed()
    })

    // A crash during the initial navigation invalidates its eventual completion or rejection.
    const initial = () => active() && crashes === 0
    try {
      await this.load(current, url, origin, initial)
      if (initial()) attach()
    } catch {
      // Do not interpolate the tokenized URL from Electron's load error into diagnostics.
      if (initial()) this.host.failed(tr('DSH 已启动，但页面加载失败。请检查网络或展开诊断后重试。', 'DSH started, but the page did not load. Check the network or open the diagnostics, then retry.'))
    }
  }

  private async load(view: WebContentsView, url: string, origin: string, active: () => boolean): Promise<void> {
    const contents = view.webContents
    await clearStaleDshCookies(contents.session, origin, active)
    if (!active()) return
    let responseCode = 0
    const captureStatus = (_event: Electron.Event, _url: string, code: number) => { responseCode = code }
    contents.on('did-navigate', captureStatus)
    try {
      await contents.loadURL(url)
      if (responseCode >= 400) throw new Error('Workbench HTTP failure')
    } finally {
      contents.off('did-navigate', captureStatus)
    }
  }

  private attach(view: WebContentsView, active: () => boolean, watchBoot: () => void): void {
    const window = this.host.window()
    if (!active() || !window || window.isDestroyed()) return
    window.contentView.addChildView(view)
    if (!this.opened) {
      this.opened = true
      window.setMinimumSize(workbenchWindowSize.minWidth, workbenchWindowSize.minHeight)
      if (!window.isFullScreen() && !window.isMaximized()) {
        window.setSize(workbenchWindowSize.width, workbenchWindowSize.height)
        window.center()
      }
    }
    this.resize()
    this.syncFullScreen()
    if (window.isFocused()) view.webContents.focus()
    this.host.changed()
    watchBoot()
  }

  /** Follows DSH's boot card until the workbench mounts; a failed plugin there is reported once. */
  private async watchBoot(current: WebContentsView, active: () => boolean): Promise<void> {
    for (const end = Date.now() + 180_000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 500))) {
      if (!active()) return
      const boot: { state?: string, lines?: unknown } | undefined = await current.webContents.executeJavaScript(bootStateScript).catch(() => undefined)
      if (!active()) return
      if (boot?.state === 'gone') return
      if (boot?.state === 'failed' && Array.isArray(boot.lines)) {
        this.host.pluginFailure(boot.lines.filter((line): line is string => typeof line === 'string'), active)
        return
      }
    }
  }

  // Electron shows no context menu of its own. Changed-file cards add 复制路径; the desktop-skin page
  // plugin resolves the file under the pointer. File mentions and delivered cards use DSH's own menu.
  private async showContextMenu(contents: WebContents, params: ContextMenuParams): Promise<void> {
    const path: unknown = await contents.executeJavaScript(`globalThis.${filePathAtGlobal}?.(${params.x}, ${params.y})`).catch(() => undefined)
    const items: MenuItemConstructorOptions[] = []
    if (typeof path === 'string' && path) items.push({ label: tr('复制路径', 'Copy Path'), click: () => clipboard.writeText(path) })
    if (params.isEditable) {
      if (items.length) items.push({ type: 'separator' })
      items.push({ role: 'cut', label: tr('剪切', 'Cut'), enabled: params.editFlags.canCut }, { role: 'copy', label: tr('拷贝', 'Copy'), enabled: params.editFlags.canCopy },
        { role: 'paste', label: tr('粘贴', 'Paste'), enabled: params.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll', label: tr('全选', 'Select All') })
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy', label: tr('拷贝', 'Copy') })
    }
    if (externalLink(params.linkURL, contents.getURL())) {
      items.push({ label: tr('拷贝链接', 'Copy Link'), click: () => clipboard.writeText(params.linkURL) })
    }
    const window = this.host.window()
    if (items.length && window && !window.isDestroyed()) Menu.buildFromTemplate(items).popup({ window })
  }
}
