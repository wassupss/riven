// The browser panel's pages: Electron WebContentsViews, here child WKWebViews
// of the app window (tauri/shim/views.ts is the Node side).
//
// A page is untrusted web content, so it gets nothing of ours. What we need
// from inside it (Cmd/Ctrl chords, the right-click target, in-page URL
// changes) is gathered by a script that runs in its own WKContentWorld, and
// is posted to a message handler registered in that world only: the page's
// own scripts can neither see the handler nor call it, and only trusted
// (user-made) events are reported. Script results come back through
// WebKit's completion handlers, not through anything the page can reach.
//
// Every hook (navigation, load, title, the content-world messages) reports the
// view's state as WebKit has it (url, title, isLoading, back/forward); Node
// turns the differences into Electron's events.

use super::{b, base64_encode, emit, f, s, Res};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{
  NSArray, NSData, NSDictionary, NSError, NSJSONSerialization, NSJSONWritingOptions, NSObject, NSObjectProtocol,
  NSString,
};
use objc2_web_kit::{
  WKContentWorld, WKScriptMessage, WKScriptMessageHandler, WKSnapshotConfiguration, WKUserContentController,
  WKUserScript, WKUserScriptInjectionTime, WKWebView,
};
use serde_json::{json, Value};
use std::sync::mpsc;
use std::time::Duration;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Wry};

const WORLD: &str = "riven-browser";
const HANDLER: &str = "rivenBrowser";

// Runs in the isolated world, in every frame. Reports only trusted events.
const WORLD_SCRIPT: &str = r#"(() => {
  const h = window.webkit && webkit.messageHandlers && webkit.messageHandlers.rivenBrowser
  if (!h) return
  const post = (m) => { try { h.postMessage(JSON.stringify(m)) } catch (e) {} }
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || !(e.metaKey || e.ctrlKey)) return
    post({ t: 'key', key: e.key, code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })
  }, true)
  // Bubble phase on window: a page that draws its own menu has already said so.
  addEventListener('contextmenu', (e) => {
    if (!e.isTrusted || e.defaultPrevented) return
    e.preventDefault()
    const el = e.target && e.target.nodeType === 1 ? e.target : null
    const a = el && el.closest('a[href]')
    const img = el && el.tagName === 'IMG' ? el : null
    const ed = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
    post({
      t: 'ctx', x: e.clientX, y: e.clientY,
      linkURL: a ? a.href : '', srcURL: img ? (img.currentSrc || img.src) : '',
      mediaType: img ? 'image' : 'none', selectionText: String(getSelection() || ''), isEditable: ed
    })
  })
  if (window.top !== window) return
  let last = location.href
  const nav = () => { if (location.href !== last) { last = location.href; post({ t: 'nav' }) } }
  addEventListener('popstate', nav)
  addEventListener('hashchange', nav)
  if (window.navigation) navigation.addEventListener('currententrychange', () => setTimeout(nav, 0))
  const icon = () => {
    if (!/^https?:$/.test(location.protocol)) return
    const l = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
    post({ t: 'favicon', url: l && l.href ? l.href : location.origin + '/favicon.ico' })
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', icon, { once: true })
  else icon()
})()"#;

struct HandlerIvars {
  label: String,
}

define_class!(
  #[unsafe(super(NSObject))]
  #[thread_kind = MainThreadOnly]
  #[name = "RivenBrowserMessages"]
  #[ivars = HandlerIvars]
  struct Messages;

  unsafe impl NSObjectProtocol for Messages {}

  unsafe impl WKScriptMessageHandler for Messages {
    #[unsafe(method(userContentController:didReceiveScriptMessage:))]
    fn did_receive(&self, _ucc: &WKUserContentController, msg: &WKScriptMessage) {
      let body = unsafe { msg.body() };
      let Ok(text) = body.downcast::<NSString>() else { return };
      let Ok(m) = serde_json::from_str::<Value>(&text.to_string()) else { return };
      let state = unsafe { msg.webView() }.map(|wk| unsafe { state_of(&wk) });
      emit(json!({ "ev": "bv", "label": self.ivars().label, "kind": "msg", "msg": m, "state": state }));
    }
  }
);

impl Messages {
  fn new(mtm: MainThreadMarker, label: String) -> Retained<Self> {
    let this = Self::alloc(mtm).set_ivars(HandlerIvars { label });
    unsafe { msg_send![super(this), init] }
  }
}

unsafe fn wk<'a>(pv: &'a tauri::webview::PlatformWebview) -> &'a WKWebView {
  &*(pv.inner() as *const WKWebView)
}

