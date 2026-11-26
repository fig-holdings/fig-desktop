import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type FigBridge, type ServiceState } from '../shared/protocol'

const bridge: FigBridge = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  retry: () => ipcRenderer.invoke(IPC.retry),
  quit: () => ipcRenderer.invoke(IPC.quit),
  chooseStartup: how => ipcRenderer.invoke(IPC.chooseStartup, how),
  disablePlugins: () => ipcRenderer.invoke(IPC.disablePlugins),
  editionAction: action => ipcRenderer.invoke(IPC.editionAction, action),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: ServiceState) => listener(state)
    ipcRenderer.on(IPC.state, handler)
    return () => ipcRenderer.removeListener(IPC.state, handler)
  }
}

contextBridge.exposeInMainWorld('fig', bridge)
