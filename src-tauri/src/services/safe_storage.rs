// Electron's safeStorage, macOS flavour (Chromium OSCrypt), in Rust, so a
// secret either build sealed opens in the other: DB passwords
// (db/connections.json `secrets`) and the remote-control key
// (remote-key.bin).
//
// The format (Chromium components/os_crypt, os_crypt_mac):
//   "v10" | AES-128-CBC(PKCS#7) ciphertext
//   key = PBKDF2-HMAC-SHA1(password, salt "saltysalt", 1003 rounds, 16 bytes)
//   iv  = 16 spaces
// where `password` is the text of a generic password in the login keychain,
// made by whichever app needs it first (16 random bytes, base64). An empty
// text seals to nothing.
//
// The keychain item, by build (paths.rs):
//   released app (bundle id dev.riven.app): service "riven Safe Storage",
//     account "riven Key", the names Electron gives it (app name + " Safe
//     Storage" / + " Key", electron_browser_main_parts.cc). Read in process
//     through Security.framework, so the item's access list, which names the
//     app's signature (same Developer ID and bundle id for both builds), lets
//     the Tauri app in without a prompt.
//   every other build: service "riven-tauri Safe Storage", account
//     "riven-tauri", read and made through /usr/bin/security as before (that
//     item's access list names the tool, so it never prompts).
//
// Before this, the Tauri build sealed with its own scheme ("rt1" | 12-byte IV
// | 16-byte GCM tag | AES-256-GCM ciphertext, the item's text base64 of the
// 32-byte key). Those blobs still open; new ones are always v10.
//
// The background test mode (RIVEN_TAURI_BACKGROUND=1) never touches the
// keychain: sealing is unavailable there, as on a machine without one.
// RIVEN_TAURI_KEYCHAIN (debug builds and tests): a keychain file to use
// instead of the default search list.

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use base64::Engine;
use sha1::{Digest, Sha1};
use std::sync::Mutex;

pub const V10: &[u8] = b"v10";
const SALT: &[u8] = b"saltysalt";
const ROUNDS: u32 = 1003;
const IV: [u8; 16] = [b' '; 16];
const RT1: &[u8] = b"rt1";

pub const RELEASE_SERVICE: &str = "riven Safe Storage";
pub const RELEASE_ACCOUNT: &str = "riven Key";
pub const DEV_SERVICE: &str = "riven-tauri Safe Storage";
pub const DEV_ACCOUNT: &str = "riven-tauri";

// ---- the cipher --------------------------------------------------------------------

fn hmac_sha1(key: &[u8], msg: &[&[u8]]) -> [u8; 20] {
  let mut k = [0u8; 64];
  if key.len() > 64 {
    k[..20].copy_from_slice(&Sha1::digest(key));
  } else {
    k[..key.len()].copy_from_slice(key);
  }
  let mut inner = Sha1::new();
  inner.update(k.map(|b| b ^ 0x36));
  for m in msg {
    inner.update(m);
  }
  let mut outer = Sha1::new();
  outer.update(k.map(|b| b ^ 0x5c));
  outer.update(inner.finalize());
  outer.finalize().into()
}

/// PBKDF2-HMAC-SHA1(password, "saltysalt", 1003), first 16 bytes (one block).
pub fn derive_key(password: &[u8]) -> [u8; 16] {
  let mut u = hmac_sha1(password, &[SALT, &1u32.to_be_bytes()]);
  let mut t = u;
  for _ in 1..ROUNDS {
    u = hmac_sha1(password, &[&u]);
    for (a, b) in t.iter_mut().zip(u.iter()) {
      *a ^= b;
    }
  }
  let mut k = [0u8; 16];
  k.copy_from_slice(&t[..16]);
  k
}

