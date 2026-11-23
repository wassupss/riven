// Local agent usage (src/main/usage.ts): today's Claude Code tokens and cost
// from the CLI's own session logs, and Codex's tokens and plan windows from
// its rollouts. Files only: no network, no keychain.
//
//   usage:today [configDir]   ~/.claude/projects/**/*.jsonl, today's usage
//                             lines, deduped by message id | request id,
//                             priced at API rates (or the line's costUSD)
//   usage:codex               ~/.codex/sessions/<today and yesterday>
//
// usage:limits (the plan windows from Anthropic's OAuth usage endpoint) still
// runs in Node: it reads Claude Code's token from the keychain.
//
// Numbers are summed as f64 in the same order as the Node module, so totals
// match it to the last digit. Days are local days, as JS Date's.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// ---- JS Date, the parts used here ---------------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
  let y = if m <= 2 { y - 1 } else { y };
  let era = if y >= 0 { y } else { y - 399 } / 400;
  let yoe = y - era * 400;
  let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
  let z = z + 719468;
  let era = if z >= 0 { z } else { z - 146096 } / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Date.parse for the ISO forms the logs use. Date-only and Z/offset forms
/// are UTC; a date-time without an offset is local time (as in JS). NaN when
/// it is not one of those.
pub fn parse_iso(s: &str) -> f64 {
  let b = s.as_bytes();
  let num = |i: usize, n: usize| -> Option<i64> {
    let t = s.get(i..i + n)?;
    t.bytes().all(|c| c.is_ascii_digit()).then(|| t.parse().ok()).flatten()
  };
  let (Some(y), Some(mo), Some(d)) = (num(0, 4), num(5, 2), num(8, 2)) else { return f64::NAN };
  if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
    return f64::NAN;
  }
  let day = days_from_civil(y, mo, d) as f64 * 86_400_000.0;
  if b.len() == 10 {
    return day;
  }
  if b.get(10) != Some(&b'T') {
    return f64::NAN;
  }
  let (Some(h), Some(mi)) = (num(11, 2), num(14, 2)) else { return f64::NAN };
  if b.get(13) != Some(&b':') || h > 24 || mi > 59 {
    return f64::NAN;
  }
  let mut i = 16;
  let mut sec = 0i64;
  let mut ms = 0f64;
  if b.get(i) == Some(&b':') {
    let Some(sv) = num(i + 1, 2) else { return f64::NAN };
    if sv > 59 {
      return f64::NAN;
    }
    sec = sv;
    i += 3;
    if b.get(i) == Some(&b'.') {
      let start = i + 1;
      let mut j = start;
      while b.get(j).is_some_and(u8::is_ascii_digit) {
        j += 1;
      }
      if j == start {
        return f64::NAN;
      }
      // JS keeps milliseconds (the first three digits)
      let frac = &s[start..j.min(start + 3)];
      ms = frac.parse::<f64>().unwrap_or(0.0) * 10f64.powi(3 - frac.len() as i32);
      i = j;
    }
  }
  let clock = ((h * 60 + mi) * 60 + sec) as f64 * 1000.0 + ms;
  match &s[i..] {
    "" => {
      // local time
      let mut tm: libc::tm = unsafe { std::mem::zeroed() };
      tm.tm_year = (y - 1900) as i32;
      tm.tm_mon = (mo - 1) as i32;
      tm.tm_mday = d as i32;
      tm.tm_hour = h as i32;
      tm.tm_min = mi as i32;
      tm.tm_sec = sec as i32;
      tm.tm_isdst = -1;
      let t = unsafe { libc::mktime(&mut tm) };
      t as f64 * 1000.0 + ms
    }
    "Z" => day + clock,
    off => {
      let ob = off.as_bytes();
      let sign = match ob.first() {
        Some(b'+') => 1.0,
        Some(b'-') => -1.0,
        _ => return f64::NAN,
      };
      let (oh, om) = match (off.get(1..3).and_then(|x| x.parse::<i64>().ok()), off.get(3..)) {
        (Some(oh), Some(rest)) => {
          let rest = rest.strip_prefix(':').unwrap_or(rest);
          match rest.parse::<i64>() {
            Ok(om) if rest.len() == 2 => (oh, om),
            _ => return f64::NAN,
          }
        }
        _ => return f64::NAN,
      };
      day + clock - sign * ((oh * 60 + om) as f64) * 60_000.0
    }
  }
}

fn local_ymd(ms: f64) -> (i64, i64, i64) {
  let t = (ms / 1000.0).floor() as libc::time_t;
  let mut tm: libc::tm = unsafe { std::mem::zeroed() };
  unsafe { libc::localtime_r(&t, &mut tm) };
  (tm.tm_year as i64 + 1900, tm.tm_mon as i64 + 1, tm.tm_mday as i64)
}

