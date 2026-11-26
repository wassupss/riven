// The browser panel (src/main/browser.ts), run here.
//
// Each panel tab is a child WKWebView of the window its panel is in
// (crate::browser, the native side: create, bounds, navigate, script, snapshot,
// and the hooks that report the view's state). This module is what browser.ts
// did on top of Electron's WebContentsView, plus what tauri/shim/views.ts did
// to turn WebKit's state into Electron's events:
//
//   - the tabs, their window, their place over the panel (browser:sync), the
//     modal guard (browser:hideAll), pop-outs;
//   - the events the page listens to ('browser:event': nav, title, loading,
//     favicon, newtab, download, download-done, agent-action, store, resync;
//     'browser:key'; 'browser:suggestPick'), always to riven's own window;
//   - bookmarks and history (userData/browser.json, the same file and shape);
//   - the right-click and toolbar menus (native, as Electron's), the address
//     bar's suggestion list (its own unfocusable window), the element picker.
//
// The native hooks run on the main thread and only queue what they saw
// (on_view); one worker thread turns that into events in order. The main
// thread never takes STATE, so a command may hold it across a native call
// that waits on the main thread.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const PARTITION: &str = "persist:riven-browser";
const HISTORY_MAX: usize = 500;
const HISTORY_LIST: usize = 100;
// The panel draws a 1px frame around itself and the native view paints above
// all page DOM, so the view sits just inside it (browser.ts VIEW_INSET).
const VIEW_INSET: f64 = 1.0;
const POLL: Duration = Duration::from_millis(700);

// ---- what WebKit says about a view ------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ViewState {
  pub url: String,
  pub title: String,
  pub loading: bool,
  pub back: bool,
  pub fwd: bool,
}

impl ViewState {
  pub fn from_json(v: &Value) -> Option<Self> {
    let o = v.as_object()?;
    let st = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let bo = |k: &str| o.get(k).and_then(Value::as_bool).unwrap_or(false);
    Some(ViewState { url: st("url"), title: st("title"), loading: bo("loading"), back: bo("back"), fwd: bo("fwd") })
  }
}

/// What a state change means to the page, in the order Electron raised it
/// (views.ts _state, then browser.ts wireEvents).
#[derive(Debug, PartialEq)]
pub enum Out {
  Loading(bool),
  Nav,
  Title(String),
  /// did-stop-loading: browser.ts sends loading:false, nav, and records history.
  Stopped,
}

/// views.ts `_state(st, hint)` and the browser:event each Electron event became.
pub fn diff(prev: &ViewState, next: &ViewState, hint: &str) -> Vec<Out> {
  let mut out = Vec::new();
  if next.loading && !prev.loading {
    out.push(Out::Loading(true));
  }
  // did-navigate on a commit; otherwise a changed url is did-navigate or
  // did-navigate-in-page, both of which browser.ts sends as 'nav'.
  if hint == "commit" || next.url != prev.url {
    out.push(Out::Nav);
  }
  if next.title != prev.title {
    out.push(Out::Title(next.title.clone()));
  }
  if !next.loading && prev.loading {
    out.push(Out::Stopped);
  }
  out
}

// ---- where a view goes ------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl Rect {
  pub fn from_json(v: &Value) -> Option<Self> {
    Some(Rect {
      x: v.get("x")?.as_f64()?,
      y: v.get("y")?.as_f64()?,
      width: v.get("width")?.as_f64()?,
      height: v.get("height")?.as_f64()?,
    })
  }
}

/// JS Math.round (half up, toward +inf).
fn js_round(v: f64) -> f64 {
  (v + 0.5).floor()
}

/// browser.ts apply(): the panel's rect (CSS px of riven's page) as the view's
/// frame in the window (logical points). `css` is the page's CSS viewport and
/// `content` the window's content size; they differ by riven's UI zoom.
pub fn place(rect: Rect, css: Option<(f64, f64)>, content: (f64, f64)) -> Rect {
  let (mut sx, mut sy) = (1.0, 1.0);
  if let Some((w, h)) = css {
    if w > 0.0 && h > 0.0 {
      sx = content.0 / w;
      sy = content.1 / h;
    }
  }
  let inset = (VIEW_INSET * sx).ceil().max(1.0);
  Rect {
    x: js_round(rect.x * sx) + inset,
    y: js_round(rect.y * sy),
    width: (js_round(rect.width * sx) - inset * 2.0).max(1.0),
    height: (js_round(rect.height * sy) - inset).max(1.0),
  }
}

// ---- bookmarks and history (userData/browser.json) ----------------------------------

pub struct Store {
  // The file's whole object: keys we do not know are written back as they were.
  pub doc: Map<String, Value>,
}

impl Store {
  pub fn parse(text: Option<&str>) -> Store {
    let mut doc = Map::new();
    doc.insert("bookmarks".into(), json!([]));
    doc.insert("history".into(), json!([]));
    if let Some(Value::Object(o)) = text.and_then(|t| serde_json::from_str::<Value>(t).ok()) {
      for (k, v) in o {
        doc.insert(k, v);
      }
    }
    Store { doc }
  }
  fn list(&mut self, key: &str) -> &mut Vec<Value> {
    if !self.doc.get(key).is_some_and(Value::is_array) {
      self.doc.insert(key.into(), json!([]));
    }
    self.doc.get_mut(key).and_then(Value::as_array_mut).unwrap()
  }
  pub fn bookmarks(&mut self) -> Value {
    Value::Array(self.list("bookmarks").clone())
  }
  pub fn history(&mut self) -> Value {
    Value::Array(self.list("history").iter().take(HISTORY_LIST).cloned().collect())
  }
  /// recordHistory: http(s) only, newest first, one entry per url, at most 500.
  pub fn record(&mut self, url: &str, title: &str, ts: f64) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
      return false;
    }
    let h = self.list("history");
    h.retain(|e| e.get("url").and_then(Value::as_str) != Some(url));
    let title = if title.is_empty() { url } else { title };
    h.insert(0, json!({ "url": url, "title": title, "ts": ts }));
    h.truncate(HISTORY_MAX);
    true
  }
  pub fn add_bookmark(&mut self, b: Value) {
    let url = b.get("url").cloned();
    let bm = self.list("bookmarks");
    if !bm.iter().any(|x| x.get("url") == url.as_ref()) {
      bm.insert(0, b);
    }
  }
  pub fn remove_bookmark(&mut self, url: &Value) {
    self.list("bookmarks").retain(|x| x.get("url") != Some(url));
  }
  pub fn is_bookmarked(&mut self, url: &str) -> bool {
    self.list("bookmarks").iter().any(|x| x.get("url").and_then(Value::as_str) == Some(url))
  }
  pub fn clear_history(&mut self) {
    self.doc.insert("history".into(), json!([]));
  }
  pub fn text(&self) -> String {
    Value::Object(self.doc.clone()).to_string()
  }
}

// ---- menus ---------------------------------------------------------------------------

