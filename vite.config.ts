// The renderer build (src/renderer -> out-tauri/renderer, Tauri's frontendDist).
// The page is plain Vite now: there is no Electron main or preload to build here.
// The preload is bundled by tauri/build.mjs.
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dockviewFilePopout } from './vite/dockviewFilePopout'
import { dockviewSubpixelOverflow } from './vite/dockviewSubpixelOverflow'

export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@': resolve('src/renderer/src')
    }
  },
  // dockviewFilePopout: see the file. Without it ⌘⇧O does nothing in the packaged
  // app, which loads its renderer from file://.
  // dockviewSubpixelOverflow: no false tab overflow dropdown under WebKit rounding.
  plugins: [react(), dockviewFilePopout(), dockviewSubpixelOverflow()],
  build: {
    outDir: resolve('out-tauri/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      // popout.html: dockview opens a pop-out group into its own document at
      // '/popout.html'. pet.html: the pet window (frameless, transparent) loads by path.
      input: {
        index: resolve('src/renderer/index.html'),
        popout: resolve('src/renderer/popout.html'),
        pet: resolve('src/renderer/pet.html')
      }
    }
  },
  worker: {
    format: 'es'
  }
})
