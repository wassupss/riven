// The renderer's own data as files: userData/store/<name>.json, one JSON value
// per file (src/main/store.ts, the same folder and format). Saving null
// removes the file.

use super::{blocking, CmdResult};
use crate::services::{atomic, fsx, paths};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub const STORE_DIR: &str = "store";

/// /^[a-z0-9][a-z0-9.-]{0,63}$/: names the renderer picks, never a path.
pub fn valid_name(name: &str) -> bool {
  let b = name.as_bytes();
  !b.is_empty()
    && b.len() <= 64
    && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
    && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'.' || *c == b'-')
}

pub fn dir() -> PathBuf {
  paths::user_data().join(STORE_DIR)
}

fn file_for(name: &str) -> Result<PathBuf, String> {
  if !valid_name(name) {
    return Err(format!("store: bad name '{name}'"));
  }
  Ok(dir().join(format!("{name}.json")))
}

/// Every store file in `dir`: name -> value, in name order. A file that does
/// not parse is left out.
pub fn load_all(dir: &Path) -> Map<String, Value> {
  let mut out = Map::new();
  let Ok(rd) = std::fs::read_dir(dir) else { return out };
  let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
  names.sort();
  for f in names {
    let Some(name) = f.strip_suffix(".json") else { continue };
    if !valid_name(name) {
      continue;
    }
    if let Some(v) = std::fs::read_to_string(dir.join(&f)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
      out.insert(name.to_string(), v);
    }
  }
  out
}

#[tauri::command]
pub async fn store_load_all() -> CmdResult<Value> {
  blocking(|| Value::Object(load_all(&dir()))).await
}

#[tauri::command]
pub async fn store_save(name: String, data: Option<Value>) -> CmdResult<()> {
  let file = file_for(&name)?;
  match data {
    None | Some(Value::Null) => match tokio::fs::remove_file(&file).await {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(fsx::io_err(&e, "unlink", &file)),
    },
    Some(v) => {
      let d = dir();
      tokio::fs::create_dir_all(&d).await.map_err(|e| fsx::io_err(&e, "mkdir", &d))?;
      atomic::write(&file, atomic::json_pretty(&v)).await.map_err(|e| fsx::io_err(&e, "open", &file))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names() {
    for ok in ["pipelines", "db-console-history", "apiclient.saved", "a", "0x"] {
      assert!(valid_name(ok), "{ok}");
    }
    for bad in ["", "../x", "a/b", "A", "-a", ".a", "x y", "한글", &"a".repeat(65)] {
      assert!(!valid_name(bad), "{bad}");
    }
  }

  #[test]
  fn loads_every_file_that_parses() {
    let d = std::env::temp_dir().join(format!("riven-store-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("b.json"), "[1,2]").unwrap();
    std::fs::write(d.join("a.json"), "{\"k\": \"한글\"}").unwrap();
    std::fs::write(d.join("bad.json"), "{").unwrap();
    std::fs::write(d.join("Upper.json"), "1").unwrap();
    std::fs::write(d.join("x.json.riven-tmp"), "1").unwrap();
    let m = load_all(&d);
    assert_eq!(serde_json::to_string(&m).unwrap(), r#"{"a":{"k":"한글"},"b":[1,2]}"#);
    std::fs::remove_dir_all(&d).unwrap();
  }
}
