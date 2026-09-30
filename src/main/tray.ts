import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'

// riven in the macOS menu bar: the agents that want you, from anywhere.
//
// The rail already shows which panes are waiting on an answer or have finished
// something nobody has looked at — but only while riven's window is in front of
// you. This puts the same list where it can be seen over any app: the count of
// them beside the icon, and a menu that takes you straight to each pane (the
// same landing a desktop notification's click does).
//
// The renderer owns the facts (it is where the roster lives) and reports them
// here as a whole list whenever they change; this side only draws.

export interface TrayItem {
  paneId: string
  title: string
  workspace: string
  kind: 'waiting' | 'done'
}

export interface TrayFeed {
  enabled: boolean
  items: TrayItem[]
  busy: number
  ko: boolean
}

// The riven mark: its four tiles in ink with the R cut out of them — a template
// image (one colour; the R is where there is none), so macOS draws it in the
// menu bar's own colour. 18pt like the icons beside it, the mark filling ~15pt.
const ICON_1X = 'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABPElEQVR4AaySvy5GQRDFJ2qJJ9B6DTQqWgWhoqCmRq8mQkUoPIIGjcpz6IUHcH6bnc2YvSuRfDdzdv6cmfPNd+/O2YyeKLQlzYOEHeVuxJlnpvAuROFelYuEW+V7FcSZZ4ZZc6EFNY8MDvzFN6HcdKbCasWjPKAGlPbmG/WM2Yv9fk6VglxX2YYbFVLHibBZgYhCe+XI8I2+MxFyOLAcajGEaxvdidkXjiqe5LFjHVcV2/KLwpfgfcww24TETdp7qH4oRkiuN/9rXLZr0ecVa/IY72VDAViRfxPWBe9jhtm20bzIKeO9LIkACCnsrMz6Rh3738JIiE3yBlO19nsjIUSe1YWXK0aca4XgcKFPkgHgwIC2wrnQg7q4J4fyEbvKbyqII0fMDLPtq6nXKFwqiCiXTTWMOHLEzMDZDwAAAP//4xYTXgAAAAZJREFUAwCHJkElWEp1vQAAAABJRU5ErkJggg=='
const ICON_2X = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAACE0lEQVR4AeyXzy4EQRDG8QpuPARXJ9y5iXgFR39OSJDgxpl4AREncecReAhuTl7A99tNzVbXTma7LbMr2U3V1tfVVf1927M9mZmZGrPPRNCgC1K3Qwdqes30M9VFI5fbD1fSHwVRcK6KhUw/VN2l3AxMLrcfLjitfyoK2qxm8sGWK/XYpRthwhkFNXa2MfnvBZ1ql6JfKWcGZv7FEqWxZIcgORFBdP7ISncMzPyqRtNyehTyrURQ/qq9SoQViRpG0Ip48SVFM48txyU0PDAOK+hZDA9yMzA5GxNb2yHI6pxdw/1ctqhhdsgTRhwFxXGsr8ZR0FM1kw8eXanHLt0IE84o6Eit3Es+FKN/KuftS4Nr+bbcDLyuAUdfoWN7+o5r2RguOFXStSiILAvMC0TfUM4b9xwE+Bw4+cVKUBfXsjFcKulZnaDe7AhQnSB+0bu0ROdIK11scR0/hitZMAri4WpXFXM1PqucN/4n3HN2XHJNmLxCZbdCdeuRgwtOlXQtCmLB7kzeN8d535XeCB/LSyzhjIJKFvqT2omgQds62aHf3iGOtPlyw+JWQ2yq61si55JZE0ecI23O2OZitBpiU13s63sv6ytoO1GyQ61oi4Luf8B653o8dulGmHBGQRdq5d38TTHHeTf3jxBgcjm91MAFp+i6FgWRpWBRIMeThyv1YORyeqmBi57K6wRVk6MAYyfoGwAA//9HAhfmAAAABklEQVQDAL8Xf0lNvRxaAAAAAElFTkSuQmCC'