/// "v10" + AES-128-CBC with PKCS#7 padding. Empty text, empty result (as Chromium).
pub fn encrypt_with(key: &[u8; 16], plain: &[u8]) -> Vec<u8> {
  if plain.is_empty() {
    return Vec::new();
  }
  let c = aes::Aes128::new(key.into());
  let pad = 16 - plain.len() % 16;
  let mut data = plain.to_vec();
  data.extend(std::iter::repeat_n(pad as u8, pad));
  let mut prev = IV;
  let mut out = V10.to_vec();
  for chunk in data.chunks(16) {
    let mut block = [0u8; 16];
    for i in 0..16 {
      block[i] = chunk[i] ^ prev[i];
    }
    let mut b = block.into();
    c.encrypt_block(&mut b);
    prev.copy_from_slice(&b);
    out.extend_from_slice(&b);
  }
  out
}

pub fn decrypt_with(key: &[u8; 16], blob: &[u8]) -> Option<Vec<u8>> {
  if blob.is_empty() {
    return Some(Vec::new());
  }
  let body = blob.strip_prefix(V10)?;
  if body.is_empty() || body.len() % 16 != 0 {
    return None;
  }
  let c = aes::Aes128::new(key.into());
  let mut prev = IV;
  let mut out = Vec::with_capacity(body.len());
  for chunk in body.chunks(16) {
    let mut b = aes::Block::clone_from_slice(chunk);
    c.decrypt_block(&mut b);
    for i in 0..16 {
      out.push(b[i] ^ prev[i]);
    }
    prev.copy_from_slice(chunk);
  }
  let pad = *out.last()? as usize;
  if pad == 0 || pad > 16 || pad > out.len() || !out[out.len() - pad..].iter().all(|&b| b as usize == pad) {
    return None;
  }
  out.truncate(out.len() - pad);
  Some(out)
}

/// The old Tauri seal: "rt1" | iv(12) | tag(16) | AES-256-GCM body.
pub fn open_rt1(key: &[u8; 32], b: &[u8]) -> Option<Vec<u8>> {
  use aes_gcm::aead::Aead;
  use aes_gcm::{Aes256Gcm, Nonce};
  if b.len() < 31 || &b[..3] != RT1 {
    return None;
  }
  let (iv, tag, body) = (&b[3..15], &b[15..31], &b[31..]);
  let c = <Aes256Gcm as aes_gcm::KeyInit>::new(key.into());
  c.decrypt(Nonce::from_slice(iv), [body, tag].concat().as_slice()).ok()
}

/// Open a blob with the keychain text `password`: v10 (Electron, and Tauri
/// from now on) or the old rt1.
pub fn open_with(password: &str, blob: &[u8]) -> Option<Vec<u8>> {
  if blob.starts_with(RT1) {
    let k: [u8; 32] = base64::engine::general_purpose::STANDARD.decode(password.trim()).ok()?.try_into().ok()?;
    return open_rt1(&k, blob);
  }
  decrypt_with(&derive_key(password.as_bytes()), blob)
}

// ---- the keychain item ------------------------------------------------------------------

pub struct Item {
  pub service: &'static str,
  pub account: &'static str,
  /// true: Security.framework in this process; false: /usr/bin/security.
  pub in_process: bool,
}

pub fn item() -> Item {
  item_for(super::paths::is_release())
}

pub fn item_for(release: bool) -> Item {
  if release {
    Item { service: RELEASE_SERVICE, account: RELEASE_ACCOUNT, in_process: true }
  } else {
    Item { service: DEV_SERVICE, account: DEV_ACCOUNT, in_process: false }
  }
}

/// The keychain file tests use instead of the search list (never in a release build).
fn test_keychain() -> Option<String> {
  if !cfg!(debug_assertions) {
    return None;
  }
  std::env::var("RIVEN_TAURI_KEYCHAIN").ok().filter(|s| !s.is_empty())
}

fn new_password() -> Option<String> {
  let mut raw = [0u8; 16];
  std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom").ok()?, &mut raw).ok()?;
  Some(base64::engine::general_purpose::STANDARD.encode(raw))
}

#[cfg(target_os = "macos")]
fn in_process(it: &Item, keychain: Option<&str>, create: bool) -> Option<String> {
  use security_framework::os::macos::keychain::SecKeychain;
  use security_framework::os::macos::passwords::find_generic_password;
  let kc = match keychain {
    Some(p) => Some(SecKeychain::open(p).ok()?),
    None => None,
  };
  let list = kc.as_ref().map(std::slice::from_ref);
  if let Ok((pw, _)) = find_generic_password(list, it.service, it.account) {
    return String::from_utf8(pw.to_vec()).ok();
  }
  if !create {
    return None;
  }
  let text = new_password()?;
  let target = match kc {
    Some(k) => k,
    None => SecKeychain::default().ok()?,
  };
  target.add_generic_password(it.service, it.account, text.as_bytes()).ok()?;
  Some(text)
}

