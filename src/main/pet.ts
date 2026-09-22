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
 * Where the pet appears the first time: on the desk BESIDE riven, never on top
 * of it. It is not an always-on-top window any more, so a spot inside riven's
 * bounds would simply be covered the moment riven has focus — the pet would be
 * open and invisible. Right of the window, else left, else the display corner.
 */
function firstSpot(): { x: number; y: number } {
  const app = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== win)
  const area = app
    ? screen.getDisplayMatching(app.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea
  const { width: w, height: h } = DEFAULT_SIZE
  const gap = 14
  const bottom = (top: number): number =>
    Math.min(Math.max(area.y + 8, top), area.y + area.height - h - 8)

  if (app) {
    const b = app.getBounds()
    const right = b.x + b.width + gap
    if (right + w <= area.x + area.width) return { x: right, y: bottom(b.y + b.height - h) }
    const left = b.x - gap - w
    if (left >= area.x) return { x: left, y: bottom(b.y + b.height - h) }
  }
  return {
    x: area.x + area.width - w - 24,
    y: area.y + area.height - h - 24
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
    // Opens as an ordinary window; the renderer lifts it straight away if the
    // user asked for that (settings.petOnTop → 'pet:setOnTop').
    alwaysOnTop: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
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

function applyOnTop(on: boolean): void {
  // 'floating' sits above ordinary windows without fighting menus and panels.
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(on, 'floating')
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
  // A / B / C from a keyboard shortcut. Relayed to every window because the
  // device lives in one of two of them and only that one listens.
  ipcMain.handle('pet:press', (_e, key: string) => {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send('pet:press', key)
  })

  // Floating above other apps is the user's call (settings.petOnTop).
  //
  // Two channels because only ONE window may write settings.json (they each keep
  // their own snapshot and a second writer clobbers the first):
  //   setOnTop — the app applying what it has persisted.
  //   askOnTop — the pet window's own setup row: apply now, and tell the app to
  //              persist it, since the pet window must not.
  //
  // BOTH announce the result. Only askOnTop used to, so when the app applied the
  // setting the pet's own setup row kept showing the old answer — and the next
  // press on it then toggled the wrong way.
  const announce = (on: boolean): void => {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send('pet:onTop', on)
  }
  ipcMain.handle('pet:setOnTop', (_e, on: boolean) => {
    applyOnTop(!!on)
    announce(!!on)
  })
  ipcMain.handle('pet:askOnTop', (_e, on: boolean) => {
    applyOnTop(!!on)
    announce(!!on)
  })
  ipcMain.handle('pet:isOnTop', () => !!win && !win.isDestroyed() && win.isAlwaysOnTop())
}
