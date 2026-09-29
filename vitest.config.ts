import { defineConfig } from 'vitest/config'

// Unit tests are the ones under src. e2e/ belongs to Playwright, which launches
// a real Electron app — running those under vitest picks up `test()` from the
// wrong runner and fails in a way that says nothing about the code.
export default defineConfig({
  test: {
    // scripts/lib holds the pure halves of dev scripts (token-audit), tested here.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/lib/**/*.test.mjs']
  }
})
