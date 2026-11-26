import { app, dialog, Notification, BrowserWindow, ipcMain, Menu, net, nativeTheme, powerSaveBlocker, safeStorage, shell, type IpcMainInvokeEvent, type MessageBoxOptions, type WebContents } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { DesktopAttention, readAttention, readIdle } from './attention'
import { NotificationPool } from './notification-pool'
import { DirectorySettings, existingDirectory } from './directory-settings'
import { directoryErrorText } from './directory-dialogs'
import { directoryChanger } from './directory-change'
import { planStartup } from './startup-directory'
import { DshView, frameless } from './dsh-view'
import { setApplicationMenu } from './app-menu'
import { bundlesFor, describeFailure, failedPlugins as failedPluginNames } from './plugin-failure'
import { deselectBundles } from './web-profile'
import { loadProfile } from './profile'
import { suspendRequired } from './external-plugins'
import { localeBootstrap, onUiLanguageChange, setUiLanguage, tr, uiLanguage, uiLanguageOf } from './language'
import { DshService } from './service'
import { replacedVersion } from './bundle-replacement'
import { showAbout } from './about'
import { defaultDshHome, defaultStartup, developmentRendererUrl, dshRelease, dshRuntimeLock, firstRunHome, fixtureCommand, isolatedDataDirectory,
  profileOverrides, sidebarBrandDisabled, verificationEnvironment } from './dev-overrides'
import { launchDsh } from '../../harness/dsh-versions'
import { bundlePlugins, figPlugins } from '../../harness/plugins'
import pluginUpdateKeys from '../../harness/plugin-update-keys.json'
import { markUpdatesFailed } from './plugin-updates'
import { dshReleasePattern } from '../../harness/shared/dsh-range'
import { errorText } from '../../harness/shared/log'
import { defaultWorkspacePath } from '../../harness/shared/workspace-registry'
import appIcon from '../../../assets/brand/app-icon.png?asset'
import { IPC, appearancePreference, type ServiceState } from '../shared/protocol'
import { captureFlag, runCapture } from './capture'
import { coworkConnection, type CoworkConnection } from './cowork-login'
import { CoworkSession, coworkVault } from './cowork-session'
import { EditionController } from './edition-controller'
import { readJsonFile } from '../../harness/shared/atomic-json.ts'

const directory = fileURLToPath(new URL('.', import.meta.url))
app.setName('Fig Desktop')
if (isolatedDataDirectory) app.setPath('userData', isolatedDataDirectory)
// Persisted native choices override these defaults (dev-overrides.ts); resolveFolders applies them.
let startupDirectory = defaultStartup
let dshHome = defaultDshHome
let personalDshHome = defaultDshHome
// Replaced at startup once the Cowork connection is read; until then personal, with no Cowork.
let edition: EditionController
// The startup folder suggested on first launch while Fig waits for the user's choice; DSH starts afterwards.
let startupChoice: string | undefined
let startupChosen: ((path: string) => void) | undefined
const directorySettings = new DirectorySettings(app.getPath('userData'))
let latestDshNote: Promise<void> | undefined
const startupWindowSize = { width: 440, height: 340, minWidth: 390, minHeight: 320 }

let window: BrowserWindow | undefined
let service: DshService | undefined
let attention: DesktopAttention | undefined
let sleepBlocker: number | undefined
let dockStatus = 'syncing'

/** The main window while it exists. */
function liveWindow(): BrowserWindow | undefined {
  return window && !window.isDestroyed() ? window : undefined
}

/** The Dock menu's task-reminder status line and Open item; built again on a status or language change. */
function setDockMenu(): void {
  app.dock?.setMenu(Menu.buildFromTemplate([
    {label: dockStatus === 'ready' ? tr('任务提醒已同步', 'Task reminders synced') : dockStatus === 'stopped' ? tr('任务服务已停止', 'Task service stopped') : tr('任务提醒待同步', 'Task reminders not synced'), enabled: false},
    {label: tr('打开 Fig Desktop', 'Open Fig Desktop'), click: showWindow}
  ]))
}

