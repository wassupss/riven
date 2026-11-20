// Saved data sources (src/main/db/store.ts): userData/db/connections.json,
// the same file and shape the Node build wrote:
//   { version: 1, connections: [...], secrets: { id: base64 blob } }
// Passwords are sealed with Electron's safeStorage format and keychain item
// (services/safe_storage.rs: "v10" + AES-128-CBC), so a password either build
// saved opens in the other; ones the Tauri build sealed before ("rt1") still
// open. When no keychain text can be had, passwords live in memory for this
// run only and are never written in plain text.

use super::{Cfg, R};
use crate::services::paths;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};


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

// ---- sealing (Electron's safeStorage, services/safe_storage.rs) ----------------------

fn can_seal() -> bool {
  crate::services::safe_storage::available()
}

/// safeStorage.encryptString(password).toString('base64').
fn seal(password: &str) -> Option<String> {
  crate::services::safe_storage::encrypt_string(password).map(|b| base64::engine::general_purpose::STANDARD.encode(b))
}

/// safeStorage.decryptString(Buffer.from(blob, 'base64')); the old Tauri
/// seal (rt1) opens too.
fn open(blob: &str) -> Option<String> {
  let b = base64::engine::general_purpose::STANDARD.decode(blob).ok()?;
  crate::services::safe_storage::decrypt_string(&b)
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
