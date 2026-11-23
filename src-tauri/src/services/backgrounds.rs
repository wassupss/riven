// The panel background image (Settings > appearance), src/main/backgrounds.ts
// in the Electron build.
//
// The page hands over the picked file's bytes as a data URL; they are copied to
// userData/backgrounds/bg-<16 hex of sha256>.<ext>, so the original can move or
// go away. The type comes from the bytes (magic numbers), never from the name
// or the data URL's label, and only raster formats are accepted: no SVG, which
// can carry script. One image is kept: importing a new one removes the others.
//
// page.rs serves it at /__riven/bg/<name>, and only a name of exactly that
// shape, read from that folder: no path, no "..", nothing else under userData.

use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// The largest image accepted (decoded bytes).
pub const MAX_BYTES: usize = 25 * 1024 * 1024;

pub fn dir() -> PathBuf {
  crate::services::paths::user_data().join("backgrounds")
}

/// The image type from the file's first bytes, as an extension.
pub fn sniff(b: &[u8]) -> Option<&'static str> {
  if b.starts_with(b"\x89PNG\r\n\x1a\n") {
    Some("png")
  } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
    Some("jpg")
  } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
    Some("gif")
  } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
    Some("webp")
  } else if b.len() >= 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") {
    Some("avif")
  } else if b.starts_with(b"BM") && b.len() > 26 {
    Some("bmp")
  } else {
    None
  }
}

/// bg-<16 lowercase hex>.<png|jpg|gif|webp|avif|bmp>, as `name_for` makes them.
/// The renderer's BG_NAME_RE (state/panelBackground.ts) is the same rule.
pub fn valid_name(name: &str) -> bool {
  let Some(rest) = name.strip_prefix("bg-") else { return false };
  let Some((hash, ext)) = rest.split_once('.') else { return false };
  hash.len() == 16
    && hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    && matches!(ext, "png" | "jpg" | "gif" | "webp" | "avif" | "bmp")
}

pub fn name_for(bytes: &[u8], ext: &str) -> String {
  let h = Sha256::digest(bytes);
  let hex: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
  format!("bg-{hex}.{ext}")
}

/// "data:<anything>;base64,<payload>" -> the decoded bytes.
pub fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
  use base64::Engine;
  let (head, b64) = data_url.split_once(',').ok_or("not a data URL")?;
  if !head.starts_with("data:") || !head.ends_with(";base64") {
    return Err("not a base64 data URL".into());
  }
  // A cheap bound before decoding: base64 is 4 chars per 3 bytes.
  if b64.len() / 4 * 3 > MAX_BYTES + 3 {
    return Err("image too large".into());
  }
  base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| e.to_string())
}

/// Copy the image in and return its name; every other background is removed.
pub fn import(data_url: &str) -> Result<String, String> {
  let bytes = decode_data_url(data_url)?;
  if bytes.len() > MAX_BYTES {
    return Err("image too large".into());
  }
  let ext = sniff(&bytes).ok_or("not a supported image (png, jpg, gif, webp, avif, bmp)")?;
  let name = name_for(&bytes, ext);
  let d = dir();
  std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
  let file = d.join(&name);
  if !file.is_file() {
    let tmp = d.join(format!("{name}.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
  }
  prune(Some(&name));
  Ok(name)
}

/// Remove every file in the folder except `keep`.
pub fn prune(keep: Option<&str>) {
  let Ok(rd) = std::fs::read_dir(dir()) else { return };
  for e in rd.flatten() {
    let n = e.file_name();
    if Some(n.to_string_lossy().as_ref()) == keep {
      continue;
    }
    if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
      let _ = std::fs::remove_file(e.path());
    }
  }
}

/// The file behind a served name, None for any other name.
pub fn file_for(name: &str) -> Option<PathBuf> {
  valid_name(name).then(|| dir().join(name))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sniffs_by_content() {
    assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
    assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
    assert_eq!(sniff(b"GIF89a...."), Some("gif"));
    assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
    assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0"), Some("avif"));
    assert_eq!(sniff(b"<svg xmlns='http://www.w3.org/2000/svg'>"), None);
    assert_eq!(sniff(b"<html>"), None);
    assert_eq!(sniff(b""), None);
  }

  #[test]
  fn names() {
    let n = name_for(b"abc", "png");
    assert!(valid_name(&n), "{n}");
    assert_eq!(n.len(), "bg-".len() + 16 + ".png".len());
    for bad in [
      "",
      "bg-0123456789abcdef.svg",
      "bg-0123456789ABCDEF.png",
      "bg-0123456789abcde.png",
      "../bg-0123456789abcdef.png",
      "bg-0123456789abcdef.png/..",
      "bg-0123456789abcdef.png.tmp",
      "settings.json",
    ] {
      assert!(!valid_name(bad), "{bad}");
      assert!(file_for(bad).is_none());
    }
    assert!(file_for("bg-0123456789abcdef.jpg").unwrap().ends_with("backgrounds/bg-0123456789abcdef.jpg"));
  }

  #[test]
  fn data_urls() {
    assert_eq!(decode_data_url("data:image/png;base64,aGk=").unwrap(), b"hi");
    assert!(decode_data_url("aGk=").is_err());
    assert!(decode_data_url("data:image/png,hi").is_err());
  }
}