/** The application menu; built again on a language change. */
function rebuildMenus(): void {
  setApplicationMenu({ showAbout: () => void showAbout({ parent: liveWindow(), dshRelease }), showSettings, showWindow })
}

const notifications = new NotificationPool()
let readyToQuit = false
let quitPending = false
let retryPending = false
let pageError: ServiceState | undefined
// Shown while DSH is stopped for a directory change; not a page error.
let directoryNotice: ServiceState | undefined
let appearance = appearancePreference()

function startupBackground(): string {
  const dark = appearance === 'system' ? nativeTheme.shouldUseDarkColors : appearance === 'dark'
  // DSH's built-in application background (--dsw-alias-bg-base).
  return dark ? '#151517' : '#ffffff'
}

function readDshConfig(home: string, ...path: string[]) {
  try {
    return parse(readFileSync(join(home, ...path), 'utf8'), { logLevel: 'silent' })
  } catch {
    return undefined
  }
}

function preferenceInPatch(patch: unknown, id: string): unknown {
  return Array.isArray(patch) ? patch.findLast(entry => entry?.id === id)?.config?.preference : undefined
}

/** A preference DSH stored for entry `id`: it writes them to the active Web profile patch, then applies the home patch over it. */
function storedPreference(home: string, id: string): unknown {
  return preferenceInPatch(readDshConfig(home, 'cordis.patch.yml'), id) ?? preferenceInPatch(readDshConfig(home, 'profiles', 'web', 'cordis.patch.yml'), id)
}

/** The interface language DSH stored, read like the theme. */
function storedLocale(): string | undefined {
  const value = storedPreference(dshHome, 'locale')
  return typeof value === 'string' ? value : undefined
}

/** Fig's own text follows DSH's stored language, or the system language before DSH has stored one. */
function syncLanguage(): void {
  setUiLanguage(uiLanguageOf(storedLocale()) ?? uiLanguageOf(app.getLocale()) ?? 'en')
}

function refreshStartupAppearance(): void {
  appearance = appearancePreference(storedPreference(dshHome, 'ui-theme'))
  liveWindow()?.setBackgroundColor(startupBackground())
}

function uiState(): ServiceState {
  const recovery = dshView.recoveryPhase
  return {
    ...(pageError ?? directoryNotice ?? (startupChoice ? {phase: 'idle', message: tr('选择启动目录', 'Choose a startup folder'), logs: [], startupChoice: {suggested: startupChoice}} : service!.state)),
    appearance,
    appVersion: app.getVersion(),
    language: uiLanguage(),
    cowork: edition.state(),
    workbenchAvailable: dshView.attached,
    workbenchRecovery: recovery
  }
}

function sendState(): void {
  liveWindow()?.webContents.send(IPC.state, uiState())
}

function showWindow(): void {
  const shown = liveWindow()
  if (!shown) return
  if (shown.isMinimized()) shown.restore()
  shown.show()
  shown.focus()
}

function workbenchWindowForeground(): boolean {
  const shown = liveWindow()
  return Boolean(shown && shown.isVisible() && shown.isFocused() && !shown.isMinimized())
}

/** Replaces the workbench with the startup page reporting `failure`. */
function showPageError(failure: Partial<ServiceState>): void {
  pageError = { ...service!.state, phase: 'failed', ...failure }
  refreshStartupAppearance()
  dshView.remove()
  sendState()
}

/**
 * A plugin update that fails to load is not used again: it is recorded and DSH restarts, linking the built-in copy
 * (plugin-updates.ts). Whether any of `plugins` (DSH entry names) was such an update and the restart began.
 */