fn day_key(ms: f64) -> String {
  let (y, m, d) = local_ymd(ms);
  format!("{y}-{m:02}-{d:02}")
}

fn today_key() -> String {
  day_key(crate::services::util::now_ms())
}

fn local_day_key(iso: &str) -> String {
  let t = parse_iso(iso);
  if t.is_nan() {
    String::new()
  } else {
    day_key(t)
  }
}

/// Date.prototype.toISOString
fn iso(ms: f64) -> String {
  let ms = ms.trunc() as i64;
  let days = ms.div_euclid(86_400_000);
  let rem = ms.rem_euclid(86_400_000);
  let (y, m, d) = civil_from_days(days);
  format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// A JS number as JSON (integers without ".0").
fn jsnum(f: f64) -> Value {
  if f.fract() == 0.0 && f.abs() < 9.0e15 {
    json!(f as i64)
  } else {
    json!(f)
  }
}

/// `v ?? 0` for a JSON number field.
fn n0(o: Option<&Value>, k: &str) -> f64 {
  o.and_then(|o| o.get(k)).and_then(Value::as_f64).unwrap_or(0.0)
}

// ---- files ---------------------------------------------------------------------------------

fn walk_jsonl(dir: &Path, out: &mut Vec<PathBuf>, cap: usize) {
  if out.len() >= cap {
    return;
  }
  let Ok(entries) = crate::services::fsx::read_dir_sorted(dir) else { return };
  for e in entries {
    if out.len() >= cap {
      return;
    }
    let full = dir.join(e.file_name());
    let Ok(ft) = e.file_type() else { continue };
    if ft.is_dir() {
      walk_jsonl(&full, out, cap);
    } else if ft.is_file() && e.file_name().to_string_lossy().ends_with(".jsonl") {
      out.push(full);
    }
  }
}

fn home() -> PathBuf {
  PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn claude_roots(config_dir: Option<&str>) -> Vec<PathBuf> {
  if let Some(d) = config_dir {
    return vec![Path::new(d).join("projects")];
  }
  let mut roots = Vec::new();
  if let Ok(cfg) = std::env::var("CLAUDE_CONFIG_DIR") {
    if !cfg.is_empty() {
      roots.extend(cfg.split(',').map(|d| Path::new(d.trim()).join("projects")));
    }
  }
  if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
    if !x.is_empty() {
      roots.push(Path::new(&x).join("claude").join("projects"));
    }
  }
  roots.push(home().join(".claude").join("projects"));
  let mut seen = Vec::new();
  roots.retain(|r| {
    if seen.contains(r) {
      false
    } else {
      seen.push(r.clone());
      true
    }
  });
  roots
}

// ---- usage:today ---------------------------------------------------------------------------

#[derive(Clone)]
struct Entry {
  key: String,
  model: String,
  input: f64,
  output: f64,
  cache_write: f64,
  cache_read: f64,
  cost: f64,
}

fn rate(model: &str) -> (f64, f64, f64, f64) {
  let m = model.to_lowercase();
  if m.contains("opus") {
    (15.0, 75.0, 18.75, 1.5)
  } else if m.contains("haiku") {
    (0.8, 4.0, 1.0, 0.08)
  } else {
    (3.0, 15.0, 3.75, 0.3)
  }
}

fn entry_of(line: &str, today: &str) -> Option<Entry> {
  if !line.contains("\"usage\"") {
    return None;
  }
  let obj: Value = serde_json::from_str(line).ok()?;
  let ts = obj.get("timestamp").and_then(Value::as_str).unwrap_or("");
  if local_day_key(ts) != today {
    return None;
  }
  let msg = obj.get("message");
  let usage = msg.and_then(|m| m.get("usage")).filter(|u| !u.is_null())?;
  let id = msg.and_then(|m| m.get("id")).and_then(Value::as_str).unwrap_or("");
  let req = obj.get("requestId").and_then(Value::as_str).unwrap_or("");
  let model = msg.and_then(|m| m.get("model")).and_then(Value::as_str).unwrap_or("claude").to_string();
  let cc = usage.get("cache_creation").filter(|c| c.is_object());
  let ccit = n0(Some(usage), "cache_creation_input_tokens");
  let cache_write = if ccit != 0.0 && !ccit.is_nan() {
    ccit
  } else if cc.is_some() {
    n0(cc, "ephemeral_5m_input_tokens") + n0(cc, "ephemeral_1h_input_tokens")
  } else {
    0.0
  };
  let input = n0(Some(usage), "input_tokens");
  let output = n0(Some(usage), "output_tokens");
  let cache_read = n0(Some(usage), "cache_read_input_tokens");
  let (ri, ro, rcw, rcr) = rate(&model);
  let cost = match obj.get("costUSD").filter(|v| !v.is_null()) {
    Some(c) => c.as_f64().unwrap_or(f64::NAN),
    None => (input * ri + output * ro + cache_write * rcw + cache_read * rcr) / 1e6,
  };
  let key = if id.is_empty() { String::new() } else { format!("{id}|{req}") };
  Some(Entry { key, model, input, output, cache_write, cache_read, cost })
}

struct FileCache {
  size: u64,
  mtime: f64,
  offset: u64,
  entries: Vec<Entry>,
}

static FILES: OnceLock<Mutex<(String, HashMap<PathBuf, FileCache>)>> = OnceLock::new();

/// readLinesFrom: complete lines from `start`; the offset past the last one.
/// Streamed in 64KB reads (as Node's createReadStream): today's transcripts
/// can be hundreds of MB, and only one line is ever held at a time.
fn read_lines_from(file: &Path, start: u64, mut on_line: impl FnMut(&str)) -> std::io::Result<u64> {
  let mut f = std::fs::File::open(file)?;
  f.seek(SeekFrom::Start(start))?;
  let mut buf = vec![0u8; 64 * 1024];
  let mut carry: Vec<u8> = Vec::new();
  let mut base = start; // file offset of buf[0]
  let mut offset = start; // just past the last complete line
  loop {
    let n = f.read(&mut buf)?;
    if n == 0 {
      return Ok(offset);
    }
    let mut from = 0;
    while let Some(nl) = buf[from..n].iter().position(|&b| b == b'\n') {
      let end = from + nl;
      if carry.is_empty() {
        on_line(&String::from_utf8_lossy(&buf[from..end]));
      } else {
        carry.extend_from_slice(&buf[from..end]);
        on_line(&String::from_utf8_lossy(&carry));
        carry = Vec::new();
      }
      offset = base + end as u64 + 1;
      from = end + 1;
    }
    carry.extend_from_slice(&buf[from..n]);
    base += n as u64;
  }
}

fn todays_entries(cache: &mut HashMap<PathBuf, FileCache>, file: &Path, size: u64, mtime: f64, today: &str) -> std::io::Result<Vec<Entry>> {
  if let Some(h) = cache.get(file) {
    if h.size == size && h.mtime == mtime {
      return Ok(h.entries.clone());
    }
  }
  let hit = cache.get(file);
  let resume = hit.is_some_and(|h| size >= h.size && size >= h.offset);
  let mut entries = if resume { hit.unwrap().entries.clone() } else { Vec::new() };
  let start = if resume { hit.unwrap().offset } else { 0 };
  let offset = read_lines_from(file, start, |l| {
    if let Some(e) = entry_of(l, today) {
      entries.push(e);
    }
  })?;
  cache.insert(file.to_path_buf(), FileCache { size, mtime, offset, entries: entries.clone() });
  Ok(entries)
}

pub fn usage_today(config_dir: Option<&str>) -> Value {
  let today = today_key();
  let mut g = FILES.get_or_init(Default::default).lock().unwrap();
  let (day, cache) = &mut *g;
  if *day != today {
    cache.clear();
    *day = today.clone();
  }
  let mut files = Vec::new();
  for r in claude_roots(config_dir) {
    walk_jsonl(&r, &mut files, 4000);
  }
  let mut seen = std::collections::HashSet::new();
  let mut by_model: Vec<(String, [f64; 5])> = Vec::new();
  let cutoff = crate::services::util::now_ms() - 36.0 * 3600.0 * 1000.0;
  for file in &files {
    let Ok(meta) = std::fs::metadata(file) else { continue };
    let mtime = crate::services::util::mtime_ms(&meta);
    if mtime < cutoff {
      continue;
    }
    let Ok(entries) = todays_entries(cache, file, meta.len(), mtime, &today) else { continue };
    for e in entries {
      if !e.key.is_empty() && !seen.insert(e.key.clone()) {
        continue;
      }
      let i = match by_model.iter().position(|(m, _)| *m == e.model) {
        Some(i) => i,
        None => {
          by_model.push((e.model.clone(), [0.0; 5]));
          by_model.len() - 1
        }
      };
      let m = &mut by_model[i].1;
      m[0] += e.input;
      m[1] += e.output;
      m[2] += e.cache_write;
      m[3] += e.cache_read;
      m[4] += e.cost;
    }
  }
  // sort by cost, descending (stable, as Array.prototype.sort)
  by_model.sort_by(|a, b| {
    let d = b.1[4] - a.1[4];
    if d > 0.0 {
      std::cmp::Ordering::Greater
    } else if d < 0.0 {
      std::cmp::Ordering::Less
    } else {
      std::cmp::Ordering::Equal
    }
  });
  let total_cost = by_model.iter().fold(0.0, |s, (_, m)| s + m[4]);
  let total_tokens = by_model.iter().fold(0.0, |s, (_, m)| s + m[0] + m[1] + m[2] + m[3]);
  let per_model: Vec<Value> = by_model
    .iter()
    .map(|(model, m)| {
      json!({ "model": model, "input": jsnum(m[0]), "output": jsnum(m[1]), "cacheWrite": jsnum(m[2]), "cacheRead": jsnum(m[3]), "cost": jsnum(m[4]) })
    })
    .collect();
  json!({ "totalCost": jsnum(total_cost), "totalTokens": jsnum(total_tokens), "perModel": per_model })
}

// ---- usage:codex ---------------------------------------------------------------------------

fn day_dir(ms: f64) -> PathBuf {
  let (y, m, d) = local_ymd(ms);
  home().join(".codex").join("sessions").join(y.to_string()).join(format!("{m:02}")).join(format!("{d:02}"))
}

fn window(o: Option<&Value>) -> Value {
  let Some(w) = o.filter(|w| w.is_object()) else { return Value::Null };
  let Some(used) = w.get("used_percent").and_then(Value::as_f64) else { return Value::Null };
  let resets = w.get("resets_at").and_then(Value::as_f64).filter(|r| *r != 0.0 && !r.is_nan());
  json!({ "usedPct": jsnum(used), "resetsAt": resets.map(|r| Value::String(iso(r * 1000.0))).unwrap_or(Value::Null) })
}

pub fn usage_codex() -> Value {
  let mut out = json!({ "installed": false, "totalTokens": 0, "cachedTokens": 0, "primary": null, "primaryWindowMinutes": null, "secondary": null });
  if std::fs::metadata(home().join(".codex")).is_err() {
    return out;
  }
  out["installed"] = json!(true);
  let today = today_key();
  let mut files = Vec::new();
  let now = crate::services::util::now_ms();
  for t in [now, now - 24.0 * 3600.0 * 1000.0] {
    walk_jsonl(&day_dir(t), &mut files, 4000);
  }
  let mut total = 0.0f64;
  // The part of `total` that was cached input (Codex's input_tokens includes
  // it), so the pet can weigh it like a Claude cache read.
  let mut cached = 0.0f64;
  let mut newest = 0.0f64;
  for file in &files {
    let mut lines = Vec::new();
    // Streamed; only the token_count lines are kept (a trailing line without
    // a newline counts too, as in the whole-file read the Node module does).
    let Ok(end) = read_lines_from(file, 0, |l| {
      if l.contains("token_count") {
        lines.push(l.to_string())
      }
    }) else {
      continue;
    };
    if let Ok(meta) = std::fs::metadata(file) {
      if meta.len() > end {
        let _ = (|| -> std::io::Result<()> {
          let mut f = std::fs::File::open(file)?;
          f.seek(SeekFrom::Start(end))?;
          let mut tail = Vec::new();
          f.read_to_end(&mut tail)?;
          let t = String::from_utf8_lossy(&tail);
          if t.contains("token_count") {
            lines.push(t.into_owned());
          }
          Ok(())
        })();
      }
    }
    for line in &lines {
      let line = line.as_str();
      let Ok(obj) = serde_json::from_str::<Value>(line) else { continue };
      let Some(payload) = obj.get("payload") else { continue };
      if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        continue;
      }
      let ts = obj.get("timestamp").and_then(Value::as_str).unwrap_or("");
      let last = payload.get("info").and_then(|i| i.get("last_token_usage")).filter(|v| !v.is_null());
      if last.is_some() && local_day_key(ts) == today {
        total += n0(last, "input_tokens") + n0(last, "output_tokens") + n0(last, "reasoning_output_tokens") + n0(last, "cache_write_input_tokens");
        cached += n0(last, "cached_input_tokens").min(n0(last, "input_tokens"));
      }
      let rl = payload.get("rate_limits").filter(|v| !v.is_null() && v.as_bool() != Some(false));
      let at = parse_iso(ts);
      let at = if at.is_nan() { 0.0 } else { at };
      if let Some(rl) = rl {
        if at >= newest {
          newest = at;
          out["primary"] = window(rl.get("primary"));
          out["secondary"] = window(rl.get("secondary"));
          out["primaryWindowMinutes"] = rl.get("primary").and_then(|p| p.get("window_minutes")).and_then(Value::as_f64).map(jsnum).unwrap_or(Value::Null);
        }
      }
    }
  }
  out["totalTokens"] = jsnum(total);
  out["cachedTokens"] = jsnum(cached);
  out
}
