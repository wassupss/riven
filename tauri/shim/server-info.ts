// Where the renderer is served from. Set by server.ts once it is listening;
// windows.ts reads it to turn a loadFile() path into a page URL.
import * as path from 'path'

let origin = ''

export function setServerOrigin(o: string): void {
  origin = o
}
export function serverOrigin(): string {
  return origin
}
// main/index.js lives in out-tauri/main; the renderer build sits beside it.
export function rendererDir(): string {
  return path.join(__dirname, '../renderer')
}
