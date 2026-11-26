import { app, BrowserWindow, dialog } from 'electron'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import appIcon from '../../../assets/brand/app-icon.png?asset'
import { tr } from './language'

// The About box and the third-party license list it opens (built into third-party-licenses/ beside main).
const licenseFolder = join(fileURLToPath(new URL('.', import.meta.url)), 'third-party-licenses')
let licenseWindow: BrowserWindow | undefined

/** Shows the About box over `parent` when it is on screen; its second button opens the local license list. */
export async function showAbout({ parent, dshRelease }: { parent?: BrowserWindow, dshRelease: string }): Promise<void> {
  const title = tr('关于 Fig Desktop', 'About Fig Desktop')
  const options = {
    type: 'info' as const,
    title,
    message: 'Fig Desktop',
    detail: tr(`版本 ${app.getVersion()}\nDSH ${dshRelease}`, `Version ${app.getVersion()}\nDSH ${dshRelease}`),
    icon: appIcon,
    buttons: [tr('好', 'OK'), tr('查看第三方许可证…', 'View Third-Party Licenses…')],
    defaultId: 0,
    cancelId: 0
  }
  const { response } = parent && !parent.isDestroyed() && parent.isVisible()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (response !== 1) return
  if (licenseWindow && !licenseWindow.isDestroyed()) {
    licenseWindow.show()
    return
  }

  const viewer = new BrowserWindow({
    title: tr('第三方许可证', 'Third-Party Licenses'), width: 850, height: 700, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  licenseWindow = viewer
  viewer.on('closed', () => { licenseWindow = undefined })
  viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  viewer.webContents.on('will-navigate', (event, url) => {
    const local = url.startsWith('file:') && new URL(url)
    if (!local || !fileURLToPath(local).startsWith(licenseFolder + sep)) event.preventDefault()
  })
  try {
    await viewer.loadFile(join(licenseFolder, 'index.html'))
    viewer.show()
  } catch {
    if (!viewer.isDestroyed()) viewer.close()
    dialog.showErrorBox(title, tr('无法打开本地许可证清单。', 'The local license list could not be opened.'))
  }
}