/// The UI language for the native menus (browser:setLang).
pub fn l(ko_lang: bool, ko: &'static str, en: &'static str) -> &'static str {
  if ko_lang {
    ko
  } else {
    en
  }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Act {
  Back,
  Forward,
  Reload,
  NewTab(String),
  Copy(String),
  Agent(&'static str, Option<String>),
  Inspect,
  ZoomIn,
  ZoomOut,
  ZoomReset,
  ToggleBookmark { url: String, title: String, on: bool },
  Devtools,
}

pub enum Item {
  Act(&'static str, bool, Act),
  Role(&'static str, &'static str),
  Sep,
}

pub struct Ctx {
  pub link: String,
  pub src: String,
  pub image: bool,
  pub selection: String,
  pub editable: bool,
}

/// The right-click menu (browser.ts wireEvents 'context-menu').
pub fn context_menu(ko: bool, back: bool, fwd: bool, c: &Ctx) -> Vec<Item> {
  let mut m = vec![
    Item::Act(l(ko, "뒤로", "Back"), back, Act::Back),
    Item::Act(l(ko, "앞으로", "Forward"), fwd, Act::Forward),
    Item::Act(l(ko, "새로고침", "Reload"), true, Act::Reload),
    Item::Sep,
  ];
  if !c.link.is_empty() {
    m.push(Item::Act(l(ko, "링크 새 탭에서 열기", "Open link in new tab"), true, Act::NewTab(c.link.clone())));
    m.push(Item::Act(l(ko, "링크 주소 복사", "Copy link address"), true, Act::Copy(c.link.clone())));
  }
  if c.image && !c.src.is_empty() {
    m.push(Item::Act(l(ko, "이미지 주소 복사", "Copy image address"), true, Act::Copy(c.src.clone())));
  }
  if !c.selection.is_empty() {
    m.push(Item::Role(l(ko, "복사", "Copy"), "copy"));
    m.push(Item::Act(
      l(ko, "선택 영역 채팅으로 보내기", "Send selection to chat"),
      true,
      Act::Agent("selection", Some(c.selection.clone())),
    ));
  }
  if c.editable {
    m.push(Item::Role(l(ko, "잘라내기", "Cut"), "cut"));
    m.push(Item::Role(l(ko, "붙여넣기", "Paste"), "paste"));
    m.push(Item::Role(l(ko, "모두 선택", "Select all"), "selectAll"));
  }
  m.push(Item::Sep);
  m.push(Item::Act(l(ko, "스크린샷 채팅으로 보내기", "Send screenshot to chat"), true, Act::Agent("capture", None)));
  m.push(Item::Act(l(ko, "요소 선택해서 보내기", "Pick an element to send"), true, Act::Agent("pick", None)));
  m.push(Item::Sep);
  m.push(Item::Act(l(ko, "검사", "Inspect element"), true, Act::Inspect));
  m
}

/// The toolbar's overflow menu (browser:barMenu).
pub fn bar_menu(ko: bool, url: &str, title: &str, bookmarked: bool) -> Vec<Item> {
  let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
  let web = lower.starts_with("http://") || lower.starts_with("https://");
  vec![
    Item::Act(l(ko, "확대", "Zoom in"), true, Act::ZoomIn),
    Item::Act(l(ko, "축소", "Zoom out"), true, Act::ZoomOut),
    Item::Act(l(ko, "배율 초기화", "Reset zoom"), true, Act::ZoomReset),
    Item::Sep,
    Item::Act(l(ko, "페이지에서 찾기", "Find in page"), true, Act::Agent("find", None)),
    Item::Act(
      if bookmarked { l(ko, "즐겨찾기 삭제", "Remove bookmark") } else { l(ko, "즐겨찾기 추가", "Add bookmark") },
      web,
      Act::ToggleBookmark { url: url.to_string(), title: title.to_string(), on: bookmarked },
    ),
    Item::Act(l(ko, "개발자 도구", "DevTools"), true, Act::Devtools),
    Item::Sep,
    Item::Act(l(ko, "스크린샷 채팅으로 보내기", "Send screenshot to chat"), true, Act::Agent("capture", None)),
    Item::Act(l(ko, "요소 선택해서 보내기", "Pick an element to send"), true, Act::Agent("pick", None)),
  ]
}

/// Zoom steps as browser.ts: +-0.1 within [0.4, 3].
pub fn zoom_step(cur: f64, act: &Act) -> f64 {
  match act {
    Act::ZoomIn => (cur + 0.1).min(3.0),
    Act::ZoomOut => (cur - 0.1).max(0.4),
    _ => 1.0,
  }
}

// ---- the address bar's suggestion list ----------------------------------------------

fn esc(v: &str) -> String {
  let mut o = String::with_capacity(v.len());
  for c in v.chars() {
    match c {
      '&' => o.push_str("&amp;"),
      '<' => o.push_str("&lt;"),
      '>' => o.push_str("&gt;"),
      '"' => o.push_str("&quot;"),
      c => o.push(c),
    }
  }
  o
}

/// browser.ts suggestHtml: the rows, drawn at riven's UI zoom; a pick is
/// reported through the document title ('pick:<i>:<time>').
pub fn suggest_html(items: &[(String, String)], sel: i64, zoom: f64) -> String {
  let rows: String = items
    .iter()
    .enumerate()
    .map(|(i, (url, title))| {
      format!(
        "<div class=\"i{}\" data-i=\"{i}\"><span class=\"t\">{}</span><span class=\"u\">{}</span></div>",
        if i as i64 == sel { " on" } else { "" },
        esc(if title.is_empty() { url } else { title }),
        esc(url)
      )
    })
    .collect();
  format!(
    r#"<!doctype html><meta charset="utf-8"><style>
      :root{{color-scheme:dark}}
      html,body{{margin:0;overflow:hidden;background:transparent}}
      body{{font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#e7e3df}}
      #l{{zoom:{zoom};background:#17130f;border:1px solid #2f2b26;border-radius:10px;
         overflow:hidden;padding:4px}}
      .i{{display:flex;gap:10px;align-items:baseline;padding:6px 10px;border-radius:6px;
         cursor:default;white-space:nowrap;line-height:1.35}}
      .i:hover{{background:#221d18}}
      .i.on{{background:rgba(217,119,66,.16);box-shadow:inset 2px 0 0 #d97742}}
      .t{{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}}
      .u{{flex:1 1 auto;min-width:0;color:#9b8f81;overflow:hidden;text-overflow:ellipsis;
         font-size:12px;text-align:right}}
    </style><body><div id="l">{rows}</div></body>
    <script>
      document.body.addEventListener('mousedown', function (e) {{
        var el = e.target.closest('.i'); if (!el) return;
        document.title = 'pick:' + el.dataset.i + ':' + Date.now();
      }});
    </script>"#
  )
}

/// 'pick:<i>:...' -> i
pub fn suggest_pick(title: &str) -> Option<i64> {
  let rest = title.strip_prefix("pick:")?;
  let (n, _) = rest.split_once(':')?;
  if n.is_empty() || !n.bytes().all(|c| c.is_ascii_digit()) {
    return None;
  }
  n.parse().ok()
}

/// The list window's frame on screen: the address bar's rect in the window
/// (CSS px), the window's content origin and riven's UI zoom.
pub fn suggest_frame(origin: (f64, f64), rect: Rect, zoom: f64, css_height: f64) -> Rect {
  Rect {
    x: js_round(origin.0 + rect.x * zoom),
    y: js_round(origin.1 + rect.y * zoom),
    width: js_round(rect.width * zoom).max(80.0),
    height: js_round(css_height * zoom).max(24.0),
  }
}

// ---- the element picker ---------------------------------------------------------------

// Injected into the page: overlays a highlight that follows the cursor and
// resolves with the clicked element's rect/selector/markup. Esc cancels (null).
pub const PICK_SCRIPT: &str = r#"(() => new Promise((resolve) => {
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', zIndex: 2147483647, pointerEvents: 'none',
    border: '2px solid #e0662f', background: 'rgba(224,102,47,0.12)',
    borderRadius: '2px', transition: 'all 40ms ease', boxShadow: '0 0 0 1px rgba(0,0,0,0.4)'
  });
  const tip = document.createElement('div');
  Object.assign(tip.style, {
    position: 'fixed', zIndex: 2147483647, pointerEvents: 'none',
    font: '11px ui-monospace, monospace', color: '#fff', background: '#e0662f',
    padding: '2px 6px', borderRadius: '3px', maxWidth: '60vw', whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis'
  });
  document.body.appendChild(box); document.body.appendChild(tip);
  let cur = null;
  const sel = (el) => {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + el.id;
    let s = el.tagName.toLowerCase();
    if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    return s;
  };
  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tip) return;
    cur = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    tip.textContent = sel(el);
    tip.style.left = r.left + 'px';
    tip.style.top = Math.max(0, r.top - 20) + 'px';
  };
  const cleanup = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove(); tip.remove();
  };
  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = cur; cleanup();
    if (!el) return resolve(null);
    const r = el.getBoundingClientRect();
    resolve({ x: r.left, y: r.top, width: r.width, height: r.height, selector: sel(el), html: el.outerHTML.slice(0, 600) });
  };
  const onKey = (e) => { if (e.key === 'Escape') { cleanup(); resolve(null); } };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}))()"#;

