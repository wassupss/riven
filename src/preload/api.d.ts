import type { Api } from './index'

// Kept out of index.d.ts on purpose: a d.ts sitting next to index.ts is treated
// as that file's declaration output and dropped from any project that also
// compiles index.ts, taking this augmentation with it.
declare global {
  interface Window {
    api: Api
  }
}

export {}