#[cfg(not(target_os = "macos"))]
fn in_process(_: &Item, _: Option<&str>, _: bool) -> Option<String> {
  None
}

fn cli(it: &Item, keychain: Option<&str>, create: bool) -> Option<String> {
  let run = |args: &[&str]| -> Option<String> {
    let mut cmd = std::process::Command::new("/usr/bin/security");
    cmd.args(args);
    if let Some(k) = keychain {
      cmd.arg(k);
    }
    cmd.stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    super::limits::output_timeout(cmd, std::time::Duration::from_secs(10))
      .filter(|o| o.status.success())
      .map(|o| String::from_utf8_lossy(&o.stdout).trim_end_matches('\n').to_string())
  };
  // By service only, as the Tauri shim always looked it up.
  if let Some(t) = run(&["find-generic-password", "-s", it.service, "-w"]) {
    return Some(t);
  }
  if !create {
    return None;
  }
  let text = new_password()?;
  run(&["add-generic-password", "-s", it.service, "-a", it.account, "-w", &text, "-U"])?;
  Some(text)
}

/// The keychain text, read once (made the first time a secret is sealed).
fn password(create: bool) -> Option<String> {
  static PW: Mutex<Option<String>> = Mutex::new(None);
  let mut g = PW.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(p) = g.as_ref() {
    return Some(p.clone());
  }
  if !cfg!(target_os = "macos") || crate::background() {
    return None;
  }
  let it = item();
  let kc = test_keychain();
  let p = if it.in_process { in_process(&it, kc.as_deref(), create) } else { cli(&it, kc.as_deref(), create) }?;
  *g = Some(p.clone());
  Some(p)
}

// ---- API (safeStorage) ---------------------------------------------------------------

/// safeStorage.isEncryptionAvailable(): a keychain text can be had.
pub fn available() -> bool {
  password(true).is_some()
}

/// safeStorage.encryptString.
pub fn encrypt_string(plain: &str) -> Option<Vec<u8>> {
  Some(encrypt_with(&derive_key(password(true)?.as_bytes()), plain.as_bytes()))
}

