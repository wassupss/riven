import { defineConfig } from 'vitest/config'

// Unit tests are the ones under src. e2e/ belongs to Playwright, which launches
// a real Electron app — running those under vitest picks up `test()` from the
// wrong runner and fails in a way that says nothing about the code.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
