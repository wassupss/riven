// remoteKey:available / load / save (src/main/remoteKey.ts): remote control's
// long-term key pair, sealed with the OS keystore, in userData/remote-key.bin.
//
// The seal is the one the Node shim's safeStorage made (tauri/shim/
// electron-main.ts), so a file written before this moved still opens:
// base64 of "rt1" | 12-byte IV | 16-byte GCM tag | AES-256-GCM ciphertext,
// with a 32-byte key kept in the login keychain under "riven-tauri Safe
// Storage" (made on first use). The file is written atomically, mode 0600.
//
// The background test mode (RIVEN_TAURI_BACKGROUND=1) never touches the
// keychain: sealing is reported unavailable there, as on a machine without one.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};

pub const KEYCHAIN_SERVICE: &str = "riven-tauri Safe Storage";
const MAGIC: &[u8] = b"rt1";

pub fn seal(key: &[u8; 32], plain: &str, iv: [u8; 12]) -> Vec<u8> {
  let c = Aes256Gcm::new(key.into());
  // aes-gcm appends the tag; the file keeps it before the body.
  let ct = c.encrypt(Nonce::from_slice(&iv), plain.as_bytes()).expect("aes-gcm");
  let (body, tag) = ct.split_at(ct.len() - 16);
  [MAGIC, &iv, tag, body].concat()
}

pub fn open(key: &[u8; 32], b: &[u8]) -> Result<String, String> {
  if b.len() < 31 || &b[..3] != MAGIC {
    return Err("safeStorage: unknown format".into());
  }
  let (iv, tag, body) = (&b[3..15], &b[15..31], &b[31..]);
  let c = Aes256Gcm::new(key.into());
  let pt = c.decrypt(Nonce::from_slice(iv), [body, tag].concat().as_slice()).map_err(|_| "safeStorage: cannot decrypt".to_string())?;
  String::from_utf8(pt).map_err(|e| e.to_string())
}

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

// The keychain key, read once (made the first time, as the shim did).
fn key() -> Option<[u8; 32]> {
  static K: OnceLock<Mutex<Option<[u8; 32]>>> = OnceLock::new();
  let cell = K.get_or_init(|| Mutex::new(None));
  let mut g = cell.lock().unwrap();
  if let Some(k) = *g {
    return Some(k);
  }
  if !cfg!(target_os = "macos") || crate::background() {
    return None;
  }
  let mut cmd = std::process::Command::new("/usr/bin/security");
  cmd.args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
  let found = super::limits::output_timeout(cmd, std::time::Duration::from_secs(10))
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
  let text = match found {
    Some(t) => t,
    None => {
      let mut raw = [0u8; 32];
      getrandom(&mut raw)?;
      let t = b64e(&raw);
      let mut add = std::process::Command::new("/usr/bin/security");
      add
        .args(["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "riven-tauri", "-w", &t, "-U"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
      super::limits::output_timeout(add, std::time::Duration::from_secs(10)).filter(|o| o.status.success())?;
      t
    }
  };
  let k: [u8; 32] = b64(&text).try_into().ok()?;
  *g = Some(k);
  Some(k)
}

fn getrandom(buf: &mut [u8]) -> Option<()> {
  use std::io::Read;
  std::fs::File::open("/dev/urandom").ok()?.read_exact(buf).ok()
}

pub fn available() -> bool {
  key().is_some()
}

pub fn load() -> Value {
  let Some(k) = key() else { return Value::Null };
  let Ok(raw) = std::fs::read_to_string(file()) else { return Value::Null };
  // Sealed by another user or machine (a copied profile): unusable here.
  open(&k, &b64(&raw)).ok().and_then(|t| desk_key(&t)).unwrap_or(Value::Null)
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
  let Some(key) = key() else { return Ok(false) };
  // JSON.stringify({ publicKey, secretKey }): a missing field is left out.
  let mut m = serde_json::Map::new();
  for f in ["publicKey", "secretKey"] {
    if let Some(v) = k.get(f) {
      m.insert(f.into(), v.clone());
    }
  }
  let text = Value::Object(m).to_string();
  let mut iv = [0u8; 12];
  getrandom(&mut iv).ok_or("no randomness")?;
  let sealed = b64e(&seal(&key, &text, iv));
  super::atomic::write_blocking(&file(), sealed.as_bytes()).map_err(|e| e.to_string())?;
  use std::os::unix::fs::PermissionsExt;
  let _ = std::fs::set_permissions(file(), std::fs::Permissions::from_mode(0o600));
  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn opens_what_the_node_shim_sealed() {
    // Node: aes-256-gcm, key 32 x 0x07, iv 12 x 0x03, {"publicKey":"pk","secretKey":"sk"}.
    let k = [7u8; 32];
    let node = b64("cnQxAwMDAwMDAwMDAwMDSSzJk8CLkefJFN8wsORiI17c03Y4RDchMSU6ftF1j2fPEMKc0fbmFVuV4sjB32LL2oUA");
    let text = open(&k, &node).unwrap();
    assert_eq!(desk_key(&text), Some(json!({ "publicKey": "pk", "secretKey": "sk" })));
    // And Rust seals byte for byte the same with the same IV.
    assert_eq!(seal(&k, r#"{"publicKey":"pk","secretKey":"sk"}"#, [3u8; 12]), node);
    assert!(open(&[8u8; 32], &node).is_err());
    assert!(open(&k, b"xx").is_err());
    assert_eq!(desk_key(r#"{"publicKey":1,"secretKey":"s"}"#), None);
  }
}