/// The picked element's rect as the snapshot wants it (browser.ts pickElement).
pub fn pick_rect(p: &Value) -> Rect {
  let g = |k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(0.0);
  Rect {
    x: js_round(g("x")).max(0.0),
    y: js_round(g("y")).max(0.0),
    width: js_round(g("width")).max(1.0),
    height: js_round(g("height")).max(1.0),
  }
}

pub fn file_name(p: &str) -> String {
  std::path::Path::new(p).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

// ---- runtime (macOS: the views are WKWebViews) ------------------------------------------

#[cfg(target_os = "macos")]
pub use rt::*;

#[cfg(target_os = "macos")]
mod rt {
  use super::*;
  use crate::commands::emit_ipc;
  use crate::services::{atomic, paths};
  use tauri::{AppHandle, Manager};

  static APP: OnceLock<AppHandle> = OnceLock::new();
  static Q: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();

  struct Tab {
    label: String,
    host: String,
    // The visibility last applied (browser.ts t.visible, unset at first).
    visible: Option<bool>,
    st: ViewState,
    // Nothing is reported until the first load: the about:blank a view is
    // created with is not a page anyone asked for.
    started: bool,
    zoom: f64,
    // The last frame/visibility sent to the view, so repeats cost nothing.
    sent: String,
  }

  #[derive(Default)]
  struct State {
    tabs: HashMap<String, Tab>,
    by_label: HashMap<String, String>,
    next: u64,
    hidden_all: bool,
    store: Option<Store>,
    save_gen: u64,
    ko: bool,
    // Pop-out key -> window label, and the newest browser:sync per panel.
    popouts: HashMap<String, String>,
    sync_seq: HashMap<String, u64>,
    // The newest browser:sync per panel, replayed when the modal guard lifts.
    last_sync: HashMap<String, (String, Value)>,
    polling: bool,
    // The open menu's actions, by item id.
    menu: HashMap<String, (String, Act)>,
    menu_gen: u64,
    // The suggestion list: its window's parent and the page that asked.
    suggest_parent: Option<String>,
    suggest_sender: Option<String>,
  }

  fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(State { ko: true, ..Default::default() }))
  }

  enum Job {
    View(Value),
    Menu(String),
    Reread(String),
    SuggestTitle(String),
    HostClosing(String),
    HostDestroyed(String),
    ParentChanged(String),
  }

  pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let (tx, rx) = mpsc::channel::<Job>();
    let _ = Q.set(Mutex::new(tx));
    std::thread::Builder::new()
      .name("browser".into())
      .spawn(move || {
        for job in rx {
          match job {
            Job::View(v) => view_event(&v),
            Job::Menu(id) => menu_run(&id),
            Job::Reread(label) => reread(&label, "nav"),
            Job::HostClosing(label) => host_closing(&label),
            Job::HostDestroyed(label) => host_destroyed(&label),
            Job::ParentChanged(label) => parent_changed(&label),
            Job::SuggestTitle(t) => {
              if let Some(i) = suggest_pick(&t) {
                let sender = state().lock().unwrap().suggest_sender.clone();
                if let (Some(app), Some(s)) = (APP.get(), sender) {
                  emit_ipc(app, &s, "browser:suggestPick", json!([i]));
                }
              }
            }
          }
        }
      })
      .expect("browser thread");
  }

  fn queue(j: Job) {
    if let Some(q) = Q.get() {
      let _ = q.lock().unwrap().send(j);
    }
  }

  /// From the native hooks (main thread): queue only.
  pub fn on_view(v: Value) {
    queue(Job::View(v));
  }

  /// A menu item was chosen (main thread): queue only.
  pub fn on_menu(id: &str) -> bool {
    if !id.starts_with("riven-bv:") {
      return false;
    }
    queue(Job::Menu(id.to_string()));
    true
  }

  pub fn on_suggest_title(title: &str) {
    queue(Job::SuggestTitle(title.to_string()));
  }

  // Window events arrive on the main thread, which never takes STATE: queued.
  pub fn on_host_closing(label: &str) {
    queue(Job::HostClosing(label.to_string()));
  }
  pub fn on_host_destroyed(label: &str) {
    queue(Job::HostDestroyed(label.to_string()));
  }
  pub fn on_parent_changed(label: &str) {
    if label != "bv-suggest" {
      queue(Job::ParentChanged(label.to_string()));
    }
  }

  fn app() -> Option<&'static AppHandle> {
    APP.get()
  }

  fn native(cmd: &str, a: Value) -> Result<Value, String> {
    let app = app().ok_or("no app")?;
    let r = crate::browser::dispatch(app, cmd, &a);
    // The callers drop these results; a failed view call is logged here.
    if let Err(e) = &r {
      eprintln!("[browser] {cmd} failed: {e}");
    }
    r
  }

  /// riven's own window: the first app window still open (appWindow()).
  pub fn app_window() -> Option<String> {
    let app = app()?;
    let mut ws: Vec<(u64, String)> = app
      .windows()
      .into_keys()
      .filter(|l| l.starts_with('w') && l.len() > 1 && l[1..].chars().all(|c| c.is_ascii_digit()))
      .map(|l| (l[1..].parse().unwrap_or(u64::MAX), l))
      .collect();
    ws.sort();
    ws.into_iter().next().map(|(_, l)| l)
  }

  fn send(payload: Value) {
    if let (Some(app), Some(w)) = (app(), app_window()) {
      emit_ipc(app, &w, "browser:event", json!([payload]));
    }
  }

  fn nav_payload(id: &str, st: &ViewState) -> Value {
    json!({ "tabId": id, "kind": "nav", "url": st.url, "canGoBack": st.back, "canGoForward": st.fwd })
  }

  fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
  }

  // ---- store ----

  fn store(s: &mut State) -> &mut Store {
    s.store.get_or_insert_with(|| Store::parse(std::fs::read_to_string(paths::user_file("browser.json")).ok().as_deref()))
  }

  // Written 300ms after the last change, as browser.ts did.
  fn save(s: &mut State) {
    s.save_gen += 1;
    let gen = s.save_gen;
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(300));
      let text = {
        let mut g = state().lock().unwrap();
        if g.save_gen != gen {
          return;
        }
        store(&mut g).text()
      };
      let _ = atomic::write_blocking(&paths::user_file("browser.json"), text.as_bytes());
    });
  }

  fn changed(s: &mut State) {
    save(s);
    send(json!({ "kind": "store" }));
  }

  pub fn bookmarks() -> Value {
    store(&mut state().lock().unwrap()).bookmarks()
  }
  pub fn history() -> Value {
    store(&mut state().lock().unwrap()).history()
  }
  pub fn add_bookmark(b: Value) {
    let mut s = state().lock().unwrap();
    store(&mut s).add_bookmark(b);
    changed(&mut s);
  }
  pub fn remove_bookmark(url: Value) {
    let mut s = state().lock().unwrap();
    store(&mut s).remove_bookmark(&url);
    changed(&mut s);
  }
  pub fn clear_history() {
    let mut s = state().lock().unwrap();
    store(&mut s).clear_history();
    changed(&mut s);
  }

  // ---- state -> events ----

  fn apply(s: &mut State, label: &str, st: ViewState, hint: &str) {
    let Some(id) = s.by_label.get(label).cloned() else { return };
    let Some(t) = s.tabs.get_mut(&id) else { return };
    if !t.started {
      return;
    }
    let outs = diff(&t.st, &st, hint);
    t.st = st.clone();
    let loading = st.loading;
    let mut record = None;
    for o in outs {
      match o {
        Out::Loading(on) => send(json!({ "tabId": id, "kind": "loading", "loading": on })),
        Out::Nav => send(nav_payload(&id, &st)),
        Out::Title(title) => send(json!({ "tabId": id, "kind": "title", "title": title })),
        Out::Stopped => {
          send(json!({ "tabId": id, "kind": "loading", "loading": false }));
          send(nav_payload(&id, &st));
          record = Some((st.url.clone(), if st.title.is_empty() { st.url.clone() } else { st.title.clone() }));
        }
      }
    }
    if let Some((url, title)) = record {
      if store(s).record(&url, &title, now_ms()) {
        changed(s);
      }
    }
    // A load in flight is also asked about now and then (see poll).
    if loading && !s.polling {
      s.polling = true;
      std::thread::spawn(poll);
    }
  }

  fn poll() {
    loop {
      std::thread::sleep(POLL);
      let labels: Vec<String> = {
        let mut s = state().lock().unwrap();
        let l: Vec<String> = s.tabs.values().filter(|t| t.st.loading).map(|t| t.label.clone()).collect();
        if l.is_empty() {
          s.polling = false;
          return;
        }
        l
      };
      for label in labels {
        reread(&label, "poll");
      }
    }
  }

  fn reread(label: &str, hint: &str) {
    let Ok(v) = native("bv.state", json!({ "label": label })) else { return };
    if let Some(st) = ViewState::from_json(&v) {
      apply(&mut state().lock().unwrap(), label, st, hint);
    }
  }

  fn view_event(m: &Value) {
    let label = m.get("label").and_then(Value::as_str).unwrap_or("").to_string();
    let st = m.get("state").and_then(ViewState::from_json);
    let kind = m.get("kind").and_then(Value::as_str).unwrap_or("");
    let mut s = state().lock().unwrap();
    let Some(id) = s.by_label.get(&label).cloned() else { return };
    match kind {
      "state" => {
        if let Some(st) = st {
          let hint = m.get("hint").and_then(Value::as_str).unwrap_or("");
          apply(&mut s, &label, st, hint);
        }
      }
      "msg" => {
        let msg = m.get("msg").cloned().unwrap_or(Value::Null);
        let g = |k: &str| msg.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let gb = |k: &str| msg.get(k).and_then(Value::as_bool).unwrap_or(false);
        match msg.get("t").and_then(Value::as_str) {
          Some("nav") => {
            if let Some(st) = st {
              apply(&mut s, &label, st, "nav");
            }
            // The page's script can tell before WKWebView's URL does (a
            // fragment change): look again once it has caught up.
            let l = label.clone();
            std::thread::spawn(move || {
              std::thread::sleep(Duration::from_millis(120));
              queue(Job::Reread(l));
            });
          }
          // A focused page swallows the keyboard: Cmd/Ctrl chords go to riven's keymap.
          Some("key") => {
            if gb("meta") || gb("control") {
              if let (Some(app), Some(w)) = (app(), app_window()) {
                emit_ipc(
                  app,
                  &w,
                  "browser:key",
                  json!([{ "key": g("key"), "code": g("code"), "meta": gb("meta"), "control": gb("control"), "alt": gb("alt"), "shift": gb("shift") }]),
                );
              }
            }
          }
          Some("ctx") => {
            if let Some(st) = st {
              apply(&mut s, &label, st, "ctx");
            }
            let (back, fwd) = s.tabs.get(&id).map(|t| (t.st.back, t.st.fwd)).unwrap_or((false, false));
            let ctx = Ctx {
              link: g("linkURL"),
              src: g("srcURL"),
              image: g("mediaType") == "image",
              selection: g("selectionText"),
              editable: gb("isEditable"),
            };
            let items = context_menu(s.ko, back, fwd, &ctx);
            let host = s.tabs.get(&id).map(|t| t.host.clone());
            let m = popup(&mut s, &id, items, host);
            drop(s);
            show_menu(m);
            return;
          }
          Some("favicon") => {
            let started = s.tabs.get(&id).is_some_and(|t| t.started);
            if started {
              if let Some(u) = msg.get("url").and_then(Value::as_str) {
                send(json!({ "tabId": id, "kind": "favicon", "favicon": u }));
              }
            }
          }
          _ => {}
        }
      }
      // target=_blank / window.open: a new tab in the panel, never a window.
      "newwindow" => {
        let url = m.get("url").and_then(Value::as_str).unwrap_or("");
        send(json!({ "tabId": id, "kind": "newtab", "url": url }));
      }
      "download" => {
        let path = m.get("path").and_then(Value::as_str).unwrap_or("");
        send(json!({ "kind": "download", "filename": file_name(path) }));
      }
      "download-done" => {
        let path = m.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        let ok = m.get("success").and_then(Value::as_bool).unwrap_or(false);
        send(json!({
          "kind": "download-done", "filename": file_name(&path), "path": path,
          "state": if ok { "completed" } else { "interrupted" },
        }));
      }
      "fail" => {
        let code = m.get("code").and_then(Value::as_i64).unwrap_or(-2);
        let desc = m.get("desc").and_then(Value::as_str).unwrap_or("ERR_FAILED");
        let url = m.get("url").and_then(Value::as_str).unwrap_or("");
        println!("[browser] load failed: {desc} ({code}) {url}");
        // A load that never reached the page is followed at once by the error
        // page at the failed URL (crate::browser NavProxy); WebKit's state here
        // still names the old page, which would flash into the address bar.
        let error_page = m.get("provisional").and_then(Value::as_bool).unwrap_or(false) && code != -3;
        if let (Some(st), false) = (st, error_page) {
          apply(&mut s, &label, st, "fail");
        }
      }
      _ => {}
    }
  }

  // ---- menus ----

  // Build the menu's template under the lock; pop it up after (show_menu).
  fn popup(s: &mut State, id: &str, items: Vec<Item>, host: Option<String>) -> Option<(String, Value)> {
    s.menu.clear();
    s.menu_gen += 1;
    let gen = s.menu_gen;
    let mut tpl = Vec::new();
    for (n, it) in items.into_iter().enumerate() {
      match it {
        Item::Sep => tpl.push(json!({ "kind": "separator" })),
        Item::Role(label, role) => tpl.push(json!({ "kind": "predefined", "role": role, "label": label })),
        Item::Act(label, enabled, act) => {
          let mid = format!("riven-bv:{gen}:{n}");
          s.menu.insert(mid.clone(), (id.to_string(), act));
          tpl.push(json!({ "id": mid, "label": label, "enabled": enabled }));
        }
      }
    }
    let w = host.filter(|h| app().is_some_and(|a| a.get_window(h).is_some())).or_else(app_window)?;
    Some((w, json!({ "items": tpl })))
  }

  fn show_menu(m: Option<(String, Value)>) {
    if let (Some((w, tpl)), Some(app)) = (m, app()) {
      let _ = crate::popup_menu(app, &w, &tpl);
    }
  }

  fn menu_run(mid: &str) {
    let (id, act) = {
      let s = state().lock().unwrap();
      match s.menu.get(mid) {
        Some(x) => x.clone(),
        None => return,
      }
    };
    let label = state().lock().unwrap().tabs.get(&id).map(|t| t.label.clone());
    let go = |action: &str| {
      if let Some(l) = &label {
        let _ = native("bv.go", json!({ "label": l, "action": action }));
      }
    };
    match act {
      Act::Back => go("back"),
      Act::Forward => go("forward"),
      Act::Reload => go("reload"),
      Act::NewTab(url) => send(json!({ "tabId": id, "kind": "newtab", "url": url })),
      Act::Copy(text) => copy_text(&text),
      Act::Agent(action, text) => {
        let mut p = json!({ "tabId": id, "kind": "agent-action", "action": action });
        if let Some(t) = text {
          p["text"] = Value::String(t);
        }
        send(p);
      }
      Act::Inspect | Act::Devtools => {
        if let Some(l) = &label {
          let _ = native("bv.devtools", json!({ "label": l }));
        }
      }
      Act::ZoomIn | Act::ZoomOut | Act::ZoomReset => {
        let cur = state().lock().unwrap().tabs.get(&id).map(|t| t.zoom).unwrap_or(1.0);
        set_zoom(&id, zoom_step(cur, &act));
      }
      Act::ToggleBookmark { url, title, on } => {
        let mut s = state().lock().unwrap();
        if on {
          store(&mut s).remove_bookmark(&Value::String(url));
        } else {
          let t = if title.is_empty() { url.clone() } else { title };
          store(&mut s).add_bookmark(json!({ "url": url, "title": t }));
        }
        changed(&mut s);
      }
    }
  }

  fn copy_text(text: &str) {
    use std::io::Write;
    if let Ok(mut c) = std::process::Command::new("/usr/bin/pbcopy")
      .env("LANG", "en_US.UTF-8")
      .stdin(std::process::Stdio::piped())
      .spawn()
    {
      if let Some(mut i) = c.stdin.take() {
        let _ = i.write_all(text.as_bytes());
      }
      let _ = c.wait();
    }
  }

  pub fn set_lang(l: &str) {
    state().lock().unwrap().ko = l != "en";
  }

  pub fn bar_menu_open(id: &str) {
    let mut s = state().lock().unwrap();
    let Some(t) = s.tabs.get(id) else { return };
    let (url, title) = (t.st.url.clone(), if t.st.title.is_empty() { t.st.url.clone() } else { t.st.title.clone() });
    let bm = store(&mut s).is_bookmarked(&url);
    let items = bar_menu(s.ko, &url, &title, bm);
    let m = popup(&mut s, id, items, app_window());
    drop(s);
    show_menu(m);
  }

  // ---- tabs ----

  pub fn create(id: &str, url: &str, partition: Option<&str>) {
    let Some(host) = app_window() else { return };
    let label = {
      let mut s = state().lock().unwrap();
      if s.tabs.contains_key(id) {
        return;
      }
      s.next += 1;
      let label = format!("bv-{}", s.next);
      s.by_label.insert(label.clone(), id.to_string());
      s.tabs.insert(
        id.to_string(),
        Tab { label: label.clone(), host: host.clone(), visible: None, st: ViewState::default(), started: false, zoom: 1.0, sent: String::new() },
      );
      label
    };
    let part = partition.filter(|p| !p.is_empty()).unwrap_or(PARTITION);
    if native("bv.create", json!({ "label": label, "host": host, "partition": part })).is_err() {
      let mut s = state().lock().unwrap();
      s.tabs.remove(id);
      s.by_label.remove(&label);
      return;
    }
    // The panel's sync can arrive before this view exists: show and place then
    // fail, and the panel does not repeat an unchanged frame. So forget what
    // was sent for this tab and send each panel's newest sync again.
    if let Some(t) = state().lock().unwrap().tabs.get_mut(id) {
      t.sent.clear();
    }
    replay_syncs();
    if !url.is_empty() {
      navigate(id, url);
    }
  }

  fn replay_syncs() {
    let replay: Vec<(String, Value)> = state().lock().unwrap().last_sync.values().cloned().collect();
    for (sender, a) in replay {
      sync(&sender, &a);
    }
  }

  pub fn navigate(id: &str, url: &str) {
    let label = {
      let mut s = state().lock().unwrap();
      let Some(t) = s.tabs.get_mut(id) else { return };
      t.started = true;
      t.label.clone()
    };
    if let Err(e) = native("bv.navigate", json!({ "label": label, "url": url })) {
      eprintln!("[browser] navigate: {e}");
    }
  }

  fn label_of(id: &str) -> Option<String> {
    state().lock().unwrap().tabs.get(id).map(|t| t.label.clone())
  }

  pub fn go(id: &str, action: &str) {
    if !matches!(action, "back" | "forward" | "reload" | "stop") {
      return;
    }
    if let Some(l) = label_of(id) {
      let _ = native("bv.go", json!({ "label": l, "action": action }));
    }
  }

  pub fn destroy(id: &str) {
    let t = {
      let mut s = state().lock().unwrap();
      let Some(t) = s.tabs.remove(id) else { return };
      s.by_label.remove(&t.label);
      t
    };
    let _ = native("bv.close", json!({ "label": t.label }));
  }

  // Show/hide and place one view; only changes cross to the native side.
  fn push(t: &mut Tab, on: bool, frame: Option<Rect>) {
    let shown = on && frame.is_some_and(|r| r.width > 0.0 && r.height > 0.0);
    let key = match (shown, frame) {
      (true, Some(r)) => format!("1:{},{},{},{}", r.x, r.y, r.width, r.height),
      _ => "0".to_string(),
    };
    if key == t.sent {
      return;
    }
    let was = t.sent.starts_with('1');
    let first = t.sent.is_empty();
    t.sent = key;
    if let (true, Some(r)) = (shown, frame) {
      let _ = native("bv.bounds", json!({ "label": t.label, "x": r.x, "y": r.y, "width": r.width, "height": r.height }));
    }
    if first || shown != was {
      let _ = native("bv.visible", json!({ "label": t.label, "on": shown }));
    }
  }

  fn attach(t: &mut Tab, w: &str) {
    if t.host == w {
      return;
    }
    if native("bv.reparent", json!({ "label": t.label, "host": w })).is_ok() {
      t.host = w.to_string();
      // A new window has never seen where or whether the view is.
      t.sent.clear();
    }
  }

  /// browser:sync. The panel reports its active tab and viewport rect; every
  /// other view it owns is hidden. `sender` is the window the message came from.
  pub fn sync(sender: &str, a: &Value) {
    let own: Vec<String> = a
      .get("own")
      .and_then(Value::as_array)
      .map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect())
      .unwrap_or_default();
    // Per panel, only the newest message counts (a pop-out lookup can finish
    // after a newer message from the same panel).
    let panel = own.join(",");
    let seq = {
      let mut s = state().lock().unwrap();
      let n = s.sync_seq.get(&panel).copied().unwrap_or(0) + 1;
      s.sync_seq.insert(panel.clone(), n);
      s.last_sync.insert(panel.clone(), (sender.to_string(), a.clone()));
      n
    };
    let host = a.get("host").and_then(Value::as_str).filter(|h| !h.is_empty()).map(String::from);
    let w = match host {
      Some(key) => match popout_window(&key) {
        Some(w) => w,
        None => return,
      },
      None => {
        if app().is_some_and(|ap| ap.get_window(sender).is_some()) {
          sender.to_string()
        } else {
          match app_window() {
            Some(w) => w,
            None => return,
          }
        }
      }
    };
    let mut s = state().lock().unwrap();
    if s.sync_seq.get(&panel) != Some(&seq) {
      return;
    }
    let show_id = if s.hidden_all { None } else { a.get("activeId").and_then(Value::as_str).map(String::from) };
    let rect = a.get("rect").and_then(Rect::from_json);
    let css = a.get("css").and_then(|c| Some((c.get("w")?.as_f64()?, c.get("h")?.as_f64()?)));
    let content = app().and_then(|ap| ap.get_window(&w)).and_then(|win| {
      let k = win.scale_factor().ok()?;
      let sz = win.inner_size().ok()?.to_logical::<f64>(k);
      Some((sz.width, sz.height))
    });
    let css = if content.is_some() { css } else { None };
    let frame = rect.map(|r| place(r, css, content.unwrap_or((0.0, 0.0))));
    let mine: Option<std::collections::HashSet<&String>> = if own.is_empty() { None } else { Some(own.iter().collect()) };
    let ids: Vec<String> = s.tabs.keys().cloned().collect();
    for id in ids {
      // Not ours to touch: another workspace's panel owns that view.
      if mine.as_ref().is_some_and(|m| !m.contains(&id)) && Some(&id) != show_id.as_ref() {
        continue;
      }
      let on = Some(&id) == show_id.as_ref() && rect.is_some();
      let t = s.tabs.get_mut(&id).unwrap();
      t.visible = Some(on);
      if on {
        attach(t, &w);
      }
      push(t, on, if on { frame } else { None });
    }
  }

  // The renderer's modal guard. Lifting it only clears the flag: the panel does
  // not re-send its rect, so the views would stay hidden until something else
  // moved. Replay each panel's newest sync instead.
  pub fn hide_all(hidden: bool) {
    let replay: Vec<(String, Value)> = {
      let mut s = state().lock().unwrap();
      s.hidden_all = hidden;
      if hidden {
        for t in s.tabs.values_mut() {
          push(t, false, None);
        }
        return;
      }
      s.last_sync.values().cloned().collect()
    };
    for (sender, a) in replay {
      sync(&sender, &a);
    }
  }

  // ---- pop-outs ----

  // A browser panel popped out is still drawn by riven's page: the pop-out is a
  // document it renders into, marked with a key (window.__rivenPopout). The
  // view moves into the window that carries the key.
  fn popout_window(key: &str) -> Option<String> {
    let app = app()?;
    if let Some(w) = state().lock().unwrap().popouts.get(key).cloned() {
      if app.get_window(&w).is_some() {
        return Some(w);
      }
    }
    let mut labels: Vec<String> = app.windows().into_keys().filter(|l| l.starts_with("pop-")).collect();
    labels.sort();
    for l in labels {
      let r = native("wv.exec", json!({ "label": l, "code": "window.__rivenPopout || null", "expr": true }));
      let Ok(Value::String(text)) = r else { continue };
      let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
      if v.get("v").and_then(Value::as_str) == Some(key) {
        state().lock().unwrap().popouts.insert(key.to_string(), l.clone());
        return Some(l);
      }
    }
    None
  }

  /// A window is closing (a pop-out's first close, or its destroy; not on the
  /// main thread): its
  /// views go back to riven's window, hidden, until their panel says where it
  /// is; every panel is asked to say so once more.
  pub fn host_closing(label: &str) {
    let mut s = state().lock().unwrap();
    s.popouts.retain(|_, w| w != label);
    let home = app_window().filter(|h| h != label);
    let mut moved = false;
    for t in s.tabs.values_mut() {
      if t.host != label {
        continue;
      }
      push(t, false, None);
      t.visible = Some(false);
      if let Some(h) = &home {
        attach(t, h);
        moved = true;
      }
    }
    if moved {
      send(json!({ "kind": "resync" }));
    }
  }

  /// The window is gone and took its child views with it.
  fn host_destroyed(label: &str) {
    let mut s = state().lock().unwrap();
    s.popouts.retain(|_, w| w != label);
    let gone: Vec<String> = s.tabs.iter().filter(|(_, t)| t.host == label).map(|(id, _)| id.clone()).collect();
    for id in gone {
      if let Some(t) = s.tabs.remove(&id) {
        s.by_label.remove(&t.label);
      }
    }
    if s.suggest_parent.as_deref() == Some(label) {
      s.suggest_parent = None;
    }
  }

  // ---- page scripts ----

  /// browser:execJs: the value, or "error: <message>" (as Electron's
  /// executeJavaScript rejection was reported). An expression is awaited.
  pub fn exec_js(id: &str, code: &str) -> Value {
    let Some(label) = label_of(id) else { return Value::Null };
    match exec(&label, code) {
      Ok(v) => v,
      Err(e) => Value::String(format!("error: {e}")),
    }
  }

  fn exec(label: &str, code: &str) -> Result<Value, String> {
    let r = native("wv.exec", json!({ "label": label, "code": code, "expr": "auto" }))?;
    let text = r.as_str().unwrap_or("{\"u\":1}");
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(v.get("v").cloned().unwrap_or(Value::Null))
  }

  fn snapshot(label: &str, rect: Option<Rect>, zoom: f64) -> Option<String> {
    // rect is in CSS px of the page; the snapshot wants the view's points.
    let r = rect.map(|r| json!({ "x": r.x * zoom, "y": r.y * zoom, "width": r.width * zoom, "height": r.height * zoom }));
    let b64 = native("wv.capture", json!({ "label": label, "rect": r })).ok()?;
    Some(format!("data:image/png;base64,{}", b64.as_str()?))
  }

  pub fn capture(id: &str) -> Value {
    let Some((label, zoom)) = state().lock().unwrap().tabs.get(id).map(|t| (t.label.clone(), t.zoom)) else {
      return Value::Null;
    };
    snapshot(&label, None, zoom).map(Value::String).unwrap_or(Value::Null)
  }

  pub fn tab_state(id: &str) -> Value {
    let s = state().lock().unwrap();
    let Some(t) = s.tabs.get(id) else { return Value::Null };
    json!({
      "url": t.st.url,
      "title": if t.st.title.is_empty() { &t.st.url } else { &t.st.title },
      "loading": t.st.loading,
      "canGoBack": t.st.back,
      "canGoForward": t.st.fwd,
      "zoom": t.zoom,
    })
  }

  pub fn set_zoom(id: &str, factor: f64) {
    let label = {
      let mut s = state().lock().unwrap();
      let Some(t) = s.tabs.get_mut(id) else { return };
      t.zoom = factor;
      t.label.clone()
    };
    let _ = native("bv.zoom", json!({ "label": label, "factor": factor }));
  }

  // WebKit has no find-bar API worth the trouble; window.find selects and
  // scrolls to the next match (wrapping).
  pub fn find(id: &str, text: &str) {
    let Some(label) = label_of(id) else { return };
    let code = if text.is_empty() {
      "void (getSelection() && getSelection().removeAllRanges())".to_string()
    } else {
      format!("window.find({}, false, false, true)", Value::String(text.to_string()))
    };
    std::thread::spawn(move || {
      let _ = exec(&label, &code);
    });
  }

  pub fn open_devtools(id: &str) {
    if let Some(l) = label_of(id) {
      let _ = native("bv.devtools", json!({ "label": l }));
    }
  }

  /// browser:pickElement: the element the person clicks, its selector, a bit
  /// of its markup and a snapshot of it. Esc gives null.
  pub fn pick_element(id: &str) -> Value {
    let Some((label, zoom)) = state().lock().unwrap().tabs.get(id).map(|t| (t.label.clone(), t.zoom)) else {
      return Value::Null;
    };
    let picked = match exec(&label, PICK_SCRIPT) {
      Ok(v) if v.is_object() => v,
      _ => return Value::Null,
    };
    let data = snapshot(&label, Some(pick_rect(&picked)), zoom);
    json!({ "dataUrl": data, "selector": picked.get("selector"), "html": picked.get("html") })
  }

  // ---- the suggestion list ----

  pub fn suggest(sender: &str, a: &Value) {
    let app = match app() {
      Some(a) => a,
      None => return,
    };
    let parent = if app.get_window(sender).is_some() { Some(sender.to_string()) } else { app_window() };
    let Some(parent) = parent else { return };
    let rect = a.get("rect").and_then(Rect::from_json);
    let items: Vec<(String, String)> = a
      .get("items")
      .and_then(Value::as_array)
      .map(|v| {
        v.iter()
          .map(|it| {
            let g = |k: &str| it.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            (g("url"), g("title"))
          })
          .collect()
      })
      .unwrap_or_default();
    let (Some(rect), false) = (rect, items.is_empty()) else {
      close_suggest();
      return;
    };
    let sel = a.get("selected").and_then(Value::as_i64).unwrap_or(-1);
    {
      let mut s = state().lock().unwrap();
      s.suggest_parent = Some(parent.clone());
      s.suggest_sender = Some(sender.to_string());
    }
    let Some(pw) = app.get_window(&parent) else { return };
    let k = pw.scale_factor().unwrap_or(1.0);
    let origin = pw.inner_position().map(|p| p.to_logical::<f64>(k)).map(|p| (p.x, p.y)).unwrap_or((0.0, 0.0));
    // riven's UI zoom (the CSS px -> window px scale browser.ts read off the page).
    let zoom = ui_zoom(&parent);
    let html = suggest_html(&items, sel, zoom);
    let frame = suggest_frame(origin, rect, zoom, rect.height);
    let _ = crate::suggest_window(app, &parent, frame, &html, zoom);
  }

  fn ui_zoom(label: &str) -> f64 {
    let Some(app) = app() else { return 1.0 };
    let Some(w) = app.get_window(label) else { return 1.0 };
    let k = w.scale_factor().unwrap_or(1.0);
    let inner = match w.inner_size() {
      Ok(sz) => sz.to_logical::<f64>(k).width,
      Err(_) => return 1.0,
    };
    match native("wv.exec", json!({ "label": label, "code": "innerWidth", "expr": true })) {
      Ok(Value::String(t)) => serde_json::from_str::<Value>(&t)
        .ok()
        .and_then(|v| v.get("v").and_then(Value::as_f64))
        .filter(|w| *w > 0.0)
        .map(|css| inner / css)
        .unwrap_or(1.0),
      _ => 1.0,
    }
  }

  pub fn close_suggest() {
    if let Some(app) = app() {
      crate::suggest_hide(app);
    }
  }

  /// The list belongs to a moment in its parent: a parent that moves,
  /// resizes, hides or loses focus closes it.
  fn parent_changed(label: &str) {
    let is_parent = state().lock().unwrap().suggest_parent.as_deref() == Some(label);
    if is_parent {
      close_suggest();
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn st(url: &str, title: &str, loading: bool) -> ViewState {
    ViewState { url: url.into(), title: title.into(), loading, back: false, fwd: false }
  }

  #[test]
  fn diff_follows_electron_events() {
    let a = st("", "", false);
    let b = st("http://x/", "", true);
    assert_eq!(diff(&a, &b, "start"), vec![Out::Loading(true), Out::Nav]);
    let c = st("http://x/", "", true);
    assert_eq!(diff(&b, &c, "commit"), vec![Out::Nav]);
    let d = st("http://x/", "X", true);
    assert_eq!(diff(&c, &d, "title"), vec![Out::Title("X".into())]);
    let e = st("http://x/", "X", false);
    assert_eq!(diff(&d, &e, "finish"), vec![Out::Stopped]);
    assert_eq!(diff(&e, &e, "poll"), vec![]);
    let f = st("http://x/#a", "X", false);
    assert_eq!(diff(&e, &f, "nav"), vec![Out::Nav]);
  }

  #[test]
  fn place_matches_browser_ts() {
    // UI zoom 1.2 (css 1111.67 wide in a 1334 window), the scenario's numbers.
    let r = place(Rect { x: 100.0, y: 80.0, width: 600.0, height: 400.0 }, Some((1000.0, 800.0)), (1200.0, 960.0));
    assert_eq!(r, Rect { x: 122.0, y: 96.0, width: 716.0, height: 478.0 });
    let r = place(Rect { x: 50.4, y: 60.6, width: 333.3, height: 222.7 }, None, (0.0, 0.0));
    assert_eq!(r, Rect { x: 51.0, y: 61.0, width: 331.0, height: 222.0 });
    // Math.round(2.5) = 3, Math.round(-2.5) = -2.
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(-2.5), -2.0);
    let tiny = place(Rect { x: 0.0, y: 0.0, width: 1.0, height: 0.0 }, None, (0.0, 0.0));
    assert_eq!((tiny.width, tiny.height), (1.0, 1.0));
  }

  #[test]
  fn store_keeps_browser_ts_rules() {
    let mut s = Store::parse(Some(r#"{"bookmarks":[{"url":"a","title":"A"}],"history":[],"extra":1}"#));
    s.add_bookmark(json!({ "url": "b", "title": "B" }));
    s.add_bookmark(json!({ "url": "a", "title": "dup" }));
    assert_eq!(s.bookmarks(), json!([{ "url": "b", "title": "B" }, { "url": "a", "title": "A" }]));
    s.remove_bookmark(&json!("a"));
    assert_eq!(s.bookmarks(), json!([{ "url": "b", "title": "B" }]));
    assert!(!s.record("file:///x", "t", 1.0));
    assert!(s.record("HTTPS://y/", "", 2.0));
    assert!(s.record("http://z/", "Z", 3.0));
    assert!(s.record("HTTPS://y/", "Y", 4.0));
    assert_eq!(s.history(), json!([{ "url": "HTTPS://y/", "title": "Y", "ts": 4.0 }, { "url": "http://z/", "title": "Z", "ts": 3.0 }]));
    for i in 0..600 {
      s.record(&format!("http://h/{i}"), "", i as f64);
    }
    assert_eq!(s.list("history").len(), 500);
    assert_eq!(s.history().as_array().unwrap().len(), 100);
    assert!(s.text().contains("\"extra\":1"));
    s.clear_history();
    assert_eq!(s.history(), json!([]));
    let bad = Store::parse(Some("not json"));
    assert_eq!(bad.text(), r#"{"bookmarks":[],"history":[]}"#);
  }

  #[test]
  fn menus_match_browser_ts() {
    let labels = |m: &[Item]| -> Vec<String> {
      m.iter()
        .map(|i| match i {
          Item::Act(l, e, _) => format!("{l}{}", if *e { "" } else { "(off)" }),
          Item::Role(l, r) => format!("{l}[{r}]"),
          Item::Sep => "-".into(),
        })
        .collect()
    };
    let none = Ctx { link: String::new(), src: String::new(), image: false, selection: String::new(), editable: false };
    assert_eq!(
      labels(&context_menu(false, false, true, &none)).join("|"),
      "Back(off)|Forward|Reload|-|-|Send screenshot to chat|Pick an element to send|-|Inspect element"
    );
    let all = Ctx { link: "l".into(), src: "s".into(), image: true, selection: "x".into(), editable: true };
    assert_eq!(
      labels(&context_menu(true, true, false, &all)).join("|"),
      "뒤로|앞으로(off)|새로고침|-|링크 새 탭에서 열기|링크 주소 복사|이미지 주소 복사|복사[copy]|선택 영역 채팅으로 보내기|잘라내기[cut]|붙여넣기[paste]|모두 선택[selectAll]|-|스크린샷 채팅으로 보내기|요소 선택해서 보내기|-|검사"
    );
    assert_eq!(
      labels(&bar_menu(false, "about:blank", "", false)).join("|"),
      "Zoom in|Zoom out|Reset zoom|-|Find in page|Add bookmark(off)|DevTools|-|Send screenshot to chat|Pick an element to send"
    );
    assert_eq!(labels(&bar_menu(true, "https://a/", "", true))[5], "즐겨찾기 삭제");
    assert!((zoom_step(1.0, &Act::ZoomIn) - 1.1).abs() < 1e-9);
    assert_eq!(zoom_step(2.95, &Act::ZoomIn), 3.0);
    assert_eq!(zoom_step(0.45, &Act::ZoomOut), 0.4);
    assert_eq!(zoom_step(2.0, &Act::ZoomReset), 1.0);
  }

  #[test]
  fn suggest_parts() {
    let h = suggest_html(&[("http://a/?x=<1>".into(), "".into()), ("u".into(), "T&\"".into())], 1, 1.25);
    assert!(h.contains("<div class=\"i\" data-i=\"0\"><span class=\"t\">http://a/?x=&lt;1&gt;</span>"));
    assert!(h.contains("<div class=\"i on\" data-i=\"1\"><span class=\"t\">T&amp;&quot;</span>"));
    assert!(h.contains("zoom:1.25;"));
    assert_eq!(suggest_pick("pick:3:1700000000000"), Some(3));
    assert_eq!(suggest_pick("pick::1"), None);
    assert_eq!(suggest_pick("hello"), None);
    let f = suggest_frame((10.0, 20.0), Rect { x: 5.0, y: 6.0, width: 50.0, height: 10.0 }, 1.2, 10.0);
    assert_eq!(f, Rect { x: 16.0, y: 27.0, width: 80.0, height: 24.0 });
    assert_eq!(pick_rect(&json!({ "x": -3.2, "y": 4.5, "width": 0.2, "height": 10.49 })), Rect { x: 0.0, y: 5.0, width: 1.0, height: 10.0 });
    assert_eq!(file_name("/Users/a/Downloads/x.zip"), "x.zip");
  }
}
