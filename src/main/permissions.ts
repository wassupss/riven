import { ipcMain, shell, systemPreferences, Notification } from 'electron'

// The permissions macOS grants riven, and what riven does with them.
//
// Every one of these is something the app genuinely uses and silently fails
// without: the MCP screenshot tool draws a black frame with no screen-recording
// permission, a site in the browser panel gets a dead microphone, and a finished
// agent turn notifies nobody. None of that says which permission is missing, so
// the settings screen has to.

export type PermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface PermissionReport {
  notifications: PermissionState
  screen: PermissionState
  microphone: PermissionState
  camera: PermissionState
  /** macOS only; elsewhere the app has whatever the platform gives it. */
  supported: boolean
}

// Deep links into the exact pane of System Settings, so "open settings" does not
// mean "go and find it".
const PANES: Record<string, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications'
}

function media(kind: 'microphone' | 'camera' | 'screen'): PermissionState {
  if (process.platform !== 'darwin') return 'unknown'
  try {
    return systemPreferences.getMediaAccessStatus(kind) as PermissionState
  } catch {
    return 'unknown'
  }
}

export function report(): PermissionReport {
  const mac = process.platform === 'darwin'
  return {
    // macOS exposes no query for notification authorisation; "supported" is the
    // most honest thing available, and the row says so rather than guessing.
    notifications: Notification.isSupported() ? 'unknown' : 'denied',
    screen: media('screen'),
    microphone: media('microphone'),
    camera: media('camera'),
    supported: mac
  }
}

export function registerPermissionHandlers(): void {
  ipcMain.handle('perm:report', () => report())

  // Only microphone and camera can be asked for in-process; screen recording and
  // notifications are granted in System Settings and nowhere else.
  ipcMain.handle('perm:ask', async (_e, kind: 'microphone' | 'camera') => {
    if (process.platform !== 'darwin') return true
    try {
      return await systemPreferences.askForMediaAccess(kind)
    } catch {
      return false
    }
  })

  ipcMain.handle('perm:open', (_e, kind: string) => {
    const url = PANES[kind]
    if (url) void shell.openExternal(url)
  })
}
