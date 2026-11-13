// src/main/db/engine.ts in the Tauri build. The DB feature (drivers, catalogs,
// export/import, backup, the riven_db_* MCP tools) lives in Rust
// (src-tauri/src/services/db, src-tauri/src/commands/db.rs); its channels never
// reach Node (tauri/shim/rust-owned.ts), so there is nothing to register.
export function registerDbHandlers(): void {}