async function updatesFailed(plugins: string[], stillCurrent: () => boolean): Promise<boolean> {
  const updated = bundlesFor(plugins, Object.keys(service?.updates ?? {}))
  if (!updated.length || !stillCurrent()) return false
  const recorded = await markUpdatesFailed(dshHome, updated, tr('工作台启动时加载失败，已改用内置版', 'Failed to load when the workbench started; the built-in copy is used'))
  if (!recorded.length) return false
  console.warn('Plugin updates failed to load, restarting with the built-in copies: ' + recorded.join(', '))
  await retry()
  return true
}

/** DSH's page could not load a plugin, so the workbench will not open: the startup page shows which and offers to turn the user's off. */
async function pluginsFailed(lines: string[], stillCurrent: () => boolean): Promise<void> {
  if (await updatesFailed(failedPluginNames(lines), stillCurrent)) return
  const required = new Set(service?.profile?.plugins.filter(plugin => plugin.required && plugin.name).map(plugin => plugin.name!) ?? [])
  const failure = await describeFailure(dshHome, lines, required)
  if (!stillCurrent()) return
  showPageError({ message: tr('插件启动失败，工作台没有打开', 'A plugin failed to start, so the workbench did not open'), error: lines.join('\n'), pluginFailure: failure })
}

function pageFailed(message: string): void {
  showPageError({ message: tr('工作台未能打开', 'The workbench did not open'), error: message })
}

// Fig starts a verified DSH release (harness/dsh-versions.json). The npm latest is noted for the
// Runtime settings section, which says whether Fig has verified it yet. Electron's net follows the
// system proxy; a failed check leaves the previous note.
async function noteLatestDsh(): Promise<void> {
  try {
    const response = await net.fetch('https://registry.npmjs.org/@deepseek-ai%2fdsh/latest', { signal: AbortSignal.timeout(10_000) })
    const latest: unknown = response.ok ? (await response.json())?.version : undefined
    if (typeof latest !== 'string' || !dshReleasePattern.test(latest)) return
    await mkdir(join(dshHome, 'fig'), { recursive: true })
    await writeFile(join(dshHome, 'fig/dsh-latest.json'), JSON.stringify({ latest, checkedAt: new Date().toISOString() }))
  } catch { /* Offline: the Runtime section shows the last note, if any. */ }
}

/** Whether `event` came from the main frame of `contents`. */
function fromMainFrame(event: Electron.IpcMainEvent | IpcMainInvokeEvent, contents: WebContents | undefined): boolean {
  return Boolean(contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame)
}

/** Fig's own IPC is answered only for the startup page in Fig's window. */
function trusted(event: IpcMainInvokeEvent): void {
  if (!fromMainFrame(event, liveWindow()?.webContents)) {
    throw new Error(tr('此操作仅在 Fig 窗口中可用。', 'This action is available only in the Fig window.'))
  }
}

async function loadFigPage(surface: BrowserWindow): Promise<void> {
  const developmentUrl = developmentRendererUrl()
  if (developmentUrl) {
    developmentUrl.searchParams.set('appearance', appearance)
    await surface.loadURL(developmentUrl.href)
  } else {
    await surface.loadFile(join(directory, '../renderer/index.html'), { query: { appearance } })
  }
}

const changeDirectory = directoryChanger({
  settings: directorySettings, release: dshRelease,
  window: () => window, page: () => dshView.view?.webContents,
  quitting: () => quitPending, ready: () => !edition.busy && !edition.selected && service?.profile?.edition !== 'team' && service?.state.phase === 'ready',
  current: () => ({startup: startupDirectory, dshHome}),
  idle: () => readIdle(service?.attentionConnection),
  defaultWorkspace: () => defaultWorkspacePath(dshHome, dshRelease),
  stop: async kind => {
    await service!.stop(); notifications.dispose(); dshView.remove()
    directoryNotice = {phase: 'starting', message: kind === 'dshHome' ? tr('正在复制并校验DSH数据，请勿退出应用', 'Copying and checking DSH data. Do not quit the app.') : tr('正在保存目录设置', 'Saving folder settings'), logs: [], directoryChange: true}
    sendState()
  },
  settle: async () => { await attention?.settle(); await latestDshNote },
  resume: async () => { directoryNotice = undefined; await service!.start() },
  restart: () => { app.relaunch(); app.quit() }
})

