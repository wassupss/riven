// src/main/watch.ts in the Tauri build. The workspace watcher lives in Rust
// (src-tauri/src/commands/watch.rs); its channels never reach Node
// (tauri/shim/rust-owned.ts), so there is nothing to register.
export function registerWatchHandlers(): void {}