/// safeStorage.decryptString (v10, or the old rt1).
pub fn decrypt_string(blob: &[u8]) -> Option<String> {
  String::from_utf8(open_with(&password(false)?, blob)?).ok()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
  }

  // Made by Electron 44.4.5's own safeStorage.encryptString, run with
  // Chromium's mock keychain (--use-mock-keychain, keychain text
  // "mock_password"), so the real keychain was never involved.
  const ELECTRON: [(&str, &str); 3] = [
    ("vector text 한글 \"1\"", "djEwu9Yu4kqxISpKDBtjrANfKVi9p9CEaveTg/rMjtT6Oqs="),
    ("", ""),
    (r#"{"publicKey":"pk","secretKey":"sk"}"#, "djEwAFHy9thhabZSyadBqNVjoBHbFGNutW1LLsoZZZNAw94R9yQ/0uNJTmloYC9Gx7Lp"),
  ];

  #[test]
  fn opens_and_makes_what_electron_makes() {
    let k = derive_key(b"mock_password");
    for (plain, blob) in ELECTRON {
      assert_eq!(open_with("mock_password", &b64(blob)).as_deref(), Some(plain.as_bytes()), "{plain}");
      // Fixed IV: the same text seals to the same bytes.
      assert_eq!(encrypt_with(&k, plain.as_bytes()), b64(blob), "{plain}");
    }
    assert_eq!(decrypt_with(&derive_key(b"other"), &b64(ELECTRON[0].1)), None);
    assert_eq!(decrypt_with(&k, b"v10short"), None);
    assert_eq!(decrypt_with(&k, b"xyz0123456789abcdef"), None);
  }

  #[test]
  fn pbkdf2_known_answer() {
    // RFC 6070 test vector 2 (2 rounds) checks the HMAC/PBKDF2 code path;
    // with 1003 rounds and "saltysalt" it is what Chromium derives.
    let mut u = hmac_sha1(b"password", &[b"salt", &1u32.to_be_bytes()]);
    let mut t = u;
    u = hmac_sha1(b"password", &[&u]);
    for (a, b) in t.iter_mut().zip(u.iter()) {
      *a ^= b;
    }
    let hex: String = t.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957");
  }

  #[test]
  fn still_opens_the_old_tauri_seal() {
    // The shim's rt1 seal: key 32 x 0x07, iv 12 x 0x03 (remote_key.rs had this vector).
    let key_text = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let node = b64("cnQxAwMDAwMDAwMDAwMDSSzJk8CLkefJFN8wsORiI17c03Y4RDchMSU6ftF1j2fPEMKc0fbmFVuV4sjB32LL2oUA");
    assert_eq!(open_with(&key_text, &node).as_deref(), Some(br#"{"publicKey":"pk","secretKey":"sk"}"#.as_slice()));
    assert_eq!(open_with(&base64::engine::general_purpose::STANDARD.encode([8u8; 32]), &node), None);
  }

  #[test]
  fn item_names() {
    let r = item_for(true);
    assert_eq!((r.service, r.account, r.in_process), ("riven Safe Storage", "riven Key", true));
    let d = item_for(false);
    assert_eq!((d.service, d.account, d.in_process), ("riven-tauri Safe Storage", "riven-tauri", false));
    // cargo test is never the release build.
    assert_eq!(item().service, DEV_SERVICE);
  }

  /// Both keychain paths against a scratch keychain file: a test run makes one
  /// with `security create-keychain` and sets RIVEN_TAURI_SCRATCH_KEYCHAIN to
  /// it. Never the login keychain: without the variable this does nothing.
  #[cfg(target_os = "macos")]
  #[test]
  fn scratch_keychain_round_trip() {
    use security_framework::os::macos::keychain::SecKeychain;
    let Ok(path) = std::env::var("RIVEN_TAURI_SCRATCH_KEYCHAIN") else { return };
    // Never a dialog: anything that would ask fails instead.
    let _no_ui = SecKeychain::disable_user_interaction().unwrap();

    // 1. An item Electron made (here the security tool, with an access list
    //    open to any app) is found under the release names, in process, and
    //    its text opens what Electron sealed with it.
    let rel = item_for(true);
    assert_eq!(in_process(&rel, Some(&path), false), None, "no item yet");
    let st = std::process::Command::new("/usr/bin/security")
      .args(["add-generic-password", "-s", rel.service, "-a", rel.account, "-w", "mock_password", "-A", &path])
      .status()
      .unwrap();
    assert!(st.success());
    let pw = in_process(&rel, Some(&path), false).unwrap();
    assert_eq!(open_with(&pw, &b64(ELECTRON[0].1)).as_deref(), Some(ELECTRON[0].0.as_bytes()));
    // The account matters: Electron's item is "<name> Key".
    let wrong = Item { service: rel.service, account: "riven", in_process: true };
    assert_eq!(in_process(&wrong, Some(&path), false), None);

    // 2. Made by us when missing (as Chromium does), in process and by the tool.
    let fresh = [
      Item { service: "riven-test Safe Storage", account: "riven-test Key", in_process: true },
      item_for(false),
    ];
    for it in &fresh {
      let get = |create| if it.in_process { in_process(it, Some(&path), create) } else { cli(it, Some(&path), create) };
      assert_eq!(get(false), None, "{}: no item yet", it.service);
      let made = get(true).expect("created");
      assert_eq!(made.len(), 24, "16 random bytes, base64");
      assert_eq!(get(false).as_deref(), Some(made.as_str()), "{}: read back", it.service);
      let sealed = encrypt_with(&derive_key(made.as_bytes()), b"db password");
      assert_eq!(open_with(&get(false).unwrap(), &sealed).as_deref(), Some(b"db password".as_slice()));
    }
  }
}
