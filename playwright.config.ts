import { defineConfig } from '@playwright/test'

// End-to-end against the REAL app: Playwright launches Electron with the built
// main process, so what these tests exercise is what ships — not a mounted
// component tree with the interesting parts mocked out.
//
// Serial, one worker: a second instance would fight this one over the session
// file and the pty server they both write to.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // Electron takes a few seconds to come up, restore its layout and settle.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0
})