const dshView = new DshView({
  preload: join(directory, '../preload/dsh-locale.cjs'),
  window: () => window,
  quitting: () => quitPending,
  ready: url => service?.launchUrl === url,
  directoryAction: (contents, origin, kind) => { void changeDirectory(contents, origin, kind) },
  failed: pageFailed,
  changed: sendState,
  pluginFailure: (lines, stillCurrent) => { void pluginsFailed(lines, stillCurrent) },
  // The workbench opened without them: DSH shows its own state for other plugins; a Fig plugin update falls back.
  pluginsInactive: (entries, stillCurrent) => { void updatesFailed(entries, stillCurrent) }
})

function showSettings(): void {
  showWindow()
  dshView.openSettings()
}

/** Asks with a native dialog over the window; the index of the chosen button. */
async function ask(options: MessageBoxOptions): Promise<number> {
  const parent = liveWindow()
  return (await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))).response
}

async function confirmEditionChange(): Promise<boolean> {
  if (service?.state.phase !== 'ready') return true
  const link = service.attentionConnection
  if (await readIdle(link).catch(() => false)) return true
  const snapshot = link && await readAttention(link).catch(() => undefined)
  const count = snapshot?.rows.filter(row => row.running).length ?? 0
  const message = count
    ? tr(`有 ${count} 个会话在运行，切换会停止它们。`, `${count} sessions are running. Switching will stop them.`)
    : tr('仍可能有会话或后台任务在运行，切换会停止它们。', 'Switching stops any running sessions and background jobs.')
  return await ask({ type: 'warning', message, buttons: [tr('取消', 'Cancel'), tr('切换', 'Switch')], defaultId: 0, cancelId: 0 }) === 1
}

async function stopForEditionChange() {
  dshView.cancelRecovery()
  await service?.stop()
  await attention?.settle()
  attention?.stop()
  notifications.dispose()
  dshView.remove()
}

async function launchEdition(home: string) {
  if (quitPending) return
  dshHome = home
  pageError = undefined
  refreshStartupAppearance()
  syncLanguage()
  service = await createService()
  attention = createAttention()
  await attention.start()
  sendState()
  await service.start()
}

function createEdition(session?: CoworkSession, config?: CoworkConnection): EditionController {
  return new EditionController({
    userData: app.getPath('userData'),
    personalHome: () => personalDshHome,
    profileEdition: () => service?.profile?.edition,
    quitting: () => quitPending,
    blocked: () => retryPending || Boolean(startupChoice),
    attached: () => dshView.attached,
    confirmChange: confirmEditionChange,
    ask,
    errorBox: (title, text) => dialog.showErrorBox(title, text),
    openExternal: url => shell.openExternal(url),
    trash: path => shell.trashItem(path),
    stop: stopForEditionChange,
    launch: launchEdition,
    changed: sendState,
    pageChanged: () => {
      const page = dshView.view?.webContents
      if (page && !page.isDestroyed()) page.send(IPC.editionChanged, edition.state())
    }
  }, session, config)
}
edition = createEdition()

const runningVersion = app.getVersion()
/** The version packaged into this app's path since it started, when packaging replaced it (bundle-replacement.ts). */
const newerBundle = () => app.isPackaged ? replacedVersion(app.getAppPath(), runningVersion) : Promise.resolve(undefined)

async function retry(): Promise<void> {
  if (quitPending || retryPending || edition.busy || edition.screen || !service || ['checking', 'starting', 'stopping'].includes(service.state.phase)) return
  retryPending = true
  dshView.cancelRecovery()
  try {
    // DSH cannot start again from a replaced bundle; Retry opens the new version instead.
    const replacement = await newerBundle()
    if (quitPending) return
    if (replacement) { app.relaunch(); app.quit(); return }
    refreshStartupAppearance()
    pageError = undefined
    dshView.remove()
    await service.retry()
  } finally {
    retryPending = false
  }
}

