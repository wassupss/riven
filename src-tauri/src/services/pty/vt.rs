// The terminal MODEL: one libghostty-vt terminal per PTY, linked natively
// (vendor/ghostty-vt, built from the same upstream commit as the renderer's
// wasm by scripts/build-ghostty-vt-native.sh).
//
// It exists for three things only: restoring a pane on reveal/reattach (binary
// snapshot, decoded by the renderer into an identical terminal), the parsed
// bell/title, and the notification preview tail. It never answers queries (no
// WRITE_PTY callback): the renderer's terminal is the one that talks back to
// the shell, and two answers would corrupt the input stream.

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr;

type Terminal = *mut c_void;
type Formatter = *mut c_void;

const OPT_USERDATA: i32 = 0;
const OPT_BELL: i32 = 2;
const OPT_TITLE_CHANGED: i32 = 5;
const OPT_SCROLLBACK_MAX_BYTES: i32 = 27;
const OPT_SCROLLBACK_MAX_LINES: i32 = 28;
const OPT_CONTINUATION_MAX_BYTES: i32 = 31;
const DATA_TITLE: i32 = 12;
const FORMAT_PLAIN: i32 = 0;

#[repr(C)]
struct GString {
  ptr: *const u8,
  len: usize,
}

#[repr(C)]
#[derive(Default)]
struct ScreenExtra {
  size: usize,
  cursor: bool,
  style: bool,
  hyperlink: bool,
  protection: bool,
  kitty_keyboard: bool,
  charsets: bool,
}

#[repr(C)]
#[derive(Default)]
struct TerminalExtra {
  size: usize,
  palette: bool,
  modes: bool,
  scrolling_region: bool,
  tabstops: bool,
  pwd: bool,
  keyboard: bool,
  screen: ScreenExtra,
}

#[repr(C)]
struct FormatterOptions {
  size: usize,
  emit: i32,
  unwrap: bool,
  trim: bool,
  extra: TerminalExtra,
  selection: *const c_void,
}

type Callback = extern "C" fn(Terminal, *mut c_void);

extern "C" {
  fn ghostty_terminal_new(alloc: *const c_void, out: *mut Terminal, cols: u16, rows: u16) -> i32;
  fn ghostty_terminal_free(t: Terminal);
  fn ghostty_terminal_set(t: Terminal, opt: i32, value: *const c_void) -> i32;
  fn ghostty_terminal_get(t: Terminal, data: i32, out: *mut c_void) -> i32;
  fn ghostty_terminal_vt_write(t: Terminal, data: *const u8, len: usize);
  fn ghostty_terminal_resize(t: Terminal, cols: u16, rows: u16, cw: u32, ch: u32) -> i32;
  fn ghostty_snapshot_encode_alloc(t: Terminal, alloc: *const c_void, out_ptr: *mut *mut u8, out_len: *mut usize) -> i32;
  fn ghostty_formatter_terminal_new(alloc: *const c_void, out: *mut Formatter, t: Terminal, opts: FormatterOptions) -> i32;
  fn ghostty_formatter_format_alloc(f: Formatter, alloc: *const c_void, out_ptr: *mut *mut u8, out_len: *mut usize) -> i32;
  fn ghostty_formatter_free(f: Formatter);
  fn ghostty_free(alloc: *const c_void, p: *mut u8, len: usize);
}

// libghostty calls back mid-write. Bell and title are only RECORDED there and
// reported after the write returns: the title can only be read once the
// callback has returned, and reporting after the chunk keeps them behind
// output that is already queued.
#[derive(Default)]
struct Pending {
  bell: Cell<bool>,
  title: Cell<bool>,
}

extern "C" fn on_bell(_t: Terminal, ud: *mut c_void) {
  // SAFETY: ud is the Box<Pending> owned by the Vt, alive for its terminal.
  unsafe { (*(ud as *const Pending)).bell.set(true) }
}
extern "C" fn on_title(_t: Terminal, ud: *mut c_void) {
  unsafe { (*(ud as *const Pending)).title.set(true) }
}

pub struct Vt {
  t: Terminal,
  pending: Box<Pending>,
}

// The terminal is only touched through &mut self or &self under the session
// lock; libghostty keeps no thread affinity.
unsafe impl Send for Vt {}

#[derive(Default)]
pub struct Events {
  pub bell: bool,
  pub title: Option<String>,
}

impl Vt {
  pub fn new(cols: u16, rows: u16, scrollback: usize) -> Result<Vt, String> {
    let mut t: Terminal = ptr::null_mut();
    let r = unsafe { ghostty_terminal_new(ptr::null(), &mut t, cols.max(1), rows.max(1)) };
    if r != 0 || t.is_null() {
      return Err(format!("terminal engine failed ({r})"));
    }
    let pending = Box::new(Pending::default());
    unsafe {
      ghostty_terminal_set(t, OPT_USERDATA, &*pending as *const Pending as *const c_void);
      ghostty_terminal_set(t, OPT_BELL, on_bell as Callback as *const c_void);
      ghostty_terminal_set(t, OPT_TITLE_CHANGED, on_title as Callback as *const c_void);
      // Line-bounded scrollback only: the default BYTE cap keeps far fewer
      // lines than asked for.
      ghostty_terminal_set(t, OPT_SCROLLBACK_MAX_BYTES, ptr::null());
      let lines: usize = scrollback;
      ghostty_terminal_set(t, OPT_SCROLLBACK_MAX_LINES, &lines as *const usize as *const c_void);
      // A chunk can end inside an escape sequence; without continuation
      // tracking the snapshot of such a model fails. The renderer decodes the
      // continuation and the next chunk picks up right after it.
      let cont: usize = 64 * 1024;
      ghostty_terminal_set(t, OPT_CONTINUATION_MAX_BYTES, &cont as *const usize as *const c_void);
    }
    Ok(Vt { t, pending })
  }

