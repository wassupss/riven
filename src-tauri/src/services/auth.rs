// auth:oauth (src/main/auth.ts): sign-in in its own window. Supabase hands the
// page a provider authorize URL; it opens here, the person signs in with
// Google/GitHub, and the redirect back to our callback URL is caught before it
// loads to lift the PKCE `code` out of its query. The page (which holds the
// verifier) exchanges it. Closing the window (or Esc) cancels.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// extractCode(): Ok(Some(code)) once we are on our own callback URL with a
/// code, Err for a provider error there, Ok(None) for anything else.
pub fn extract_code(raw: &str, redirect_prefix: &str) -> Result<Option<String>, String> {
  let Ok(u) = url::Url::parse(raw) else { return Ok(None) };
  if !raw.starts_with(redirect_prefix) {
    return Ok(None);
  }
  let q: HashMap<String, String> = u.query_pairs().into_owned().fold(HashMap::new(), |mut m, (k, v)| {
    m.entry(k).or_insert(v);
    m
  });
  if let Some(c) = q.get("code").filter(|c| !c.is_empty()) {
    return Ok(Some(c.clone()));
  }
  if let Some(e) = q.get("error").filter(|e| !e.is_empty()) {
    let d = q.get("error_description").filter(|d| !d.is_empty());
    return Err(d.unwrap_or(e).clone());
  }
  Ok(None)
}

const LABEL: &str = "auth";
// Esc asks to leave through a URL the navigation hook catches.
const CANCEL_URL: &str = "riven-auth://cancel";
const ESC_SCRIPT: &str = "addEventListener('keydown', (e) => { if (e.key === 'Escape') location.href = 'riven-auth://cancel' }, true)";

type Done = tokio::sync::oneshot::Sender<Result<String, String>>;

fn pending() -> &'static Mutex<Option<Done>> {
  static P: OnceLock<Mutex<Option<Done>>> = OnceLock::new();
  P.get_or_init(|| Mutex::new(None))
}

fn finish(app: &AppHandle, r: Result<String, String>) {
  if let Some(tx) = pending().lock().unwrap().take() {
    let _ = tx.send(r);
  }
  if let Some(w) = app.get_webview_window(LABEL) {
    let _ = w.close();
  }
}

/// The window went away: a sign-in nobody finished is cancelled.
pub fn closed() {
  if let Some(tx) = pending().lock().unwrap().take() {
    let _ = tx.send(Err("cancelled".into()));
  }
}

pub async fn oauth(app: AppHandle, authorize_url: String, redirect_to: String) -> Result<String, String> {
  let (tx, rx) = tokio::sync::oneshot::channel();
  // One sign-in at a time: a new one replaces (and cancels) the old.
  if let Some(old) = pending().lock().unwrap().replace(tx) {
    let _ = old.send(Err("cancelled".into()));
  }
  if let Some(w) = app.get_webview_window(LABEL) {
    let _ = w.destroy();
  }
  let start: url::Url = match authorize_url.parse() {
    Ok(u) => u,
    Err(e) => {
      closed();
      return Err(format!("{e}"));
    }
  };
  let parent = app.get_focused_window().or_else(|| crate::services::browser::app_window().and_then(|l| app.get_window(&l)));
  let nav_app = app.clone();
  let mut b = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(start))
    .title("로그인")
    .inner_size(480.0, 680.0)
    .closable(true)
    .focused(!crate::background())
    .visible(!crate::background())
    .initialization_script(ESC_SCRIPT)
    .on_navigation(move |u| {
      if u.as_str().starts_with(CANCEL_URL) {
        finish(&nav_app, Err("cancelled".into()));
        return false;
      }
      match extract_code(u.as_str(), &redirect_to) {
        Ok(Some(code)) => {
          finish(&nav_app, Ok(code));
          false
        }
        Err(e) => {
          finish(&nav_app, Err(e));
          false
        }
        Ok(None) => true,
      }
    });
  // A plain child window (not a sheet): it keeps its title bar and close button.
  #[cfg(target_os = "macos")]
  if let Some(p) = parent.as_ref().and_then(|p| p.ns_window().ok()) {
    b = b.parent_raw(p);
  }
  if let Err(e) = b.build() {
    closed();
    return Err(e.to_string());
  }
  rx.await.unwrap_or_else(|_| Err("cancelled".into()))
}

#[cfg(test)]
mod tests {
  use super::extract_code;

  #[test]
  fn codes_like_auth_ts() {
    let r = "https://riven.app/auth/callback";
    assert_eq!(extract_code("https://riven.app/auth/callback?code=abc&state=1", r), Ok(Some("abc".into())));
    assert_eq!(extract_code("https://riven.app/auth/callback?x=1", r), Ok(None));
    assert_eq!(extract_code("https://evil.test/?code=abc", r), Ok(None));
    assert_eq!(extract_code("not a url", r), Ok(None));
    assert_eq!(extract_code("https://riven.app/auth/callback?error=access_denied", r), Err("access_denied".into()));
    assert_eq!(
      extract_code("https://riven.app/auth/callback?error=access_denied&error_description=User+said+no", r),
      Err("User said no".into())
    );
    assert_eq!(extract_code("https://riven.app/auth/callback?code=a%2Bb&code=second", r), Ok(Some("a+b".into())));
    assert_eq!(extract_code("https://riven.app/auth/callback?code=&error=e", r), Err("e".into()));
  }
}