/** Reads the folder settings and applies them to `startupDirectory` and `dshHome`, asking the user when one is unusable. */
async function resolveFolders(): Promise<void> {
  let preferences
  try { preferences = await directorySettings.read() } catch (error) {
    const choice = await dialog.showMessageBox({type: 'error', title: tr('无法读取目录设置', 'Could not read folder settings'), message: directoryErrorText(error),
      detail: tr('可以重置目录设置，以默认启动目录和默认数据目录继续。原设置文件会改名保留在原位置，不会删除。', 'You can reset folder settings and continue with the default startup and data folders. The old settings file is renamed and kept where it is; nothing is deleted.'),
      buttons: [tr('重置目录设置', 'Reset Folder Settings'), tr('退出', 'Quit')], defaultId: 1, cancelId: 1})
    if (choice.response !== 0) throw error
    await directorySettings.reset().catch(reason => { dialog.showErrorBox(tr('无法重置目录设置', 'Could not reset folder settings'), tr('原设置文件无法改名保留，请检查目录权限后重新打开Fig。', 'The old settings file could not be renamed and kept. Check folder permissions, then open Fig again.')); throw reason })
    preferences = await directorySettings.read()
  }
  if (firstRunHome) {
    const plan = await planStartup(directorySettings, {home: firstRunHome})
    if (plan.kind === 'choose') startupChoice = plan.suggested
  }
  let unavailableStartup: string | undefined
  try {
    const configured = await directorySettings.load({startup: startupDirectory, dshHome})
    startupDirectory = configured.startup; dshHome = configured.dshHome; unavailableStartup = configured.unavailableStartup
  } catch (error) {
    const previous = preferences.previousDshHome && await existingDirectory(preferences.previousDshHome).catch(() => undefined)
    const missingHome = preferences.dshHome && !await existingDirectory(preferences.dshHome).catch(() => undefined)
    if (previous && missingHome && (await dialog.showMessageBox({type: 'warning', title: tr('数据目录不可用', 'Data folder unavailable'), message: tr('当前数据目录不可用，是否恢复保留的旧目录？', 'The current data folder is unavailable. Restore the old folder that was kept?'), detail: tr('旧目录保留的是迁移时的数据。当前目录不会被删除。', 'The old folder holds the data as it was at migration. The current folder is not deleted.'), buttons: [tr('恢复旧目录', 'Restore Old Folder'), tr('退出', 'Quit')], defaultId: 1, cancelId: 1})).response === 0) {
      await directorySettings.commit('restoreDshHome', previous, {startup: startupDirectory, dshHome: preferences.dshHome!}, launchDsh)
      const configured = await directorySettings.load({startup: startupDirectory, dshHome})
      startupDirectory = configured.startup; dshHome = configured.dshHome; unavailableStartup = configured.unavailableStartup
    } else { dialog.showErrorBox(tr('目录不可用', 'Folder unavailable'), tr('请恢复磁盘连接或目录访问权限后重新打开Fig。现有数据不会被覆盖。', 'Reconnect the disk or restore access to the folder, then open Fig again. Existing data is not overwritten.')); throw error }
  }
  if (unavailableStartup) await dialog.showMessageBox({type: 'warning', title: tr('启动目录不可用', 'Startup folder unavailable'), message: tr('设置的启动目录当前不可用，本次从默认启动目录运行。', 'The startup folder you set is unavailable. Fig runs from the default startup folder this time.'),
    detail: tr(`设置的目录：${unavailableStartup}\n本次使用：${startupDirectory}\n\n设置保持不变。恢复磁盘连接或目录访问权限后重新打开Fig即可。`, `Folder you set: ${unavailableStartup}\nUsed this time: ${startupDirectory}\n\nThe setting is unchanged. Reconnect the disk or restore access, then open Fig again.`), buttons: [tr('好', 'OK')]})
  // The default folder (a fallback for an unavailable saved one, or an isolated instance's) may not exist yet.
  if (!startupChoice) await mkdir(startupDirectory, {recursive: true})
  if (await directorySettings.recoverNotice()) await dialog.showMessageBox({type: 'warning', title: tr('上次迁移未完成', 'Last migration did not finish'), message: tr('上次目录迁移未完成，继续使用原数据目录。', 'The last folder migration did not finish. Fig keeps using the original data folder.'), detail: tr('原数据和迁移记录均已保留。新目录可能包含未完成的副本；重试时请选择空目录。', 'The original data and the migration record are kept. The new folder may hold an incomplete copy; choose an empty folder when you retry.'), buttons: [tr('好', 'OK')]})
}

