// Desktop notifications (src/main/notify.ts), decided and posted here.
//
// The plan is notify.ts's, unchanged: each app window reports its presence
// (visible, focused, active pane, last touched); a notification is
//   1. dropped when a present, visible, focused window already shows that pane,
//   2. otherwise aimed at the most recently active present window,
//   3. still shown when nobody is present (a desktop app has no other channel),
// with a 5s per-target cooldown. A click lands on the chosen window and tells
// its page which pane (the 'notify:click' event), exactly as Electron did.
//
// Posting is UNUserNotificationCenter (mac.rs below), so the banner carries the
// app's own icon and name and a click comes back through the center's
// delegate. That needs a real .app bundle with a bundle identifier: the
// packaged app is one, and tauri/run.sh wraps the dev binary in one
// (target/debug/riven-tauri.app). A bare binary has neither, and asking for
// the notification center there throws, so it falls back to `osascript
// display notification` (Script Editor's icon, a click can't be seen).

use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

pub const PRESENCE_THRESHOLD_MS: f64 = 180_000.0;
const COOLDOWN_MS: f64 = 5_000.0;
// Clicks we still route. Notification Center keeps old banners around, so a
// click can come long after the post; this only bounds the map.
const PENDING_MAX: usize = 200;

#[derive(Clone, Debug, PartialEq)]
pub struct Presence {
  pub visible: bool,
  pub focused: bool,
  pub active_pane: Option<String>,
  pub at: f64,
}

#[derive(Debug, PartialEq)]
pub struct Plan {
  pub recipient: Option<usize>,
  pub suppressed: bool,
}

/// notify.ts computePlan: given every window's presence (in the order the
/// windows first reported), who (if anyone) hears about `pane`.
pub fn compute_plan(states: &[Presence], pane: Option<&str>, now: f64) -> Plan {
  let mut best = None;
  let mut best_at = f64::NEG_INFINITY;
  for (i, s) in states.iter().enumerate() {
    let at = s.at.min(now);
    if now - at > PRESENCE_THRESHOLD_MS {
      continue;
    }
    if s.visible && s.focused && pane.is_some() && s.active_pane.as_deref() == pane {
      return Plan { recipient: None, suppressed: true };
    }
    if at > best_at {
      best = Some(i);
      best_at = at;
    }
  }
  Plan { recipient: best, suppressed: false }
}

/// notify.ts reserveCooldown. `recent` keeps insertion order like a JS Map (a
/// reserved key moves to the end) and is pruned so pane churn can't grow it.
pub fn reserve_cooldown(recent: &mut Vec<(String, f64)>, key: &str, now: f64) -> bool {
  let pos = recent.iter().position(|(k, _)| k == key);
  let last = pos.map(|i| recent[i].1).unwrap_or(0.0);
  if now - last < COOLDOWN_MS {
    return false;
  }
  if let Some(i) = pos {
    recent.remove(i);
  }
  recent.push((key.to_string(), now));
  if recent.len() > 64 {
    let mut i = 0;
    while i < recent.len() && recent.len() > 64 {
      if now - recent[i].1 >= COOLDOWN_MS {
        recent.remove(i);
      } else {
        i += 1;
      }
    }
  }
  true
}

#[derive(Default, Clone, Copy)]
struct Stats {
  requested: u64,
  suppressed: u64,
  cooled: u64,
  shown: u64,
  failed: u64,
  clicked: u64,
}

enum Click {
  // notify:show: focus `label` and tell its page about `pane`.
  Pane { label: Option<String>, pane: Option<String> },
  // "Update ready" (services/update): a click installs it.
  Update,
}

#[derive(Default)]
struct State {
  presence: Vec<(String, Presence)>,
  recent: Vec<(String, f64)>,
  stats: Stats,
  pending: Vec<(String, Click)>,
  next: u64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
  let mut g = STATE.lock().unwrap();
  f(g.get_or_insert_with(State::default))
}

fn debug() -> bool {
  static D: OnceLock<bool> = OnceLock::new();
  *D.get_or_init(|| std::env::var("RIVEN_NOTIFY_DEBUG").as_deref() == Ok("1"))
}

fn trace(what: &str, pane: Option<&str>, title: &str) {
  if debug() {
    eprintln!("[notify] {what} pane={} title={title}", pane.unwrap_or("-"));
  }
}

fn now_ms() -> f64 {
  crate::services::chat::util::now_ms()
}

