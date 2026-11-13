// src/main/debugger.ts in the Tauri build. The Node.js debugger lives in Rust
// (src-tauri/src/services/debug.rs, commands/debug.rs) and runs the user's
// installed node; the debug:* channels never reach Node.
export function registerDebuggerHandlers(): void {}
