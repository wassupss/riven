// String order for file names, close to JS `a.localeCompare(b)` (ICU root /
// en collation) without carrying ICU data: punctuation and symbols first (in
// the CLDR order), then digits, then letters case-insensitively. Ties are
// broken by accents (plain first), then case (lower first). Accented Latin-1
// letters sort with their base letter and full-width ASCII with its ASCII
// form; other non-ASCII letters keep code point order, except that Han goes
// after Hangul and kana as in the root order.

use std::cmp::Ordering;

// CLDR root order of the ASCII punctuation and symbols (non-ignorable).
const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

// Latin-1 letters with a diacritic -> base letter.
fn base_latin(c: char) -> Option<char> {
  let l = c.to_lowercase().next()?;
  Some(match l {
    'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
    'ç' => 'c',
    'è' | 'é' | 'ê' | 'ë' => 'e',
    'ì' | 'í' | 'î' | 'ï' => 'i',
    'ñ' => 'n',
    'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
    'ù' | 'ú' | 'û' | 'ü' => 'u',
    'ý' | 'ÿ' => 'y',
    _ => return None,
  })
}

// (primary class, primary weight, accented, tertiary)
fn key(c: char) -> (u8, u32, bool, u8) {
  // Full-width ASCII sorts as its ASCII form, between lower and upper case.
  let (c, wide) = match c as u32 {
    0xFF01..=0xFF5E => (char::from_u32(c as u32 - 0xFEE0).unwrap_or(c), true),
    _ => (c, false),
  };
  let tert = if c.is_uppercase() { 2 } else if wide { 1 } else { 0 };
  if c.is_whitespace() || c.is_control() {
    return (0, c as u32, false, tert);
  }
  if let Some(i) = PUNCT.find(c) {
    return (1, i as u32, false, tert);
  }
  if c.is_ascii_digit() {
    return (3, c as u32, false, tert);
  }
  if c.is_ascii_alphabetic() {
    return (4, c.to_ascii_lowercase() as u32, false, tert);
  }
  if c.is_ascii() {
    return (2, c as u32, false, tert); // any ASCII symbol not in the table
  }
  if let Some(b) = base_latin(c) {
    return (4, b as u32, true, tert);
  }
  let lower = c.to_lowercase().next().unwrap_or(c) as u32;
  if !c.is_alphanumeric() {
    return (2, lower, false, tert);
  }
  let han = matches!(lower, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FFFF);
  (if han { 6 } else { 5 }, lower, false, tert)
}

// macOS file names are often NFD (decomposed): a Hangul syllable may arrive as
// jamo and an accent as a combining mark. Compare both forms alike: syllables
// are split into their jamo, combining marks only mark the letter before them.
fn keys(s: &str) -> Vec<(u8, u32, bool, u8)> {
  let mut out: Vec<(u8, u32, bool, u8)> = Vec::with_capacity(s.len());
  for c in s.chars() {
    let u = c as u32;
    if (0xAC00..=0xD7A3).contains(&u) {
      let i = u - 0xAC00;
      out.push(key(char::from_u32(0x1100 + i / 588).unwrap()));
      out.push(key(char::from_u32(0x1161 + (i % 588) / 28).unwrap()));
      if i % 28 != 0 {
        out.push(key(char::from_u32(0x11A7 + i % 28).unwrap()));
      }
    } else if (0x300..=0x36F).contains(&u) {
      if let Some(last) = out.last_mut() {
        last.2 = true;
      }
    } else {
      out.push(key(c));
    }
  }
  out
}

pub fn locale_compare(a: &str, b: &str) -> Ordering {
  let ka = keys(a);
  let kb = keys(b);
  let o = ka.iter().map(|k| (k.0, k.1)).cmp(kb.iter().map(|k| (k.0, k.1)));
  if o != Ordering::Equal {
    return o;
  }
  let o = ka.iter().map(|k| k.2).cmp(kb.iter().map(|k| k.2));
  if o != Ordering::Equal {
    return o;
  }
  let o = ka.iter().map(|k| k.3).cmp(kb.iter().map(|k| k.3));
  if o != Ordering::Equal {
    return o;
  }
  a.cmp(b)
}

#[cfg(test)]
mod tests {
  use super::locale_compare;

  // Expected order from Node 22: `v.sort((a, b) => a.localeCompare(b))`, en-US.
  #[test]
  fn matches_node() {
    let want = [
      "_x", ".github", "~x", "$x", "1x", "a", "ａ", "A", "a b", "a_b", "a-b", "a.b", "a10", "a2", "B", "e", "é", "f",
      "README.md", "src", "Zed", "한글", "漢字",
    ];
    let mut v = want.to_vec();
    v.reverse();
    v.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(v, want);
  }

  // RIVEN_COLLATE_FILE=<file of names, one per line, in Node's order>
  #[test]
  fn matches_node_file() {
    let Ok(f) = std::env::var("RIVEN_COLLATE_FILE") else { return };
    let want: Vec<String> = std::fs::read_to_string(f).unwrap().lines().map(String::from).collect();
    let mut v = want.clone();
    v.sort();
    v.sort_by(|a, b| locale_compare(a, b));
    let bad: Vec<_> = v.iter().zip(&want).filter(|(a, b)| a != b).take(10).collect();
    assert!(bad.is_empty(), "{bad:?}");
  }
}
