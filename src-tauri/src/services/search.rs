// Find (and replace) in files (src/main/search.ts). Walks the workspace
// skipping a few heavy directories, binary files (a NUL byte) and files over
// 1MB, and caps the results. Columns and offsets are in UTF-16 units, as the
// editor (and the JS version) count them.
//
// The pattern is a Rust regex. JS-only syntax (lookaround, backreferences)
// does not compile and, like an invalid pattern before, finds nothing.

use super::fsx::{read_utf8, utf16_len, utf16_prefix};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "out", "dist", ".cache", ".riven"];
const MAX_FILE_BYTES: u64 = 1_000_000;
const MAX_RESULTS: usize = 600;
const MAX_PER_FILE: usize = 50;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOpts {
  pub root: String,
  pub query: String,
  pub replacement: String,
  pub regex: bool,
  pub whole_word: bool,
  pub case_sensitive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
  pub file: String,
  pub line: usize,
  pub column: usize,
  pub text: String,
  pub match_start: usize,
  pub match_length: usize,
}

#[derive(Serialize)]
pub struct SearchResult {
  pub matches: Vec<SearchMatch>,
  pub truncated: bool,
}

#[derive(Serialize)]
pub struct ReplaceResult {
  pub files: usize,
  pub replacements: usize,
}

fn matcher(o: &SearchOpts) -> Option<Regex> {
  let mut src = if o.regex { o.query.clone() } else { regex::escape(&o.query) };
  if o.whole_word {
    // JS \b is ASCII-word based.
    src = format!(r"(?-u:\b)(?:{src})(?-u:\b)");
  }
  RegexBuilder::new(&src).case_insensitive(!o.case_sensitive).build().ok()
}

// Depth-first in directory order, like the async generator it replaces.
fn walk(dir: &Path, f: &mut dyn FnMut(PathBuf) -> bool) -> bool {
  let Ok(rd) = super::fsx::read_dir_sorted(dir) else { return true };
  for e in rd {
    let name = e.file_name();
    let n = name.to_string_lossy();
    if n == ".DS_Store" || IGNORED_DIRS.contains(&n.as_ref()) {
      continue;
    }
    let Ok(ft) = e.file_type() else { continue };
    let full = dir.join(&name);
    if ft.is_dir() {
      if !walk(&full, f) {
        return false;
      }
    } else if ft.is_file() && !f(full) {
      return false;
    }
  }
  true
}

fn text_of(file: &Path) -> Option<String> {
  if std::fs::metadata(file).ok()?.len() > MAX_FILE_BYTES {
    return None;
  }
  let content = read_utf8(file).ok()?;
  (!content.contains('\0')).then_some(content)
}

pub fn in_files(o: &SearchOpts) -> SearchResult {
  let mut matches = Vec::new();
  if o.query.is_empty() {
    return SearchResult { matches, truncated: false };
  }
  let Some(re) = matcher(o) else { return SearchResult { matches, truncated: false } };
  let mut truncated = false;
  walk(Path::new(&o.root), &mut |file| {
    if matches.len() >= MAX_RESULTS {
      truncated = true;
      return false;
    }
    let Some(content) = text_of(&file) else { return true };
    let mut per_file = 0;
    for (i, line) in content.split('\n').enumerate() {
      if per_file >= MAX_PER_FILE {
        break;
      }
      // First match on the line; an empty-width one counts as none.
      let Some(m) = re.find(line) else { continue };
      if m.is_empty() {
        continue;
      }
      let start = utf16_len(&line[..m.start()]);
      let text = if utf16_len(line) > 240 { utf16_prefix(line, 240) } else { line };
      matches.push(SearchMatch {
        file: file.to_string_lossy().into_owned(),
        line: i + 1,
        column: start + 1,
        text: text.to_string(),
        match_start: start,
        match_length: utf16_len(m.as_str()),
      });
      per_file += 1;
      if matches.len() >= MAX_RESULTS {
        truncated = true;
        return false;
      }
    }
    true
  });
  SearchResult { matches, truncated }
}

// A JS replacement string ($&, $1, $<name>, $$) in the regex crate's syntax.
fn js_replacement(r: &str) -> String {
  let mut out = String::new();
  let cs: Vec<char> = r.chars().collect();
  let mut i = 0;
  while i < cs.len() {
    if cs[i] != '$' || i + 1 >= cs.len() {
      if cs[i] == '$' {
        out.push_str("$$");
      } else {
        out.push(cs[i]);
      }
      i += 1;
      continue;
    }
    let n = cs[i + 1];
    if n == '$' {
      out.push_str("$$");
      i += 2;
    } else if n == '&' {
      out.push_str("${0}");
      i += 2;
    } else if n.is_ascii_digit() {
      let mut j = i + 1;
      while j < cs.len() && j < i + 3 && cs[j].is_ascii_digit() {
        j += 1;
      }
      out.push_str(&format!("${{{}}}", cs[i + 1..j].iter().collect::<String>()));
      i = j;
    } else if n == '<' {
      match cs[i + 2..].iter().position(|&c| c == '>') {
        Some(k) => {
          out.push_str(&format!("${{{}}}", cs[i + 2..i + 2 + k].iter().collect::<String>()));
          i += 3 + k;
        }
        None => {
          out.push_str("$$");
          i += 1;
        }
      }
    } else {
      out.push_str("$$");
      i += 1;
    }
  }
  out
}

pub async fn replace_in_files(o: SearchOpts) -> ReplaceResult {
  let none = ReplaceResult { files: 0, replacements: 0 };
  if o.query.is_empty() {
    return none;
  }
  let Some(re) = matcher(&o) else { return none };
  // Literal mode: the replacement is plain text. Regex mode: $1 etc. work.
  let repl = if o.regex { js_replacement(&o.replacement) } else { o.replacement.replace('$', "$$") };
  let root = o.root.clone();
  tokio::task::spawn_blocking(move || {
    let (mut files, mut replacements) = (0, 0);
    walk(Path::new(&root), &mut |file| {
      let Some(content) = text_of(&file) else { return true };
      let count = re.find_iter(&content).count();
      if count > 0 {
        let next = re.replace_all(&content, repl.as_str());
        // Skip files that cannot be written.
        if super::atomic::write_blocking(&file, next.as_bytes()).is_ok() {
          files += 1;
          replacements += count;
        }
      }
      true
    });
    ReplaceResult { files, replacements }
  })
  .await
  .unwrap_or(ReplaceResult { files: 0, replacements: 0 })
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn replacement_syntax() {
    assert_eq!(js_replacement("$1a-$&-$$-$<x>-$"), "${1}a-${0}-$$-${x}-$$");
  }
  #[test]
  fn word_and_case() {
    let o = SearchOpts { query: "foo".into(), whole_word: true, ..Default::default() };
    let re = matcher(&o).unwrap();
    assert!(re.is_match("a FOO b"));
    assert!(!re.is_match("foobar"));
    assert!(re.is_match("한foo")); // JS \b: 한 is not a word character
  }
}