unsafe fn state_of(wk: &WKWebView) -> Value {
  json!({
    "url": wk.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()).unwrap_or_default(),
    "title": wk.title().map(|t| t.to_string()).unwrap_or_default(),
    "loading": wk.isLoading(),
    "back": wk.canGoBack(),
    "fwd": wk.canGoForward(),
  })
}

// Report the view's state after a hook. WebKit's own properties are read on
// the main thread, after the hook has returned.
fn report(v: &Webview<Wry>, hint: &'static str) {
  let label = v.label().to_string();
  let _ = v.with_webview(move |pv| {
    let st = unsafe { state_of(wk(&pv)) };
    emit(json!({ "ev": "bv", "label": label, "kind": "state", "hint": hint, "state": st }));
  });
}

fn view(app: &AppHandle, a: &Value) -> Result<Webview<Wry>, String> {
  let label = s(a, "label").ok_or("no label")?;
  app.get_webview(label).ok_or_else(|| format!("no webview {label}"))
}

// A stable 16-byte id per partition: the same persistent WKWebsiteDataStore
// (cookies, storage) every run.
fn store_id(partition: &str) -> [u8; 16] {
  let mut out = [0u8; 16];
  for (i, seed) in [0xcbf2_9ce4_8422_2325u64, 0x8422_2325_cbf2_9ce4u64].iter().enumerate() {
    let mut h = *seed;
    for c in partition.bytes() {
      h ^= c as u64;
      h = h.wrapping_mul(0x0100_0000_01b3);
    }
    out[i * 8..i * 8 + 8].copy_from_slice(&h.to_be_bytes());
  }
  out
}

// WKWebView's own user agent stops at "(KHTML, like Gecko)", with no Version/
// or Safari/ token. Many sites read that as an unknown embedded browser and
// refuse or degrade (sign-in pages, "browser not supported"). Present the
// installed Safari's own string, so sites see the engine that actually renders.
fn safari_ua() -> String {
  static UA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
  UA.get_or_init(|| {
    let version = std::process::Command::new("/usr/bin/defaults")
      .args(["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"])
      .output()
      .ok()
      .and_then(|o| String::from_utf8(o.stdout).ok())
      .map(|s| s.trim().to_string())
      .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || c == '.'))
      .unwrap_or_else(|| "18.0".into());
    format!(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15"
    )
  })
  .clone()
}

fn create(app: &AppHandle, a: &Value) -> Res {
  let label = s(a, "label").ok_or("no label")?.to_string();
  let host = app.get_window(s(a, "host").unwrap_or("")).ok_or("no host window")?;
  if app.get_webview(&label).is_some() {
    return Ok(Value::Null);
  }
  let partition = s(a, "partition").unwrap_or("persist:riven-browser").to_string();
  let blank = WebviewUrl::External("about:blank".parse().unwrap());
  let nav_app = app.clone();
  let nav_label = label.clone();
  let win_label = label.clone();
  let dl_label = label.clone();
  let mut bld = WebviewBuilder::new(&label, blank)
    .user_agent(&safari_ua())
    .devtools(true)
    .disable_drag_drop_handler()
    .on_navigation(move |_url| {
      if let Some(v) = nav_app.get_webview(&nav_label) {
        report(&v, "start");
      }
      true
    })
    .on_page_load(|v, p| {
      report(&v, if p.event() == PageLoadEvent::Started { "commit" } else { "finish" });
    })
    .on_document_title_changed(|v, _t| report(&v, "title"))
    // target=_blank / window.open: Electron's setWindowOpenHandler decides; the
    // panel opens it as a tab. Never a window of its own.
    .on_new_window(move |url, _features| {
      emit(json!({ "ev": "bv", "label": win_label, "kind": "newwindow", "url": url.as_str() }));
      NewWindowResponse::Deny
    })
    .on_download(move |_v, ev| {
      match ev {
        DownloadEvent::Requested { url, destination } => emit(json!({
          "ev": "bv", "label": dl_label, "kind": "download", "url": url.as_str(),
          "path": destination.to_string_lossy(),
        })),
        DownloadEvent::Finished { url, path, success } => emit(json!({
          "ev": "bv", "label": dl_label, "kind": "download-done", "url": url.as_str(),
          "path": path.map(|p| p.to_string_lossy().into_owned()), "success": success,
        })),
        _ => {}
      }
      true
    });
  bld = if partition.starts_with("persist:") {
    bld.data_store_identifier(store_id(&partition))
  } else {
    bld.incognito(true)
  };
  let v = host
    .add_child(bld, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
    .map_err(|e| e.to_string())?;
  let _ = v.hide();
  // Before the first real load (the shim navigates after this returns, and
  // with_webview runs ahead of it on the main thread).
  let hl = label.clone();
  v.with_webview(move |pv| unsafe {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let wk = wk(&pv);
    let ucc = wk.configuration().userContentController();
    let world = WKContentWorld::worldWithName(&NSString::from_str(WORLD), mtm);
    let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
      WKUserScript::alloc(mtm),
      &NSString::from_str(WORLD_SCRIPT),
      WKUserScriptInjectionTime::AtDocumentStart,
      false,
      &world,
    );
    ucc.addUserScript(&script);
    let h = Messages::new(mtm, hl);
    ucc.addScriptMessageHandler_contentWorld_name(ProtocolObject::from_ref(&*h), &world, &NSString::from_str(HANDLER));
  })
  .map_err(|e| e.to_string())?;
  Ok(Value::Null)
}