  /// Synchronous: once this returns the model reflects `data`.
  pub fn write(&mut self, data: &[u8]) -> Events {
    unsafe { ghostty_terminal_vt_write(self.t, data.as_ptr(), data.len()) };
    let mut ev = Events::default();
    if self.pending.bell.replace(false) {
      ev.bell = true;
    }
    if self.pending.title.replace(false) {
      ev.title = Some(self.title());
    }
    ev
  }

  pub fn resize(&mut self, cols: u16, rows: u16) {
    // Pixel size only feeds XTWINOPS replies, which this model never sends.
    unsafe { ghostty_terminal_resize(self.t, cols.max(1), rows.max(1), 1, 1) };
  }

  /// The whole terminal (both screens, scrollback, modes, cursor, title) in
  /// libghostty's own snapshot format.
  pub fn snapshot(&self) -> Result<Vec<u8>, String> {
    let mut p: *mut u8 = ptr::null_mut();
    let mut l: usize = 0;
    let r = unsafe { ghostty_snapshot_encode_alloc(self.t, ptr::null(), &mut p, &mut l) };
    if r != 0 {
      return Err(format!("snapshot failed ({r})"));
    }
    Ok(take(p, l))
  }

  /// The last few content lines, for a notification preview. Reading the
  /// parsed grid beats scraping ANSI out of the raw stream: box drawing and
  /// cursor games are already resolved.
  pub fn tail(&self, lines: usize) -> String {
    let all = self.plain();
    let mut out: Vec<String> = Vec::new();
    for line in all.split('\n').rev() {
      if out.len() >= lines {
        break;
      }
      let kept: String = line.chars().filter(|c| !matches!(c, '\u{2500}'..='\u{257F}' | '\u{2580}'..='\u{259F}')).collect();
      let squashed = kept.split_whitespace().collect::<Vec<_>>().join(" ");
      if !squashed.is_empty() {
        out.push(squashed);
      }
    }
    out.reverse();
    let tail = out.join("\n");
    // JS counts UTF-16 units; close enough for a preview cut.
    let chars: Vec<char> = tail.chars().collect();
    if chars.len() > 240 {
      format!("…{}", chars[chars.len() - 240..].iter().collect::<String>())
    } else {
      tail
    }
  }

  fn plain(&self) -> String {
    let opts = FormatterOptions {
      size: std::mem::size_of::<FormatterOptions>(),
      emit: FORMAT_PLAIN,
      unwrap: false,
      trim: false,
      extra: TerminalExtra {
        size: std::mem::size_of::<TerminalExtra>(),
        screen: ScreenExtra { size: std::mem::size_of::<ScreenExtra>(), ..Default::default() },
        ..Default::default()
      },
      selection: ptr::null(),
    };
    let mut f: Formatter = ptr::null_mut();
    if unsafe { ghostty_formatter_terminal_new(ptr::null(), &mut f, self.t, opts) } != 0 || f.is_null() {
      return String::new();
    }
    let mut p: *mut u8 = ptr::null_mut();
    let mut l: usize = 0;
    let r = unsafe { ghostty_formatter_format_alloc(f, ptr::null(), &mut p, &mut l) };
    unsafe { ghostty_formatter_free(f) };
    if r != 0 {
      return String::new();
    }
    String::from_utf8_lossy(&take(p, l)).into_owned()
  }

  fn title(&self) -> String {
    let mut s = GString { ptr: ptr::null(), len: 0 };
    if unsafe { ghostty_terminal_get(self.t, DATA_TITLE, &mut s as *mut GString as *mut c_void) } != 0 || s.ptr.is_null() {
      return String::new();
    }
    String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(s.ptr, s.len) }).into_owned()
  }
}

fn take(p: *mut u8, l: usize) -> Vec<u8> {
  if p.is_null() {
    return Vec::new();
  }
  let v = unsafe { std::slice::from_raw_parts(p, l) }.to_vec();
  unsafe { ghostty_free(ptr::null(), p, l) };
  v
}

impl Drop for Vt {
  fn drop(&mut self) {
    unsafe { ghostty_terminal_free(self.t) };
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn writes_reads_and_snapshots() {
    let mut vt = Vt::new(20, 5, 100).unwrap();
    let ev = vt.write(b"hello \xed\x95\x9c\xea\xb8\x80\r\nworld\x07\x1b]0;my title\x07");
    assert!(ev.bell);
    assert_eq!(ev.title.as_deref(), Some("my title"));
    assert_eq!(vt.tail(8), "hello 한글\nworld");
    let snap = vt.snapshot().unwrap();
    assert_eq!(&snap[..8], b"GHOSTSNP");
    // Mid-escape: continuation tracking keeps the snapshot possible.
    vt.write(b"\x1b[3");
    assert!(vt.snapshot().is_ok());
    vt.resize(40, 10);
  }
}

