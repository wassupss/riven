// src/main/lsp.ts in the Tauri build. Language servers live in Rust
// (src-tauri/src/services/lsp.rs, commands/lsp.rs), installed servers only;
// the lsp:* channels never reach Node (tauri/shim/rust-owned.ts).
export function registerLspHandlers(): void {}
