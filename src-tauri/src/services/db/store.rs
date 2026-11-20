// Saved data sources (src/main/db/store.ts): userData/db/connections.json,
// the same file and shape the Node build wrote:
//   { version: 1, connections: [...], secrets: { id: base64 blob } }
// Passwords are sealed the way the Tauri build's safeStorage did it
// (tauri/shim/electron-main.ts): 'rt1' + 12-byte IV + 16-byte tag + AES-256-GCM
// ciphertext, with a 32-byte key kept in the login keychain as the generic
// password "riven-tauri Safe Storage" (account "riven-tauri"). The key is read
// and created through /usr/bin/security exactly like the shim did, so the
// keychain item's access list (which names that tool) never prompts, and
// passwords saved by either build open in the other. When no key can be had,
// passwords live in memory for this run only and are never written in plain
// text.
//
// RIVEN_TAURI_KEYCHAIN (tests): a keychain file to use instead of the login
// keychain (the shim reads the same variable).

use super::{Cfg, R};
use crate::services::paths;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

const KEYCHAIN_SERVICE: &str = "riven-tauri Safe Storage";
const MAGIC: &[u8] = b"rt1";

struct Store {
  loaded: bool,
  connections: Vec<Map<String, Value>>,
  secrets: Map<String, Value>,
  session: HashMap<String, String>,
}

fn st() -> MutexGuard<'static, Store> {
  static S: OnceLock<Mutex<Store>> = OnceLock::new();
  let mut g = S
    .get_or_init(|| Mutex::new(Store { loaded: false, connections: vec![], secrets: Map::new(), session: HashMap::new() }))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  if !g.loaded {
    g.loaded = true;
    if let Some(raw) = std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
      g.connections = raw.get("connections").and_then(Value::as_array).map(|a| a.iter().filter_map(|c| c.as_object().cloned()).collect()).unwrap_or_default();
      g.secrets = raw.get("secrets").and_then(Value::as_object).cloned().unwrap_or_default();
    }
  }
  g
}

fn dir() -> PathBuf {
  paths::user_data().join("db")
}
fn file() -> PathBuf {
  dir().join("connections.json")
}

fn save(s: &Store) -> R<()> {
  use std::io::Write;
  use std::os::unix::fs::OpenOptionsExt;
  std::fs::create_dir_all(dir())?;
  let doc = json!({ "version": 1, "connections": s.connections, "secrets": s.secrets });
  let text = serde_json::to_string_pretty(&doc).unwrap_or_default();
  let tmp = dir().join("connections.json.tmp");
  let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
  f.write_all(text.as_bytes())?;
  drop(f);
  std::fs::rename(&tmp, file())?;
  Ok(())
}

// ---- keychain ------------------------------------------------------------------

fn security(args: &[&str]) -> Option<String> {
  let mut a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
  if let Ok(kc) = std::env::var("RIVEN_TAURI_KEYCHAIN") {
    if !kc.is_empty() {
      a.push(kc);
    }
  }
  let out = std::process::Command::new("/usr/bin/security")
    .args(&a)
    .stdin(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .output()
    .ok()?;
  out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn key() -> Option<[u8; 32]> {
  static KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);
  let mut g = KEY.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(k) = *g {
    return Some(k);
  }
  let b64 = match security(&["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]) {
    Some(s) => s.trim().to_string(),
    None => {
      let mut raw = [0u8; 32];
      std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut raw)).ok()?;
      let b = base64::engine::general_purpose::STANDARD.encode(raw);
      security(&["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "riven-tauri", "-w", &b, "-U"])?;
      b
    }
  };
  let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
  let k: [u8; 32] = bytes.try_into().ok()?;
  *g = Some(k);
  Some(k)
}

fn can_seal() -> bool {
  key().is_some()
}

fn seal(password: &str) -> Option<String> {
  let k = key()?;
  let mut iv = [0u8; 12];
  std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut iv)).ok()?;
  let c = Aes256Gcm::new_from_slice(&k).ok()?;
  let ct = c.encrypt(Nonce::from_slice(&iv), password.as_bytes()).ok()?;
  // aes-gcm gives ciphertext || tag; the stored order is tag first.
  let (body, tag) = ct.split_at(ct.len() - 16);
  let mut out = MAGIC.to_vec();
  out.extend_from_slice(&iv);
  out.extend_from_slice(tag);
  out.extend_from_slice(body);
  Some(base64::engine::general_purpose::STANDARD.encode(out))
}

