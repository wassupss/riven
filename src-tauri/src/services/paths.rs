// Where riven keeps its data.
//
// The released app (bundle id dev.riven.app, the id electron-builder.yml gives
// the Electron app) uses the folder Electron's app.getPath('userData') answers
// for the packaged app: ~/Library/Application Support/riven (package.json
// productName "riven", and src/main/index.ts app.setName('riven') when
// packaged). Same folder, same files: an Electron user who updates to the Tauri
// build finds everything where it was.
//
// Every other build (cargo run, the dev .app wrapper with id riven-tauri, a
// locally packaged dev.riven.tauri, cargo test) keeps to its own folder,
// ~/Library/Application Support/riven-tauri, so a test can never touch the
// real Electron data. RIVEN_TAURI_DATA_DIR (tests) points any build at a
// folder of its own.

use std::path::PathBuf;
use std::sync::OnceLock;

/// The Electron app's bundle id (electron-builder.yml appId). The Tauri
/// release build carries the same one (tauri.bundle.json).
pub const RELEASE_BUNDLE_ID: &str = "dev.riven.app";
/// The folder name of the released app (Electron's userData).
pub const RELEASE_NAME: &str = "riven";
/// The folder name of every other build.
pub const DEV_NAME: &str = "riven-tauri";

pub fn home() -> PathBuf {
  std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// This process's bundle id, if it runs from a bundle.
pub fn bundle_id() -> Option<String> {
  #[cfg(target_os = "macos")]
  {
    use objc2_foundation::NSBundle;
    if let Some(id) = NSBundle::mainBundle().bundleIdentifier() {
      return Some(id.to_string());
    }
  }
  None
}

/// True only for the released app: the one that shares Electron's data,
/// keychain item and bundle id.
pub fn is_release() -> bool {
  static R: OnceLock<bool> = OnceLock::new();
  *R.get_or_init(|| release_for(bundle_id().as_deref()))
}

pub fn release_for(bundle_id: Option<&str>) -> bool {
  bundle_id == Some(RELEASE_BUNDLE_ID)
}

/// The app name used for the data folder (and, in safe_storage, the keychain
/// item), as Electron's app.getName() is.
pub fn app_name() -> &'static str {
  if is_release() {
    RELEASE_NAME
  } else {
    DEV_NAME
  }
}

pub fn user_data() -> PathBuf {
  static D: OnceLock<PathBuf> = OnceLock::new();
  D.get_or_init(|| match std::env::var_os("RIVEN_TAURI_DATA_DIR").filter(|v| !v.is_empty()) {
    Some(d) => PathBuf::from(d),
    None => home().join("Library").join("Application Support").join(app_name()),
  })
  .clone()
}

/// userData/<basename(name)>: a name can never climb out of the directory.
pub fn user_file(name: &str) -> PathBuf {
  let base = std::path::Path::new(name).file_name().map(|s| s.to_owned()).unwrap_or_default();
  user_data().join(base)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_the_release_id_shares_electrons_folder() {
    assert!(release_for(Some("dev.riven.app")));
    for other in [None, Some("riven-tauri"), Some("dev.riven.tauri"), Some("riven-tauri-migtest"), Some("dev.riven.app.x")] {
      assert!(!release_for(other), "{other:?}");
    }
    // cargo test runs without a bundle: never the shared folder.
    assert!(!is_release());
    assert_eq!(app_name(), DEV_NAME);
  }
}