/** The DSH service for the resolved folders, with its state wired to the window. */
async function createService(): Promise<DshService> {
  const created = new DshService({
    homeDirectory: dshHome,
    previousDshHome: edition.selected ? undefined : (await directorySettings.read()).previousDshHome,
    environment: verificationEnvironment(),
    attentionBootstrap: join(directory, 'shell-bridge/bootstrap.js'),
    modelCatalogBootstrap: join(directory, 'shell-bridge/openai-catalog-bootstrap.js'),
    authorizeTeamRequest: edition.selected ? (profile, request) => edition.authorizeTeamRequest(profile, request) : undefined,
    // How the DSH `preview` tool starts this app in capture mode. A development host is Electron started
    // with the app path (process.defaultApp); its renamed runtime reports isPackaged, so that cannot tell.
    previewCommand: { executable: process.execPath, args: process.defaultApp ? [app.getAppPath()] : [] },
    // Read at each launch: the first-run step may set it after the service is created.
    get workingDirectory() { return startupDirectory },
    skillDirectory: await directorySettings.readSkillDirectory().then(path => path && existingDirectory(path)).catch(() => undefined),
    dshVersion: dshRelease,
    dshRuntime: dshRuntimeLock,
    ensureCurrent: async () => {
      const version = await newerBundle()
      if (version) throw new Error(tr(`已安装 Fig ${version}。点「重试」重启 Fig，改用新版本。`, `Fig ${version} is installed. Choose Retry to restart Fig with it.`))
    },
    // Fig itself (shell channel, skin, brand) is patched in; its feature packages are Web profile bundles (bundles.ts).
    webPatches: figPlugins
      .filter(plugin => !plugin.bundle && (plugin.name !== 'desktop-brand' || !sidebarBrandDisabled))
      .map(plugin => join(directory, plugin.name, 'cordis.patch.yml')),
    bundles: { built: directory, packages: bundlePlugins.map(plugin => ({ folder: plugin.name, id: plugin.id })),
      updates: { appVersion: app.getVersion(), keys: pluginUpdateKeys.keys } },
    // Read at each start, after a directory change too: the descriptor lives with the DSH data.
    profile: () => loadProfile(dshHome, edition.selected ? undefined : profileOverrides),
    resolveCommand: fixtureCommand
  })
  created.on('process-exit', () => dshView.cancelRecovery())
  created.on('confirmed-exit', () => attention?.stop())
  created.on('state', (state: ServiceState) => {
    if (state.phase !== 'ready') {
      pageError = undefined
      directoryNotice = undefined
      dshView.remove()
    }
    if (state.phase === 'failed') refreshStartupAppearance()
    sendState()
  })
  created.on('ready', (url: string) => { if (attention?.status === 'stopped') void attention.start(); pageError = undefined; void dshView.show(url) })
  return created
}

