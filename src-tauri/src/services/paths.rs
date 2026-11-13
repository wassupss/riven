// Where riven keeps its data. Must stay the same directory the Node shim's
// app.getPath('userData') answers (tauri/shim/electron-main.ts APP_NAME), so
// data written before a group moved to Rust is still found after.

use std::path::PathBuf;

pub const APP_NAME: &str = "riven-tauri";

pub fn home() -> PathBuf {
  std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn user_data() -> PathBuf {
  home().join("Library").join("Application Support").join(APP_NAME)
}

/// userData/<basename(name)>: a name can never climb out of the directory.
pub fn user_file(name: &str) -> PathBuf {
  let base = std::path::Path::new(name).file_name().map(|s| s.to_owned()).unwrap_or_default();
  user_data().join(base)
}