// ---- executeJavaScript ------------------------------------------------------------

unsafe fn err_text(e: &NSError) -> String {
  let info = e.userInfo();
  if let Some(m) = info.objectForKey(&NSString::from_str("WKJavaScriptExceptionMessage")) {
    if let Ok(s) = m.downcast::<NSString>() {
      return s.to_string();
    }
  }
  e.localizedDescription().to_string()
}

// A value WebKit handed back (NSString/NSNumber/NSArray/NSDictionary/NSNull)
// as {"v": json} or {"u": 1} for undefined. NSJSONSerialization raises on
// anything else, so it is only asked once the value is known to be valid.
unsafe fn to_json(val: *mut AnyObject) -> String {
  let Some(obj) = Retained::retain(val) else { return r#"{"u":1}"#.into() };
  let arr: Retained<NSArray<AnyObject>> = NSArray::from_retained_slice(&[obj.clone()]);
  if NSJSONSerialization::isValidJSONObject(&arr) {
    if let Ok(data) = NSJSONSerialization::dataWithJSONObject_options_error(&arr, NSJSONWritingOptions::empty()) {
      let text = String::from_utf8_lossy(data_bytes(&data)).into_owned();
      if let Some(inner) = text.strip_prefix('[').and_then(|t| t.strip_suffix(']')) {
        return format!("{{\"v\":{inner}}}");
      }
    }
  }
  let desc: Retained<NSString> = msg_send![&*obj, description];
  json!({ "v": desc.to_string() }).to_string()
}

fn data_bytes(d: &NSData) -> &[u8] {
  unsafe { d.as_bytes_unchecked() }
}

// expr: the code is an expression (Node checked that it parses as one); it is
// awaited, so a promise's value comes back, as Electron's executeJavaScript
// does. Otherwise it is run as a script and its completion value returned.
// Either way it runs in the page's own world, like Electron's.
fn exec(app: &AppHandle, a: &Value) -> Res {
  let v = view(app, a)?;
  let code = s(a, "code").unwrap_or("").to_string();
  let expr = b(a, "expr").unwrap_or(false);
  let (tx, rx) = mpsc::channel::<Result<String, String>>();
  v.with_webview(move |pv| unsafe {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let wk = wk(&pv);
    let tx = tx.clone();
    if expr {
      let body = format!(
        "const __riven_v = await (\n{code}\n);\nif (__riven_v === undefined) return '{{\"u\":1}}';\ntry {{ return JSON.stringify({{ v: __riven_v }}) }} catch (e) {{ return JSON.stringify({{ v: String(__riven_v) }}) }}"
      );
      let done = RcBlock::new(move |val: *mut AnyObject, err: *mut NSError| {
        let r = if let Some(e) = err.as_ref() {
          Err(err_text(e))
        } else {
          match Retained::retain(val).map(|o| o.downcast::<NSString>()) {
            Some(Ok(s)) => Ok(s.to_string()),
            _ => Ok(r#"{"u":1}"#.into()),
          }
        };
        let _ = tx.send(r);
      });
      wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
        &NSString::from_str(&body),
        None,
        None,
        &WKContentWorld::pageWorld(mtm),
        Some(&done),
      );
    } else {
      let done = RcBlock::new(move |val: *mut AnyObject, err: *mut NSError| {
        let r = match err.as_ref() {
          Some(e) => Err(err_text(e)),
          None => Ok(to_json(val)),
        };
        let _ = tx.send(r);
      });
      wk.evaluateJavaScript_completionHandler(&NSString::from_str(&code), Some(&done));
    }
  })
  .map_err(|e| e.to_string())?;
  // The element picker waits on a person; give it time.
  match rx.recv_timeout(Duration::from_secs(600)) {
    Ok(Ok(s)) => Ok(Value::String(s)),
    Ok(Err(e)) => Err(e),
    Err(_) => Err("script timed out".into()),
  }
}

// ---- capturePage ------------------------------------------------------------------

// WKWebView draws the page into an image itself, so no screen-recording
// permission is involved (as with Electron's). rect: in the view's points.
fn snapshot(v: &Webview<Wry>, rect: Option<[f64; 4]>) -> Res {
  let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
  v.with_webview(move |pv| {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let tx = tx.clone();
    let done = RcBlock::new(move |img: *mut NSImage, _err: *mut NSError| {
      // Runs on the main thread, once.
      let png = unsafe { img.as_ref() }.and_then(|img| {
        let tiff = img.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
      });
      let _ = tx.send(png.map(|d| d.to_vec()));
    });
    unsafe {
      let cfg = rect.map(|r| {
        let c = WKSnapshotConfiguration::new(mtm);
        c.setRect(CGRect::new(CGPoint::new(r[0], r[1]), CGSize::new(r[2], r[3])));
        c
      });
      wk(&pv).takeSnapshotWithConfiguration_completionHandler(cfg.as_deref(), &done);
    }
  })
  .map_err(|e| e.to_string())?;
  match rx.recv_timeout(Duration::from_secs(10)) {
    Ok(Some(png)) => Ok(Value::String(base64_encode(&png))),
    Ok(None) => Err("snapshot failed".into()),
    Err(_) => Err("snapshot timed out".into()),
  }
}

fn rect_arg(a: &Value) -> Option<[f64; 4]> {
  let r = a.get("rect")?;
  Some([f(r, "x")?, f(r, "y")?, f(r, "width")?, f(r, "height")?])
}

// win.capture (an app window) and wv.capture (any webview by label).
pub fn capture(app: &AppHandle, a: &Value) -> Res {
  let v = view(app, a)?;
  snapshot(&v, rect_arg(a))
}

// ---- dispatch -----------------------------------------------------------------------

pub fn dispatch(app: &AppHandle, cmd: &str, a: &Value) -> Res {
  let e = |r: tauri::Result<()>| r.map(|_| Value::Null).map_err(|e| e.to_string());
  match cmd {
    "bv.create" => create(app, a),
    "wv.exec" => exec(app, a),
    "wv.capture" => capture(app, a),
    _ => {
      let v = view(app, a)?;
      match cmd {
        "bv.reparent" => {
          let host = app.get_window(s(a, "host").unwrap_or("")).ok_or("no host window")?;
          e(v.reparent(&host))
        }
        "bv.bounds" => e(v.set_bounds(tauri::Rect {
          position: LogicalPosition::new(f(a, "x").unwrap_or(0.0), f(a, "y").unwrap_or(0.0)).into(),
          size: LogicalSize::new(f(a, "width").unwrap_or(1.0).max(1.0), f(a, "height").unwrap_or(1.0).max(1.0)).into(),
        })),
        "bv.visible" => e(if b(a, "on").unwrap_or(false) { v.show() } else { v.hide() }),
        "bv.navigate" => {
          let url: url::Url = s(a, "url").ok_or("no url")?.parse().map_err(|e: url::ParseError| e.to_string())?;
          e(v.navigate(url))
        }
        "bv.go" => {
          let action = s(a, "action").unwrap_or("").to_string();
          e(v.with_webview(move |pv| unsafe {
            let wk = wk(&pv);
            match action.as_str() {
              "back" => {
                wk.goBack();
              }
              "forward" => {
                wk.goForward();
              }
              "reload" => {
                wk.reload();
              }
              "stop" => wk.stopLoading(),
              _ => {}
            }
          }))
        }
        "bv.state" => {
          let (tx, rx) = mpsc::channel::<Value>();
          v.with_webview(move |pv| {
            let _ = tx.send(unsafe { state_of(wk(&pv)) });
          })
          .map_err(|e| e.to_string())?;
          rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "state timed out".to_string())
        }
        // Where the view really is (logical points in its window) and whether
        // it is shown: for checking that it sits over its panel.
        "bv.frame" => {
          let r = v.bounds().map_err(|e| e.to_string())?;
          let sf = v.window().scale_factor().map_err(|e| e.to_string())?;
          let (p, z) = (r.position.to_logical::<f64>(sf), r.size.to_logical::<f64>(sf));
          let (tx, rx) = mpsc::channel::<bool>();
          v.with_webview(move |pv| {
            let _ = tx.send(unsafe { wk(&pv).isHidden() });
          })
          .map_err(|e| e.to_string())?;
          let hidden = rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "frame timed out".to_string())?;
          Ok(json!({ "x": p.x, "y": p.y, "width": z.width, "height": z.height, "hidden": hidden }))
        }
        "bv.zoom" => e(v.set_zoom(f(a, "factor").unwrap_or(1.0))),
        "bv.focus" => e(v.set_focus()),
        "bv.devtools" => {
          v.open_devtools();
          Ok(Value::Null)
        }
        "bv.close" => e(v.close()),
        _ => Err(format!("unknown command {cmd}")),
      }
    }
  }
}