/** Task activity outside the page: notifications, the Dock badge and menu, and keeping the Mac awake while a Session runs. */
function createAttention(): DesktopAttention {
  return new DesktopAttention(dshHome, {
    connection: () => service?.attentionConnection,
    foreground: workbenchWindowForeground,
    execute: async (script, origin) => {
      const contents = dshView.view?.webContents
      if (!contents || contents.isDestroyed() || new URL(contents.getURL()).origin !== origin || service?.attentionConnection?.origin !== origin) throw new Error('Workbench unavailable')
      return contents.executeJavaScript(script)
    },
    badge: text => app.dock?.setBadge(text),
    // While a Session runs the Mac may dim its display but does not go to sleep (Codex: "Prevent sleep while running").
    keepAwake: running => {
      if (running && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension')
      else if (!running && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined }
    },
    syncStatus: status => { dockStatus = status; setDockMenu() },
    activate: showWindow,
    show: (event, click) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title: 'Fig Desktop', body: event.kind === 'result' ? tr('Fig任务有新结果', 'A Fig task has new results') : tr('Fig任务需要处理', 'A Fig task needs you'), silent: true })
      notifications.show(notification, click)
    }
  })
}

/** The window holding the startup page, and later the workbench over it. Hidden, not closed, until the app quits. */
function createMainWindow(): BrowserWindow {
  const created = new BrowserWindow({
    ...startupWindowSize,
    title: 'Fig Desktop', show: false, icon: appIcon,
    ...(frameless
      // The sidebar's 30px top padding in workbench.css clears lights placed here.
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 18, y: 16 } } : {}),
    backgroundColor: startupBackground(),
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  nativeTheme.on('updated', () => liveWindow()?.setBackgroundColor(startupBackground()))
  created.on('close', event => {
    if (!readyToQuit) { event.preventDefault(); window?.hide() }
  })
  // Full screen hides the traffic lights, so the sidebar returns to its own top padding.
  created.on('enter-full-screen', dshView.syncFullScreen)
  created.on('leave-full-screen', dshView.syncFullScreen)
  created.on('resize', () => dshView.resize())
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', event => event.preventDefault())
  return created
}