function icon(): Electron.NativeImage {
  const img = nativeImage.createFromBuffer(Buffer.from(ICON_1X, 'base64'), { scaleFactor: 1 })
  img.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(ICON_2X, 'base64') })
  img.setTemplateImage(true)
  return img
}

let tray: Tray | null = null
let last: TrayFeed = { enabled: false, items: [], busy: 0, ko: true }
// What was last drawn, readable by the e2e suite — which never puts a real icon
// in the menu bar of the machine it runs on (see RIVEN_TEST_BACKGROUND).
let drawn: { title: string; labels: string[] } = { title: '', labels: [] }

function appWindow(getWindow: () => BrowserWindow | null): BrowserWindow | null {
  const w = getWindow()
  return w && !w.isDestroyed() ? w : null
}

function bringUp(getWindow: () => BrowserWindow | null, paneId?: string): void {
  const w = appWindow(getWindow)
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  app.focus({ steal: true })
  // The same message a notification click sends: switch to the pane's
  // workspace and bring the pane forward.
  if (paneId) w.webContents.send('notify:click', paneId)
}

function menuFor(feed: TrayFeed, getWindow: () => BrowserWindow | null): MenuItemConstructorOptions[] {
  const k = feed.ko
  const row = (i: TrayItem): MenuItemConstructorOptions => ({
    label: `${i.title} — ${i.workspace}`,
    click: () => bringUp(getWindow, i.paneId)
  })
  const waiting = feed.items.filter((i) => i.kind === 'waiting')
  const done = feed.items.filter((i) => i.kind === 'done')
  const out: MenuItemConstructorOptions[] = []
  if (waiting.length) {
    out.push({ label: k ? '입력을 기다리는 중' : 'Waiting for you', enabled: false }, ...waiting.map(row))
  }
  if (done.length) {
    if (out.length) out.push({ type: 'separator' })
    out.push({ label: k ? '끝남 · 아직 안 봄' : 'Finished · not seen yet', enabled: false }, ...done.map(row))
  }
  if (!out.length) out.push({ label: k ? '새 알림 없음' : 'Nothing new', enabled: false })
  if (feed.busy > 0) {
    out.push({ type: 'separator' }, {
      label: k ? `작업 중인 에이전트 ${feed.busy}개` : `${feed.busy} agent${feed.busy === 1 ? '' : 's'} working`,
      enabled: false
    })
  }
  out.push(
    { type: 'separator' },
    { label: k ? 'riven 열기' : 'Open riven', click: () => bringUp(getWindow) },
    { label: k ? 'riven 종료' : 'Quit riven', click: () => app.quit() }
  )
  return out
}

function draw(getWindow: () => BrowserWindow | null, real: boolean): void {
  const feed = last
  const count = feed.items.length
  const template = menuFor(feed, getWindow)
  drawn = {
    title: feed.enabled && count ? String(count) : '',
    labels: feed.enabled ? template.filter((m) => m.label).map((m) => m.label as string) : []
  }
  if (!real) return
  if (!feed.enabled) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    tray = new Tray(icon())
    tray.setIgnoreDoubleClickEvents(true)
  }
  // The count beside the icon is the badge: nothing when there is nothing.
  tray.setTitle(count ? String(count) : '', { fontType: 'monospacedDigit' })
  tray.setToolTip(count ? `riven — ${count}` : 'riven')
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

export function registerTray(getWindow: () => BrowserWindow | null): void {
  // macOS only: it is the menu bar this is for, and the count-as-title it relies
  // on does not exist in the Windows tray.
  const real = process.platform === 'darwin' && process.env.RIVEN_TEST_BACKGROUND !== '1'
  ipcMain.on('tray:feed', (_e, feed: TrayFeed) => {
    last = feed
    draw(getWindow, real)
  })
  ipcMain.handle('tray:diag', () => drawn)
  app.on('before-quit', () => {
    tray?.destroy()
    tray = null
  })
}
