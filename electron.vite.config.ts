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
    build: {
      rollupOptions: {
        // popout.html is a SECOND renderer entry. dockview opens a pop-out group
        // into its own document and defaults that url to '/popout.html'; without
        // this the file is never emitted, so the packaged app opened a window
        // pointing at a path that does not exist.
        input: {
          index: resolve('src/renderer/index.html'),
          popout: resolve('src/renderer/popout.html')
        }
      }
    },
    worker: {
      format: 'es'
    }
  }
})
