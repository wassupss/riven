import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Launching the real app for a test.
//
// Every run gets its own --user-data-dir, which is what keeps these tests off
// the developer's actual riven: settings, the session tree, chat profiles and
// the pet all live under userData, and a test that toggles a switch must not
// toggle it in the app somebody is using.
//
// The workspace is seeded rather than opened through the UI: opening a folder
// goes through the OS file dialog, which a test cannot drive, and the built app
// exposes no dev hooks to do it from a script.

export interface Launched {
  app: ElectronApplication
  page: Page
  userDataDir: string
  /** A temporary folder opened as a workspace, so tests have one to act on. */
  workspace: string
}

export interface LaunchOptions {
  /** Reuse a previous run's profile — for testing what survives a restart. */
  userDataDir?: string
  /** Reuse a previous run's workspace folder, with whatever is in it. */
  workspace?: string
  /** Files to write into the workspace before launch, path → contents. */
  files?: Record<string, string>
  /** `git init` the workspace, commit the seeded files, and leave one dirty. */
  git?: boolean
  /** Agent groups to seed into the session tree for this workspace. */
  groups?: Array<{ group: string; members: Array<{ name: string; chatKey: string; parent: number | null }> }>
}

function seedFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
}

function seedGit(root: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'e2e@riven.test')
  git('config', 'user.name', 'riven e2e')
  git('config', 'commit.gpgsign', 'false')
  // A remote nobody talks to: enough for the card to name the repository.
  git('remote', 'add', 'origin', 'git@github.com:riven-e2e/sample.git')
  git('add', '-A')
  git('commit', '-m', 'seed')
  // One tracked file changed after the commit, so the card has something dirty
  // to count and the git panel has a row to show.
  writeFileSync(join(root, 'README.md'), '# sample\n\nchanged after the commit\n')
}

export async function launchRiven(opts: LaunchOptions = {}): Promise<Launched> {
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'riven-e2e-'))
  const workspace = opts.workspace ?? mkdtempSync(join(tmpdir(), 'riven-ws-'))

  if (opts.files) seedFiles(workspace, opts.files)
  if (opts.git) seedGit(workspace)

  if (!opts.userDataDir) {
    writeFileSync(
      join(userDataDir, 'sessions.json'),
      JSON.stringify({
        openWorkspaces: [workspace],
        activeWorkspace: workspace,
        sessions: {
          [workspace]: {
            openTabs: [],
            activePath: null,
            previewUrl: '',
            dockLayout: null,
            ...(opts.groups
              ? {
                  groups: opts.groups.map((g) => ({
                    group: g.group,
                    members: g.members.map((m) => ({
                      name: m.name,
                      persona: null,
                      model: 'default',
                      parent: m.parent,
                      chatKey: m.chatKey
                    }))
                  }))
                }
              : {})
          }
        }
      })
    )
  }

  const app = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // A test must never spawn an agent CLI or a pet window by accident.
      RIVEN_E2E: '1'
    }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.ws-card', { timeout: 60_000 })
  return { app, page, userDataDir, workspace }
}

/** ⌘O, the panel picker: the one way in that does not depend on a menu bar. */
export async function openPanel(page: Page, label: string): Promise<void> {
  await page.keyboard.press('Meta+o')
  await page.waitForSelector('.qp-dialog')
  await page.locator('.qp-item').filter({ hasText: label }).first().click()
  await page.waitForSelector('.qp-dialog', { state: 'detached' })
}