/// Startup: route clicks back here, and (unless `quiet`, the background test
/// mode) ask for permission so macOS lists the app under System Settings >
/// Notifications before the first real one is needed. notify.ts did the
/// second with a silent probe notification; asking is what that probe caused.
pub fn init(app: &AppHandle, quiet: bool) {
  let _ = APP.set(app.clone());
  #[cfg(target_os = "macos")]
  mac::init(app, quiet);
  #[cfg(not(target_os = "macos"))]
  let _ = quiet;
}

// ---- the page's channels -----------------------------------------------------

fn str_field(v: &Value, k: &str) -> Option<String> {
  v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// notify:presence from the window `label`.
pub fn presence(label: &str, p: &Value) {
  let now = now_ms();
  let pr = Presence {
    visible: p.get("visible").and_then(Value::as_bool).unwrap_or(false),
    focused: p.get("focused").and_then(Value::as_bool).unwrap_or(false),
    active_pane: str_field(p, "activePane"),
    at: p.get("at").and_then(Value::as_f64).unwrap_or(now).min(now),
  };
  with(|s| match s.presence.iter_mut().find(|(l, _)| l == label) {
    Some(e) => e.1 = pr,
    None => s.presence.push((label.to_string(), pr)),
  });
}

/// A window is gone: it is nobody's recipient any more.
pub fn forget(label: &str) {
  with(|s| s.presence.retain(|(l, _)| l != label));
}

pub fn diag() -> Value {
  let st = with(|s| s.stats);
  json!({
    "requested": st.requested, "suppressed": st.suppressed, "cooled": st.cooled,
    "shown": st.shown, "failed": st.failed, "clicked": st.clicked
  })
}

fn window_exists(label: &str) -> bool {
  APP.get().is_some_and(|a| a.get_window(label).is_some())
}

// appWindow(): riven's own window, the first app window still open.
fn app_window() -> Option<String> {
  let app = APP.get()?;
  let mut ws: Vec<(u64, String)> = app
    .windows()
    .into_keys()
    .filter(|l| l.starts_with('w') && l.len() > 1 && l[1..].chars().all(|c| c.is_ascii_digit()))
    .map(|l| (l[1..].parse().unwrap_or(u64::MAX), l))
    .collect();
  ws.sort();
  ws.into_iter().next().map(|(_, l)| l)
}

fn next_id(s: &mut State, click: Click) -> String {
  s.next += 1;
  let id = format!("riven-{}-{}", std::process::id(), s.next);
  s.pending.push((id.clone(), click));
  if s.pending.len() > PENDING_MAX {
    let drop = s.pending.len() - PENDING_MAX;
    s.pending.drain(..drop);
  }
  id
}

/// notify:show from the window `sender`.
pub fn show(sender: &str, req: &Value) {
  let title = str_field(req, "title").unwrap_or_default();
  let body = str_field(req, "body").unwrap_or_default();
  let pane = str_field(req, "paneId");
  let now = now_ms();
  let id = with(|s| {
    s.stats.requested += 1;
    let states: Vec<Presence> = s.presence.iter().map(|(_, p)| p.clone()).collect();
    let plan = compute_plan(&states, pane.as_deref(), now);
    if plan.suppressed {
      s.stats.suppressed += 1;
      trace("suppressed (user is on that pane)", pane.as_deref(), &title);
      return None;
    }
    let key = pane.clone().unwrap_or_else(|| title.clone());
    if !reserve_cooldown(&mut s.recent, &key, now) {
      s.stats.cooled += 1;
      trace("cooled down", pane.as_deref(), &title);
      return None;
    }
    // Land the click on the window the plan picked, else the sender, else any.
    let recipient = plan.recipient.map(|i| s.presence[i].0.clone());
    let label = recipient
      .filter(|l| window_exists(l))
      .or_else(|| window_exists(sender).then(|| sender.to_string()))
      .or_else(app_window);
    Some(next_id(s, Click::Pane { label, pane: pane.clone() }))
  });
  let Some(id) = id else { return };
  let (pid, ptitle) = (id.clone(), title.clone());
  post(&pid, &ptitle, "", &body, false, move |r| {
    with(|s| match &r {
      Ok(()) => s.stats.shown += 1,
      Err(_) => s.stats.failed += 1,
    });
    match r {
      Ok(()) => trace("shown", pane.as_deref(), &title),
      Err(e) => {
        eprintln!("[notify] failed to show: {e}");
        trace("FAILED to display", pane.as_deref(), &title);
        with(|s| s.pending.retain(|(i, _)| i != &id));
      }
    }
  });
}

/// update.ts's "update ready" notification.
pub fn post_update(title: &str, body: &str) -> Result<(), String> {
  if crate::background() {
    return Ok(());
  }
  let id = with(|s| next_id(s, Click::Update));
  post(&id, title, "", body, false, |_| {});
  Ok(())
}

fn post(id: &str, title: &str, subtitle: &str, body: &str, silent: bool, done: impl FnOnce(Result<(), String>) + Send + 'static) {
  #[cfg(target_os = "macos")]
  if mac::available() {
    mac::post(id, title, subtitle, body, silent, done);
    return;
  }
  done(osascript(title, subtitle, body, silent));
}

// No bundle (a bare `cargo run` binary) or not macOS: the old way. It shows
// under Script Editor's name and icon, and a click can't be observed.
fn osascript(title: &str, subtitle: &str, body: &str, silent: bool) -> Result<(), String> {
  if !cfg!(target_os = "macos") {
    return Err("notifications are not supported on this platform".into());
  }
  let q = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
  let title = if title.is_empty() { "riven" } else { title };
  let mut script = format!("display notification {} with title {}", q(body), q(title));
  if !subtitle.is_empty() {
    script.push_str(&format!(" subtitle {}", q(subtitle)));
  }
  if !silent {
    script.push_str(" sound name \"default\"");
  }
  std::process::Command::new("/usr/bin/osascript")
    .args(["-e", &script])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map(|mut c| {
      // Reap it off this thread; it ends as soon as the banner is queued.
      std::thread::spawn(move || {
        let _ = c.wait();
      });
    })
    .map_err(|e| format!("osascript: {e}"))
}

/// The delegate saw a click on notification `id` (any thread).
fn clicked(id: &str) {
  let click = with(|s| {
    let i = s.pending.iter().position(|(p, _)| p == id)?;
    Some(s.pending.remove(i).1)
  });
  match click {
    Some(Click::Pane { label, pane }) => {
      with(|s| s.stats.clicked += 1);
      trace("clicked", pane.as_deref(), "");
      // Window calls go through the event loop; never block the delegate.
      std::thread::spawn(move || focus(label, pane));
    }
    Some(Click::Update) => {
      std::thread::spawn(super::update::install);
    }
    None => {}
  }
}

// notify.ts's click: restore, show and focus the window, then tell its page.
fn focus(label: Option<String>, pane: Option<String>) {
  let Some(app) = APP.get() else { return };
  let Some(label) = label else { return };
  let Some(w) = app.get_window(&label) else { return };
  if !crate::background() {
    if w.is_minimized().unwrap_or(false) {
      let _ = w.unminimize();
    }
    crate::lifecycle::note("notification click");
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let _ = w.show();
    let _ = w.set_focus();
  }
  if let Some(pane) = pane {
    crate::commands::emit_ipc(app, &label, "notify:click", json!([pane]));
  }
}

// ---- macOS: UNUserNotificationCenter -------------------------------------------

#[cfg(target_os = "macos")]
mod mac {
  use block2::RcBlock;
  use objc2::rc::Retained;
  use objc2::runtime::{Bool, ProtocolObject};
  use objc2::{define_class, msg_send, AllocAnyThread};
  use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
  use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
  };
  use std::sync::OnceLock;
  use tauri::AppHandle;

  define_class!(
    #[unsafe(super(NSObject))]
    #[name = "RivenNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
      // Electron shows banners while the app is frontmost too; the plan has
      // already dropped the ones about the pane the user is looking at.
      #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
      fn will_present(
        &self,
        _center: &UNUserNotificationCenter,
        _n: &UNNotification,
        done: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
      ) {
        done.call((UNNotificationPresentationOptions::Banner
          | UNNotificationPresentationOptions::List
          | UNNotificationPresentationOptions::Sound,));
      }

      #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
      fn did_receive(
        &self,
        _center: &UNUserNotificationCenter,
        response: &UNNotificationResponse,
        done: &block2::DynBlock<dyn Fn()>,
      ) {
        // Default action (the banner itself) only; a dismiss is not a click.
        let action = response.actionIdentifier().to_string();
        if action == "com.apple.UNNotificationDefaultActionIdentifier" {
          let id = response.notification().request().identifier().to_string();
          super::clicked(&id);
        }
        done.call(());
      }
    }
  );

  impl Delegate {
    fn new() -> Retained<Self> {
      let this = Self::alloc().set_ivars(());
      unsafe { msg_send![super(this), init] }
    }
  }

  /// A real bundle (an .app with an identifier). Without one,
  /// currentNotificationCenter raises ("bundleProxyForCurrentProcess is nil").
  pub fn available() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
      let b = NSBundle::mainBundle();
      let path = b.bundlePath().to_string();
      let ok = b.bundleIdentifier().is_some_and(|i| !i.to_string().is_empty()) && path.ends_with(".app");
      if !ok {
        eprintln!("[notify] not running from an .app bundle ({path}); using osascript, clicks won't be seen");
      }
      ok
    })
  }

  fn center() -> Retained<UNUserNotificationCenter> {
    UNUserNotificationCenter::currentNotificationCenter()
  }

  pub fn init(_app: &AppHandle, quiet: bool) {
    if !available() {
      return;
    }
    // The center holds its delegate weakly: this one lives as long as the app.
    let d = Delegate::new();
    center().setDelegate(Some(ProtocolObject::from_ref(&*d)));
    std::mem::forget(d);
    if quiet {
      return;
    }
    let block = RcBlock::new(|granted: Bool, err: *mut NSError| {
      if !granted.as_bool() {
        let why = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string()).unwrap_or_default();
        eprintln!("[notify] not allowed to notify {why}");
      }
    });
    center().requestAuthorizationWithOptions_completionHandler(
      UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
      &block,
    );
  }

  pub fn post(
    id: &str,
    title: &str,
    subtitle: &str,
    body: &str,
    silent: bool,
    done: impl FnOnce(Result<(), String>) + Send + 'static,
  ) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    if !subtitle.is_empty() {
      content.setSubtitle(&NSString::from_str(subtitle));
    }
    content.setBody(&NSString::from_str(body));
    if !silent {
      content.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
    // Called once by the center; the Mutex makes the FnOnce callable from a Fn block.
    let done = std::sync::Mutex::new(Some(done));
    let block = RcBlock::new(move |err: *mut NSError| {
      let Some(f) = done.lock().unwrap().take() else { return };
      match unsafe { err.as_ref() } {
        None => f(Ok(())),
        Some(e) => f(Err(format!(
          "{} ({} {})",
          e.localizedDescription(),
          e.domain(),
          e.code()
        ))),
      }
    });
    center().addNotificationRequest_withCompletionHandler(&req, Some(&block));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const NOW: f64 = 1_000_000.0;
  fn present() -> Presence {
    Presence { visible: true, focused: true, active_pane: None, at: NOW }
  }
  fn on(p: &str) -> Presence {
    Presence { active_pane: Some(p.into()), ..present() }
  }

  #[test]
  fn suppresses_when_focused_on_that_pane() {
    assert_eq!(compute_plan(&[on("term-3")], Some("term-3"), NOW), Plan { recipient: None, suppressed: true });
  }

  #[test]
  fn unfocused_window_on_that_pane_still_hears() {
    let p = Presence { focused: false, ..on("term-3") };
    assert_eq!(compute_plan(&[p], Some("term-3"), NOW), Plan { recipient: Some(0), suppressed: false });
  }

  #[test]
  fn picks_most_recent_present_window() {
    let s = [
      Presence { at: NOW - 50_000.0, ..present() },
      Presence { at: NOW - 1_000.0, ..present() },
      Presence { at: NOW - 20_000.0, ..present() },
    ];
    assert_eq!(compute_plan(&s, Some("term-1"), NOW).recipient, Some(1));
  }

  #[test]
  fn idle_window_is_not_a_recipient() {
    let s = [Presence { at: NOW - PRESENCE_THRESHOLD_MS - 1.0, ..present() }];
    assert_eq!(compute_plan(&s, Some("term-1"), NOW), Plan { recipient: None, suppressed: false });
  }

  #[test]
  fn clock_ahead_is_clamped() {
    let s = [Presence { at: NOW + 999_999.0, ..present() }];
    assert_eq!(compute_plan(&s, Some("term-1"), NOW).recipient, Some(0));
  }

  #[test]
  fn different_pane_still_hears() {
    assert_eq!(compute_plan(&[on("chat-9")], Some("term-3"), NOW), Plan { recipient: Some(0), suppressed: false });
  }

  #[test]
  fn no_pane_is_never_suppressed() {
    assert_eq!(compute_plan(&[on("term-7")], None, NOW), Plan { recipient: Some(0), suppressed: false });
  }

  #[test]
  fn cooldown() {
    let mut m = Vec::new();
    assert!(reserve_cooldown(&mut m, "term-1", NOW));
    assert!(!reserve_cooldown(&mut m, "term-1", NOW + 100.0));
    assert!(reserve_cooldown(&mut m, "term-2", NOW + 100.0));
    assert!(reserve_cooldown(&mut m, "term-1", NOW + 5_001.0));
  }

  #[test]
  fn cooldown_map_is_bounded() {
    let mut m = Vec::new();
    for i in 0..200 {
      reserve_cooldown(&mut m, &format!("k{i}"), NOW + f64::from(i) * 10_000.0);
    }
    assert!(m.len() <= 65);
  }
}
