// src/main/remoteKey.ts in the Tauri build: remoteKey:* run in Rust
// (src-tauri/src/services/remote_key.rs), sealed the way the shim's
// safeStorage sealed it, so remote-key.bin still opens.
export function registerRemoteKey(): void {}