/** The startup page's actions and the DSH preload's locale and focus reads. */
function registerIpc(): void {
  ipcMain.handle(IPC.getState, event => { trusted(event); return uiState() })
  ipcMain.handle(IPC.retry, event => { trusted(event); return retry() })
  ipcMain.handle(IPC.disablePlugins, async event => {
    trusted(event)
    const bundles = pageError?.pluginFailure?.disablable ?? []
    const required = pageError?.pluginFailure?.required ?? []
    if (!bundles.length && !required.length) return
    // The page offers 本次暂停 whenever a required plugin failed; then nothing is switched off for good. An optional
    // plugin that fails again is offered for turning off on the next start.
    if (bundles.length && !required.length) await deselectBundles(dshHome, bundles)
    // A required plugin is only paused: external-plugins.ts deselects it for the next launch and shows why.
    if (required.length) await suspendRequired(dshHome, Object.fromEntries(required.map(name =>
      [name, tr('工作台启动时加载失败，本次启动已暂停', 'Failed to load when the workbench started; paused for this launch')])))
    // DSH reads the profile when it starts; the restart composes without the deselected bundles.
    await retry()
  })
  ipcMain.handle(IPC.quit, event => { trusted(event); app.quit() })
  ipcMain.handle(IPC.chooseStartup, async (event, how: unknown) => {
    trusted(event)
    const suggested = startupChoice
    if (!suggested || !startupChosen || (how !== 'suggested' && how !== 'browse')) return
    let path = suggested
    if (how === 'browse') {
      const result = await dialog.showOpenDialog(window!, {title: tr('选择启动目录', 'Choose a Startup Folder'), defaultPath: firstRunHome,
        properties: ['openDirectory', 'createDirectory'], buttonLabel: tr('选择目录', 'Choose Folder')})
      if (result.canceled || result.filePaths.length !== 1 || startupChoice !== suggested) return
      path = result.filePaths[0]
    } else await mkdir(path, {recursive: true})
    const target = await existingDirectory(path)
    await directorySettings.saveStartup(target)
    startupDirectory = target
    startupChoice = undefined
    startupChosen(target)
  })
  // The DSH preload's reads apply only to the current workbench page's main frame.
  const fromPage = (event: Electron.IpcMainEvent | IpcMainInvokeEvent) => fromMainFrame(event, dshView.view?.webContents)
  ipcMain.handle(IPC.editionRead, event => {
    if (!fromPage(event)) throw new Error('Workbench only')
    return edition.state()
  })
  ipcMain.handle(IPC.editionAction, (event, action: unknown) => {
    if (!fromPage(event)) trusted(event)
    return edition.action(action)
  })
  ipcMain.handle(IPC.teamPickFiles, async (event, defaultPath: unknown) => {
    const running = service
    const team = () => fromPage(event) && service === running && running?.profile?.edition === 'team' && dshView.attached
    if (!team() || !window) throw new Error('Team workbench only')
    const result = await dialog.showOpenDialog(window, {
      title: tr('选择要上传到云盘的文件或文件夹', 'Select files or folders to upload'),
      buttonLabel: tr('选择', 'Select'),
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      defaultPath: typeof defaultPath === 'string' && !defaultPath.includes('\0') && isAbsolute(defaultPath) ? defaultPath : undefined
    })
    return !team() || result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(IPC.localeRead, event => {
    if (!fromPage(event)) throw new Error('Workbench only')
    return localeBootstrap([app.getLocale(), ...app.getPreferredSystemLanguages()], storedLocale())
  })
  ipcMain.handle(IPC.workbenchForeground, event => fromPage(event) && dshView.attached && workbenchWindowForeground())
  ipcMain.on(IPC.localeChange, (event, locale: unknown) => {
    const language = fromPage(event) ? uiLanguageOf(locale) : undefined
    if (language) setUiLanguage(language)
  })
}

const captureJob = process.argv.find(arg => arg.startsWith(captureFlag))?.slice(captureFlag.length)

if (captureJob) {
  // Headless page capture for the DSH `preview` tool; no window, no DSH, no single-instance lock.
  runCapture(captureJob)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  // A hidden macOS window keeps the app and its DSH service alive.
  app.on('window-all-closed', () => {})
  app.on('before-quit', event => {
    if (readyToQuit) return
    event.preventDefault()
    if (quitPending) return
    quitPending = true
    edition.abortLogin()
    dshView.cancelRecovery()
    window?.hide()
    void Promise.resolve(service?.stop()).then(() => {
      notifications.dispose()
      readyToQuit = true
      app.quit()
    }).catch(error => {
      quitPending = false
      pageFailed(error instanceof Error ? error.message : tr('DSH 尚未停止，请重试退出。', 'DSH has not stopped yet. Try quitting again.'))
      showWindow()
    })
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit())
  process.on('exit', () => {
    service?.killOnExit()
  })

  void app.whenReady().then(async () => {
    syncLanguage()
    await resolveFolders()
    personalDshHome = dshHome
    const local = app.getPath('userData')
    const coworkConfig = coworkConnection(await readJsonFile(join(local, 'cowork-connection.json')), Boolean(isolatedDataDirectory))
    if (coworkConfig) edition = createEdition(new CoworkSession(coworkConfig, coworkVault(local, safeStorage)), coworkConfig)
    app.dock?.setIcon(appIcon)
    refreshStartupAppearance()
    syncLanguage()
    service = await createService()
    attention = createAttention()
    await attention.start()
    window = createMainWindow()
    window.on('focus', () => edition.check(true))
    setInterval(() => edition.check(false), 60_000).unref()
    registerIpc()
    onUiLanguageChange(() => { rebuildMenus(); setDockMenu(); sendState() })
    rebuildMenus()
    await loadFigPage(window)
    window.show()
    latestDshNote = noteLatestDsh()
    if (startupChoice) {
      await new Promise<string>(resolve => { startupChosen = resolve; sendState() })
      startupChosen = undefined
    }
    if (!await edition.start()) await service.start()
  }).catch(error => {
    // Startup before the React surface exists is reported in the process stderr.
    console.error('Fig Desktop could not open its startup window:', errorText(error))
    readyToQuit = true
    service?.killOnExit()
    app.exit(1)
  })
}