fn open(blob: &str) -> Option<String> {
  let b = base64::engine::general_purpose::STANDARD.decode(blob).ok()?;
  if b.len() < 31 || &b[..3] != MAGIC {
    return None;
  }
  let k = key()?;
  let (iv, tag, body) = (&b[3..15], &b[15..31], &b[31..]);
  let mut ct = body.to_vec();
  ct.extend_from_slice(tag);
  let c = Aes256Gcm::new_from_slice(&k).ok()?;
  let plain = c.decrypt(Nonce::from_slice(iv), ct.as_ref()).ok()?;
  String::from_utf8(plain).ok()
}

// ---- API -------------------------------------------------------------------------

fn id_of(c: &Map<String, Value>) -> String {
  match c.get("id") {
    Some(Value::String(s)) => s.clone(),
    Some(Value::Null) | None => String::new(),
    Some(v) => super::js::string(v),
  }
}

fn info(s: &Store, c: &Map<String, Value>) -> Value {
  let id = id_of(c);
  let mut m = c.clone();
  m.insert("hasPassword".into(), Value::Bool(s.session.contains_key(&id) || s.secrets.contains_key(&id)));
  Value::Object(m)
}

pub fn list() -> Vec<Value> {
  let s = st();
  s.connections.iter().map(|c| info(&s, c)).collect()
}

/// The configs, for the MCP tools.
pub fn configs() -> Vec<Cfg> {
  st().connections.iter().map(|c| Cfg::from_value(&Value::Object(c.clone()))).collect()
}

pub fn get(id: &str) -> Option<Cfg> {
  st().connections.iter().find(|c| id_of(c) == id).map(|c| Cfg::from_value(&Value::Object(c.clone())))
}

pub fn password(id: &str) -> Option<String> {
  let blob = {
    let s = st();
    if let Some(p) = s.session.get(id) {
      return Some(p.clone());
    }
    s.secrets.get(id).and_then(Value::as_str).map(str::to_string)?
  };
  if !can_seal() {
    return None;
  }
  open(&blob)
}

/// Insert or update. password: Some(s) = set, Some("")/null = clear, None = keep.
pub fn save_connection(input: &Value, password: Option<Option<String>>) -> R<Value> {
  let mut c = input.as_object().cloned().unwrap_or_default();
  let has_id = c.get("id").is_some_and(|v| super::js::truthy(Some(v)));
  if !has_id {
    c.insert("id".into(), Value::String(crate::services::chat::util::uuid()));
  }
  let id = id_of(&c);
  // Sealing may run `security` (and create the key): not under the store lock.
  let sealed = match &password {
    Some(Some(p)) if !p.is_empty() => Some(seal(p)),
    _ => None,
  };
  let mut s = st();
  match s.connections.iter().position(|x| id_of(x) == id) {
    Some(i) => s.connections[i] = c.clone(),
    None => s.connections.push(c.clone()),
  }
  if let Some(pw) = password {
    s.session.remove(&id);
    s.secrets.shift_remove(&id);
    if let Some(p) = pw.filter(|p| !p.is_empty()) {
      match sealed.flatten() {
        Some(b) => {
          s.secrets.insert(id.clone(), Value::String(b));
        }
        None => {
          s.session.insert(id.clone(), p);
        }
      }
    }
  }
  save(&s)?;
  Ok(info(&s, &c))
}

pub fn delete_connection(id: &str) -> R<()> {
  let mut s = st();
  s.connections.retain(|c| id_of(c) != id);
  s.secrets.shift_remove(id);
  s.session.remove(id);
  save(&s)
}

/// id, then exact name (case-insensitive), then a unique substring of the name.
pub fn resolve(r: &str) -> R<Cfg> {
  let all = configs();
  if let Some(c) = all.iter().find(|c| c.id == r) {
    return Ok(c.clone());
  }
  let q = super::js::trim(r).to_lowercase();
  let exact: Vec<&Cfg> = all.iter().filter(|c| c.name.to_lowercase() == q).collect();
  if exact.len() == 1 {
    return Ok(exact[0].clone());
  }
  let sub: Vec<&Cfg> = all.iter().filter(|c| c.name.to_lowercase().contains(&q)).collect();
  if sub.len() == 1 {
    return Ok(sub[0].clone());
  }
  let names = all.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ");
  if exact.len() + sub.len() > 1 {
    let pick = if exact.is_empty() { &sub } else { &exact };
    return super::err(format!("Connection '{r}' is ambiguous. Matches: {}", pick.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")));
  }
  super::err(format!("No connection named '{r}'. Available: {}", if names.is_empty() { "(none)".into() } else { names }))
}
