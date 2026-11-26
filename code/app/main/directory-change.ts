import { dialog, type BrowserWindow, type WebContents } from 'electron'
import { configureDirectory, directoryErrorText } from './directory-dialogs'
import type { Directories, DirectoryKind, DirectorySettings } from './directory-settings'
import { directoryStatusEvent } from '../../harness/shared/page-contract'
import { tr } from './language'

interface DirectoryChangeHost {
  settings: DirectorySettings;
  /** The DSH release Fig started; the default-workspace write is gated on it. */
  release: string;
  window(): BrowserWindow | undefined;
  /** The workbench page's contents while it is shown. */
  page(): WebContents | undefined;
  quitting(): boolean;
  ready(): boolean;
  current(): Directories;
  /** Whether no Session or background job runs, asked over the Host's capability bridge. */
  idle(): Promise<boolean>;
  /** DSH's default Workspace as its registry on disk records it. */
  defaultWorkspace(): Promise<string | undefined>;
  /** Stop DSH and its page; the startup page shows `message` meanwhile. */
  stop(kind: DirectoryKind): Promise<void>;
  settle(): Promise<void>;
  resume(): Promise<void>;
  restart(): void;
}

/**
 * Runs one native directory change asked for by the workbench page (configureDirectory), one at a time.
 * The page keeps its directory buttons busy meanwhile.
 */
export function directoryChanger(host: DirectoryChangeHost) {
  let busy = false
  return async function changeDirectory(contents: WebContents, origin: string, kind: DirectoryKind): Promise<void> {
    const valid = () => !host.quitting() && host.page() === contents && !contents.isDestroyed() && new URL(contents.getURL()).origin === origin && host.ready()
    const window = host.window()
    if (busy || !window || !valid()) return
    busy = true
    const status = (busy: boolean) => {
      if (!contents.isDestroyed()) void contents.executeJavaScript(`window.dispatchEvent(new CustomEvent('${directoryStatusEvent}', {detail: {busy: ${busy}}}))`).catch(() => {})
    }
    status(true)
    try {
      await configureDirectory(kind, {
        settings: host.settings, current: host.current(), release: host.release,
        valid, idle: host.idle, defaultWorkspace: host.defaultWorkspace,
        choose: options => dialog.showOpenDialog(window, options), confirm: options => dialog.showMessageBox(window, options),
        stop: () => host.stop(kind),
        settle: host.settle,
        resume: host.resume,
        // Relaunch only after DSH stop and the verified/atomic switch have completed.
        restart: host.restart
      })
    } catch (error) {
      if (!window.isDestroyed()) await dialog.showMessageBox(window, {type: 'error', title: tr('目录修改未完成', 'Folder change not finished'), message: directoryErrorText(error), buttons: [tr('好', 'OK')]})
    } finally { busy = false; status(false) }
  }
}
