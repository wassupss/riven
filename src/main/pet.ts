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

/**
 * Where the pet appears the first time. Beside riven's own window, NOT in the
 * far corner of the display: on a wide screen that corner can be a metre from
 * what you are looking at, and popping the pet out looked like losing it.
 */
function firstSpot(): { x: number; y: number } {
  const app = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== win)
  const area = app
    ? screen.getDisplayMatching(app.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea
  const anchor = app ? app.getBounds() : area
  // Just inside the app's bottom-right corner, then clamped onto the display.
  const x = anchor.x + anchor.width - DEFAULT_SIZE.width - 28
  const y = anchor.y + anchor.height - DEFAULT_SIZE.height - 28
  return {
    x: Math.min(Math.max(area.x + 8, x), area.x + area.width - DEFAULT_SIZE.width - 8),
    y: Math.min(Math.max(area.y + 8, y), area.y + area.height - DEFAULT_SIZE.height - 8)
  }
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
  const spot = fits ? saved! : firstSpot()
  const { x, y } = spot

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
  // The device measures itself and asks for a window that fits — folding it down,
  // opening a screen, or speaking changes how tall it is.
  //
  // The window grows from its BOTTOM edge: the device sits at the bottom of the
  // glass, so anchoring there keeps the pet still while a speech balloon opens
  // above it. Growing downward made the pet slide down the screen mid-sentence.
  ipcMain.handle('pet:resize', (_e, height: number) => {
    if (!win || win.isDestroyed()) return
    const h = Math.max(120, Math.min(900, Math.round(height)))
    const b = win.getBounds()
    if (b.height === h) return
    win.setBounds({ x: b.x, y: b.y + (b.height - h), width: b.width, height: h }, false)
  })
  ipcMain.handle('pet:isOpen', () => isPetWindowOpen())
}
