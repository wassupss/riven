// Attachments for a CLI chat message.
//
// The interactive CLI takes them the way a terminal user gives them, which
// the live probe confirmed for 2.1.330:
// - an image: its file path as a bracketed paste of its own. The CLI turns
//   the paste into "[Image #N]" and sends the image itself (the transcript
//   keeps it inline as base64, plus a meta line naming the source path);
// - any other file: an @-mention in the text (@path, or @"path" with
//   spaces), which the CLI reads into the turn.
//
// A pasted image or a file dropped without a path on disk has no file to
// name, so it is written here first: <temp>/<app>-clichat/<pane>/. The
// folder goes when the pane closes or the app quits, and anything older
// than a day is swept at start (a crash leaves nothing behind for long).

use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_BYTES: usize = 20 * 1024 * 1024;
const SWEEP_AFTER: Duration = Duration::from_secs(24 * 3600);
pub const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

// Per app (a dev build and the release can run side by side).
fn root() -> PathBuf {
  std::env::temp_dir().join(format!("{}-clichat", safe(crate::services::paths::app_name(), 40)))
}

fn safe(s: &str, max: usize) -> String {
  let v: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).collect();
  let v = v.trim_start_matches('.').to_string();
  v.chars().take(max).collect()
}

pub fn dir_for(key: &str) -> PathBuf {
  root().join(safe(key, 80))
}

/// Whether the CLI will take this path as an image paste.
pub fn is_image(path: &str) -> bool {
  Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| IMAGE_EXT.contains(&e.to_ascii_lowercase().as_str()))
}

/// The bytes of a `data:<type>;base64,...` URL.
pub fn decode_data_url(url: &str) -> Option<Vec<u8>> {
  use base64::Engine;
  let (_, b64) = url.strip_prefix("data:")?.split_once(";base64,")?;
  let clean: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
  let e = base64::engine::general_purpose::STANDARD_NO_PAD;
  e.decode(clean.trim_end_matches('=')).ok()
}

/// A file name for the saved attachment: the original name made safe, with
/// a unique prefix so two pastes of "image.png" do not collide.
pub fn file_name(name: &str, url: &str) -> String {
  let mut n = safe(name, 60);
  if Path::new(&n).extension().is_none() {
    let ext = url
      .strip_prefix("data:image/")
      .and_then(|r| r.split([';', '+']).next())
      .map(|e| if e == "jpeg" { "jpg".to_string() } else { safe(e, 8) })
      .unwrap_or_else(|| "bin".into());
    n = format!("{}.{ext}", if n.is_empty() { "attachment" } else { &n });
  }
  format!("{}-{}-{n}", crate::services::fsx::base36(crate::services::fsx::now_ms()), crate::services::fsx::rand6())
}

pub fn save(key: &str, name: &str, data_url: &str) -> Result<String, String> {
  let bytes = decode_data_url(data_url).ok_or("not a data URL")?;
  if bytes.is_empty() || bytes.len() > MAX_BYTES {
    return Err("attachment is empty or too large".into());
  }
  let dir = dir_for(key);
  use std::os::unix::fs::DirBuilderExt;
  std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| e.to_string())?;
  let file = dir.join(file_name(name, data_url));
  std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
  Ok(file.to_string_lossy().into_owned())
}

pub fn clear(key: &str) {
  let _ = std::fs::remove_dir_all(dir_for(key));
}

/// Start of a run: folders a crash or a kill left behind.
pub fn sweep() {
  let Ok(rd) = std::fs::read_dir(root()) else { return };
  for e in rd.flatten() {
    let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > SWEEP_AFTER);
    if old {
      let _ = std::fs::remove_dir_all(e.path());
    }
  }
}

/// Image `index` of the user record `uuid` in a transcript, as a data URL
/// (the thumbnail in the user bubble; read on demand, never kept in the
/// item list, so a long chat full of screenshots costs nothing until drawn).
pub fn image_in_transcript(path: &Path, uuid: &str, index: usize) -> Option<String> {
  use std::io::BufRead;
  let needle = format!("\"uuid\":\"{uuid}\"");
  let f = std::fs::File::open(path).ok()?;
  for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
    if !line.contains(&needle) {
      continue;
    }
    let v: serde_json::Value = serde_json::from_str(&line).ok()?;
    let img = v.pointer("/message/content")?.as_array()?.iter().filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("image")).nth(index)?;
    let src = img.get("source")?;
    let media = src.get("media_type").and_then(|m| m.as_str()).unwrap_or("image/png");
    let data = src.get("data").and_then(|d| d.as_str())?;
    return Some(format!("data:{media};base64,{data}"));
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_and_decoding() {
    assert!(is_image("/a/red square.PNG") && is_image("x.webp") && !is_image("notes.txt") && !is_image("png"));
    assert_eq!(decode_data_url("data:image/png;base64,aGk="), Some(b"hi".to_vec()));
    assert_eq!(decode_data_url("data:text/plain;base64,aGk"), Some(b"hi".to_vec()));
    assert_eq!(decode_data_url("hi"), None);
    let n = file_name("../../etc/pass wd", "data:image/png;base64,");
    assert!(n.contains("etc_pass_wd") && !n.contains('/') && !n.starts_with('.'), "{n}");
    assert!(file_name("", "data:image/jpeg;base64,").ends_with("-attachment.jpg"));
    assert!(file_name("shot.png", "data:image/png;base64,").ends_with("-shot.png"));
    assert_eq!(dir_for("clichat-1/x").file_name().unwrap(), "clichat-1_x");
  }

  #[test]
  fn image_from_a_transcript_line() {
    let dir = std::env::temp_dir().join(format!("riven-attach-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("t.jsonl");
    std::fs::write(
      &p,
      concat!(
        r#"{"type":"user","uuid":"u0","message":{"content":"x"}}"#,
        "\n",
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"What color?[Image #1]"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]},"uuid":"u1"}"#,
        "\n"
      ),
    )
    .unwrap();
    assert_eq!(image_in_transcript(&p, "u1", 0).as_deref(), Some("data:image/png;base64,AAAA"));
    assert_eq!(image_in_transcript(&p, "u1", 1), None);
    assert_eq!(image_in_transcript(&p, "u0", 0), None);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
