// Small file-system helpers shared by the services, shaped like the Node code
// they replace (error messages, path.resolve, Date.now().toString(36)).

use std::path::{Component, Path, PathBuf};

/// A Node-style error message ("ENOENT: no such file or directory, open '/x'"),
/// so the page sees the same text it saw from fs/promises.
pub fn io_err(e: &std::io::Error, syscall: &str, path: &Path) -> String {
  let (code, desc) = match e.raw_os_error() {
    Some(1) => ("EPERM", "operation not permitted"),
    Some(2) => ("ENOENT", "no such file or directory"),
    Some(13) => ("EACCES", "permission denied"),
    Some(17) => ("EEXIST", "file already exists"),
    Some(18) => ("EXDEV", "cross-device link not permitted"),
    Some(20) => ("ENOTDIR", "not a directory"),
    Some(21) => ("EISDIR", "illegal operation on a directory"),
    Some(22) => ("EINVAL", "invalid argument"),
    Some(66) => ("ENOTEMPTY", "directory not empty"),
    _ => return format!("{e}, {syscall} '{}'", path.display()),
  };
  format!("{code}: {desc}, {syscall} '{}'", path.display())
}

/// path.resolve(base, p): absolute, with `.` and `..` folded, no file-system access.
pub fn resolve(base: &Path, p: &Path) -> PathBuf {
  let joined = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
  let mut out = PathBuf::from("/");
  for c in joined.components() {
    match c {
      Component::ParentDir => {
        out.pop();
      }
      Component::Normal(s) => out.push(s),
      _ => {}
    }
  }
  out
}

pub fn now_ms() -> u128 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
}

pub fn base36(mut n: u128) -> String {
  const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
  if n == 0 {
    return "0".into();
  }
  let mut v = Vec::new();
  while n > 0 {
    v.push(D[(n % 36) as usize]);
    n /= 36;
  }
  v.reverse();
  String::from_utf8(v).unwrap()
}

/// Math.random().toString(36).slice(2, 8): six base-36 characters.
pub fn rand6() -> String {
  use std::hash::{BuildHasher, Hasher};
  let mut h = std::collections::hash_map::RandomState::new().build_hasher();
  h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
  let s = base36(h.finish() as u128);
  format!("{:0>6}", &s[s.len().saturating_sub(6)..])
}

/// fs.readFile(f, 'utf8'): invalid sequences become U+FFFD, as Buffer#toString does.
pub fn read_utf8(p: &Path) -> std::io::Result<String> {
  let bytes = std::fs::read(p)?;
  Ok(match String::from_utf8(bytes) {
    Ok(s) => s,
    Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
  })
}

/// Length in UTF-16 code units (what a JS string's length and indices count).
pub fn utf16_len(s: &str) -> usize {
  s.chars().map(char::len_utf16).sum()
}

/// s.slice(0, n) in UTF-16 units, never splitting a character.
pub fn utf16_prefix(s: &str, n: usize) -> &str {
  let mut units = 0;
  for (i, c) in s.char_indices() {
    if units + c.len_utf16() > n {
      return &s[..i];
    }
    units += c.len_utf16();
  }
  s
}

/// Reveal in Finder (shell.showItemInFolder).
pub fn reveal(p: &Path) {
  let _ = std::process::Command::new("/usr/bin/open").arg("-R").arg(p).spawn().map(|mut c| {
    std::thread::spawn(move || c.wait());
  });
}

/// fs.readdir: Node (libuv's scandir) answers entries sorted by name bytes,
/// and the walks' order (search results, the 2000/20000 caps) follows it.
pub fn read_dir_sorted(dir: &Path) -> std::io::Result<Vec<std::fs::DirEntry>> {
  let mut v: Vec<_> = std::fs::read_dir(dir)?.flatten().collect();
  v.sort_by_key(|e| e.file_name());
  Ok(v)
}
