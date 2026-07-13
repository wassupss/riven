import { Menu, BrowserWindow, MenuItemConstructorOptions } from 'electron'

// Custom application menu. The key change vs. the default: Cmd+W closes the
// active editor tab (via IPC) instead of the whole window, so people stop
// quitting the IDE by reflex. Window close moves to Cmd+Shift+W.
export function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const sendToFocused = (channel: string) => (): void => {
    BrowserWindow.getFocusedWindow()?.webContents.send(channel)
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: sendToFocused('menu:close-tab') },
        { type: 'separator' },
        isMac
          ? { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' }
          : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize', accelerator: 'CmdOrCtrl+M' }, { role: 'zoom' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
