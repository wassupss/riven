// remoteKey:available / load / save (src/main/remoteKey.ts): remote control's
// long-term key pair, sealed with the OS keystore, in userData/remote-key.bin.
//
// Sealed as Electron's safeStorage seals (services/safe_storage.rs: "v10" +
// AES-128-CBC, the same keychain item), so the file either build wrote opens
// in the other; one the Tauri build sealed before ("rt1") still opens. The
// file is written atomically, mode 0600.
//
// The background test mode (RIVEN_TAURI_BACKGROUND=1) never touches the
// keychain: sealing is reported unavailable there, as on a machine without one.

use super::safe_storage;
use serde_json::{json, Value};

/// The key pair if the text is {publicKey: string, secretKey: string}.
pub fn desk_key(text: &str) -> Option<Value> {
  let v: Value = serde_json::from_str(text).ok()?;
  let (p, s) = (v.get("publicKey")?.as_str()?, v.get("secretKey")?.as_str()?);
  Some(json!({ "publicKey": p, "secretKey": s }))
}

fn file() -> std::path::PathBuf {
  super::paths::user_file("remote-key.bin")
}

fn b64(s: &str) -> Vec<u8> {
  use base64::Engine;
  base64::engine::general_purpose::STANDARD.decode(s.trim()).unwrap_or_default()
}

fn b64e(b: &[u8]) -> String {
  use base64::Engine;
  base64::engine::general_purpose::STANDARD.encode(b)
}

pub fn available() -> bool {
  safe_storage::available()
}

pub fn load() -> Value {
  if !available() {
    return Value::Null;
  }
  let Ok(raw) = std::fs::read_to_string(file()) else { return Value::Null };
  // Sealed by another user or machine (a copied profile): unusable here.
  safe_storage::decrypt_string(&b64(&raw)).and_then(|t| desk_key(&t)).unwrap_or(Value::Null)
}

pub fn save(k: &Value) -> Result<bool, String> {
  if k.is_null() {
    match std::fs::remove_file(file()) {
      Ok(()) => {}
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
      Err(e) => return Err(e.to_string()),
    }
    return Ok(true);
  }
  if !available() {
    return Ok(false);
  }
  // JSON.stringify({ publicKey, secretKey }): a missing field is left out.
  let mut m = serde_json::Map::new();
  for f in ["publicKey", "secretKey"] {
    if let Some(v) = k.get(f) {
      m.insert(f.into(), v.clone());
    }
  }
  let text = Value::Object(m).to_string();
  let sealed = b64e(&safe_storage::encrypt_string(&text).ok_or("safeStorage: no keychain")?);
  super::atomic::write_blocking(&file(), sealed.as_bytes()).map_err(|e| e.to_string())?;
  use std::os::unix::fs::PermissionsExt;
  let _ = std::fs::set_permissions(file(), std::fs::Permissions::from_mode(0o600));
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn desk_key_shape() {
    assert_eq!(desk_key(r#"{"publicKey":"pk","secretKey":"sk","x":1}"#), Some(json!({ "publicKey": "pk", "secretKey": "sk" })));
    assert_eq!(desk_key(r#"{"publicKey":1,"secretKey":"s"}"#), None);
    assert_eq!(desk_key("nope"), None);
  }
}
