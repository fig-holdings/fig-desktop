import { Menu } from 'electron'
import { tr } from './language'

/** Fig's application menu: About, Settings…, the main window and the standard Edit/Window roles. Built again on a language change. */
export function setApplicationMenu({ showAbout, showSettings, showWindow }: {
  showAbout: () => void
  showSettings: () => void
  showWindow: () => void
}): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Fig Desktop', submenu: [
      { id: 'fig-about', label: tr('关于 Fig Desktop', 'About Fig Desktop'), click: showAbout },
      { type: 'separator' },
      { id: 'fig-settings', label: tr('设置…', 'Settings…'), accelerator: 'CmdOrCtrl+,', click: showSettings },
      { type: 'separator' },
      { label: tr('打开主窗口', 'Open Main Window'), click: showWindow },
      { type: 'separator' },
      { role: 'hide', label: tr('隐藏 Fig Desktop', 'Hide Fig Desktop') }, { role: 'hideOthers', label: tr('隐藏其他应用', 'Hide Others') },
      { role: 'unhide', label: tr('显示全部', 'Show All') }, { type: 'separator' },
      { role: 'quit', label: tr('退出 Fig Desktop', 'Quit Fig Desktop') }
    ] },
    { label: tr('编辑', 'Edit'), submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: tr('窗口', 'Window'), submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { label: tr('打开主窗口', 'Open Main Window'), click: showWindow }] }
  ]))
}
