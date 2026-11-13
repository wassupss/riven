// src/main/apiclient.ts in the Tauri build: api:request runs in Rust
// (src-tauri/src/services/http.rs); the channel never reaches Node.
export function registerApiHandlers(): void {}
