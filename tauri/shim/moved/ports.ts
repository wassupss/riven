// src/main/ports.ts in the Tauri build: ports:list and ports:kill run in Rust
// (src-tauri/src/services/tools.rs); the channels never reach Node.
export function registerPortsHandlers(): void {}
