import { contextBridge, ipcRenderer } from 'electron'
// Only this preload imports page-contract, so the build inlines it rather than splitting a shared chunk.
import { windowForegroundGlobal } from '../../harness/shared/page-contract'

// The DSH page's native locale bridge (dsh-client-locale `__DSH_LOCALE__`): the page reads the system languages
// and stored preference before it mounts, and reports each language it switches to.
// The channel names repeat shared/protocol.ts on purpose: importing that module would
// make the build split a shared chunk, and a sandboxed preload cannot load one.
contextBridge.exposeInMainWorld('__DSH_LOCALE__', {
  read: () => ipcRenderer.invoke('fig:dsh-locale-read'),
  onChange: (locale: unknown) => { if (typeof locale === 'string' && locale.length <= 64) ipcRenderer.send('fig:dsh-locale-change', locale) }
})
// Native focus needs a separate read for WebContentsView. document.hasFocus() can stay true while
// the workbench's macOS window is behind another window.
contextBridge.exposeInMainWorld(windowForegroundGlobal, () => ipcRenderer.invoke('fig:dsh-foreground').catch(() => false))
contextBridge.exposeInMainWorld('__FIG_EDITION__', {
  read: () => ipcRenderer.invoke('fig:edition-read'),
  action: (action: unknown) => ipcRenderer.invoke('fig:edition-action', action),
  subscribe(listener: (state: unknown) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state)
    ipcRenderer.on('fig:edition-changed', handler)
    return () => ipcRenderer.removeListener('fig:edition-changed', handler)
  }
})
contextBridge.exposeInMainWorld('__FIG_TEAM_FILES__', {
  pick: (defaultPath: unknown) => ipcRenderer.invoke('fig:dsh-team-pick-files', defaultPath)
})
