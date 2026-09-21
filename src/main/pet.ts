import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from './atomicWrite'

// ---------------------------------------------------------------------------
// 리븐펫's own window: a frameless, transparent, always-on-top pane that can be
// dragged ANYWHERE on the desktop, not just inside riven. It renders the same
// device the app embeds (src/renderer/pet.html), so there is one component
// and one save file either way.
//
// Exactly one of the two is ever live: the app hides its in-window device while
// this exists, so the pet is never fed twice or ticked twice.
// ---------------------------------------------------------------------------

const BOUNDS_FILE = 'pet-window.json'
const DEFAULT_SIZE = { width: 212, height: 330 }

let win: BrowserWindow | null = null

function boundsPath(): string {
  return join(app.getPath('userData'), BOUNDS_FILE)
}

async function readBounds(): Promise<{ x: number; y: number } | null> {
  try {
    const o = JSON.parse(await fs.readFile(boundsPath(), 'utf8'))
    return typeof o?.x === 'number' && typeof o?.y === 'number' ? { x: o.x, y: o.y } : null
  } catch {
    return null
  }
}

// Only keep a position that still lands on a display that exists — an external
// monitor gets unplugged and the pet would otherwise open off-screen forever.
function onScreen(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea
    return x + width > w.x + 40 && x < w.x + w.width - 40 && y + height > w.y && y < w.y + w.height - 40
  })
}

function broadcast(channel: string): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel)
}

async function open(): Promise<void> {
  if (win && !win.isDestroyed()) {
    win.showInactive()
    return
  }
  const saved = await readBounds()
  const fits = saved && onScreen(saved.x, saved.y, DEFAULT_SIZE.width, DEFAULT_SIZE.height)
  const work = screen.getPrimaryDisplay().workArea
  const x = fits ? saved!.x : work.x + work.width - DEFAULT_SIZE.width - 24
  const y = fits ? saved!.y : work.y + work.height - DEFAULT_SIZE.height - 24

  win = new BrowserWindow({
    ...DEFAULT_SIZE,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 'floating' keeps it above ordinary windows without fighting menus/panels.
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  // Follow the user across spaces — a desk pet that vanishes when you switch
  // desktops is not much of a desk pet.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const save = (): void => {
    if (!win || win.isDestroyed()) return
    const [bx, by] = win.getPosition()
    void atomicWriteJson(boundsPath(), { x: bx, y: by })
  }
  win.on('moved', save)
  win.on('ready-to-show', () => win?.showInactive()) // never steals focus
  win.on('closed', () => {
    win = null
    broadcast('pet:closed')
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/pet.html'))
  }
}

export function closePetWindow(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
}

export function isPetWindowOpen(): boolean {
  return !!win && !win.isDestroyed()
}

export function registerPetHandlers(): void {
  ipcMain.handle('pet:open', () => open())
  ipcMain.handle('pet:close', () => closePetWindow())
  // The pet asked to be put away entirely (its ✕): close the window AND tell the
  // app so the setting matches what the user just did.
  ipcMain.handle('pet:hide', () => {
    closePetWindow()
    broadcast('pet:hidden')
  })
  // The device measures itself and asks for a window that fits — folding it down
  // or opening its details changes how tall it is.
  ipcMain.handle('pet:resize', (_e, height: number) => {
    if (!win || win.isDestroyed()) return
    const h = Math.max(120, Math.min(900, Math.round(height)))
    const [w] = win.getSize()
    win.setSize(w, h, false)
  })
  ipcMain.handle('pet:isOpen', () => isPetWindowOpen())
}
