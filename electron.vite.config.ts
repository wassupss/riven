import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // The terminal worker is a SECOND main-process entry: utilityProcess
        // forks it by path, so it has to be emitted as its own chunk instead of
        // being bundled into index. externalizeDepsPlugin keeps node-pty and
        // @xterm/headless bare `require`s in both — a bundled native module
        // would not load.
        input: {
          index: resolve('src/main/index.ts'),
          'terminal-worker': resolve('src/main/terminal/worker-entry.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    worker: {
      format: 'es'
    }
  }
})
