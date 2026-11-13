// src/main/githubPr.ts in the Tauri build. The group now lives in Rust
// (src-tauri/src/services/git/github.rs, commands/git.rs); its channels never
// reach Node (tauri/shim/rust-owned.ts), so there is nothing to register.
export function registerGithubHandlers(): void {}
