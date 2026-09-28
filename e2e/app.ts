import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Launching the real app for a test.
//
// Every run gets its own --user-data-dir, which is what keeps these tests off
// the developer's actual riven: settings, the session tree, chat profiles and
// the pet all live under userData, and a test that toggles a switch must not
// toggle it in the app somebody is using.

export interface Launched {
  app: ElectronApplication
  page: Page
  userDataDir: string
  /** A temporary folder opened as a workspace, so tests have one to act on. */
  workspace: string
}

export async function launchRiven(): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'riven-e2e-'))
  const workspace = mkdtempSync(join(tmpdir(), 'riven-ws-'))
  // Seeded rather than opened through the UI: opening a folder goes through the
  // OS file dialog, which a test cannot drive, and the built app exposes no
  // dev hooks to do it from script. The session file is the app's own format.
  writeFileSync(
    join(userDataDir, 'sessions.json'),
    JSON.stringify({
      openWorkspaces: [workspace],
      activeWorkspace: workspace,
      sessions: { [workspace]: { openTabs: [], activePath: null, previewUrl: '', dockLayout: null } }
    })
  )
  const app = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // A test must never spawn an agent CLI or a pet window by accident.
      RIVEN_E2E: '1'
    }
  })
  const page = await app.firstWindow()
  // The rail is the last thing to arrive: it waits for the session tree to load.
  await page.waitForSelector('.ws-card', { timeout: 60_000 })
  return { app, page, userDataDir, workspace }
}
