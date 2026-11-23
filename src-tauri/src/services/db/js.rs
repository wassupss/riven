// JS semantics the DB modules lean on: Number -> string, String(v) of a cell,
// Number(text), UTF-16 lengths and slices, and node-pg's prepareValue.

use serde_json::Value;

/// Number.prototype.toString().
pub fn num_str(f: f64) -> String {
  let mut b = ryu_js::Buffer::new();
  b.format(f).to_string()
}

/// JS `Number(s)` for the texts a server prints (trimmed; '' is 0).
pub fn number(s: &str) -> f64 {
  let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
  if t.is_empty() {
    return 0.0;
  }
  match t {
    "Infinity" | "+Infinity" => return f64::INFINITY,
    "-Infinity" => return f64::NEG_INFINITY,
    _ => {}
  }
  // Rust also takes "inf", "nan", "infinity" in any case; JS does not.
  let lower = t.to_ascii_lowercase();
  if lower.contains("inf") || lower.contains("nan") {
    return f64::NAN;
  }
  if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
    return u64::from_str_radix(h, 16).map(|v| v as f64).unwrap_or(f64::NAN);
  }
  t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(v)` of a JSON value (arrays joined with ',', objects as [object Object]).
pub fn string(v: &Value) -> String {
  match v {
    Value::Null => "null".into(),
    Value::Bool(b) => b.to_string(),
    Value::Number(n) => num_str(n.as_f64().unwrap_or(0.0)),
    Value::String(s) => s.clone(),
    Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { string(x) }).collect::<Vec<_>>().join(","),
    Value::Object(_) => "[object Object]".into(),
  }
}

/// JS truthiness.
pub fn truthy(v: Option<&Value>) -> bool {
  crate::services::util::truthy(v)
}

pub fn utf16_len(s: &str) -> usize {
  s.encode_utf16().count()
}

/// s.slice(0, n) in UTF-16 units (a split surrogate pair is dropped).
pub fn utf16_slice(s: &str, n: usize) -> String {
  let mut out = String::new();
  let mut k = 0;
  for c in s.chars() {
    let w = c.len_utf16();
    if k + w > n {
      break;
    }
    out.push(c);
    k += w;
  }
  out
}

/// String.prototype.trim.
pub fn trim(s: &str) -> &str {
  s.trim_matches(js_space)
}

pub fn js_space(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
  )
}

/// node-pg utils.prepareValue for JSON-shaped values: the text a parameter
/// is sent as (None = SQL NULL).
pub fn pg_param(v: &Value) -> Option<String> {
  match v {
    Value::Null => None,
    Value::Bool(b) => Some(b.to_string()),
    Value::Number(n) => Some(num_str(n.as_f64().unwrap_or(0.0))),
    Value::String(s) => Some(s.clone()),
    Value::Array(a) => Some(pg_array(a)),
    Value::Object(_) => Some(serde_json::to_string(v).unwrap_or_default()),
  }
}

fn pg_array(a: &[Value]) -> String {
  let mut out = String::from("{");
  for (i, item) in a.iter().enumerate() {
    if i > 0 {
      out.push(',');
    }
    match item {
      Value::Null => out.push_str("NULL"),
      Value::Array(x) => out.push_str(&pg_array(x)),
      other => {
        let s = pg_param(other).unwrap_or_default();
        out.push('"');
        out.push_str(&s.replace('\\', "\\\\").replace('"', "\\\""));
        out.push('"');
      }
    }
  }
  out.push('}');
  out
}

/// Date.now()
pub fn now_ms() -> f64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn numbers_print_like_js() {
    assert_eq!(num_str(1.0), "1");
    assert_eq!(num_str(1.5e-5), "0.000015");
    assert_eq!(num_str(1e21), "1e+21");
    assert_eq!(num_str(-0.0), "0");
    assert_eq!(num_str(f64::NAN), "NaN");
    assert_eq!(num_str(f64::INFINITY), "Infinity");
    assert_eq!(pg_param(&serde_json::json!(["a\"b", null, 1])).unwrap(), "{\"a\\\"b\",NULL,\"1\"}");
  }
}

/// Number.parseFloat: the longest leading decimal literal (or Infinity).
pub fn parse_float(s: &str) -> f64 {
  let t = s.trim_start_matches(js_space);
  let b = t.as_bytes();
  let mut i = 0;
  if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
    i += 1;
  }
  if t[i..].starts_with("Infinity") {
    return if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
  }
  let digits = |i: &mut usize| {
    let s = *i;
    while *i < b.len() && b[*i].is_ascii_digit() {
      *i += 1;
    }
    *i > s
  };
  let int = digits(&mut i);
  let mut frac = false;
  if i < b.len() && b[i] == b'.' {
    let save = i;
    i += 1;
    frac = digits(&mut i);
    if !int && !frac {
      i = save;
    }
  }
  if !int && !frac {
    return f64::NAN;
  }
  if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
    let save = i;
    i += 1;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
      i += 1;
    }
    if !digits(&mut i) {
      i = save;
    }
  }
  t[..i].parse().unwrap_or(f64::NAN)
}
