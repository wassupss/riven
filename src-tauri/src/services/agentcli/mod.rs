// What riven knows about the agent CLIs (Claude Code, Codex) apart from any
// one way of running them: their past conversations on disk (history.rs),
// the MCP servers they see (mcp.rs), whether they are installed, their
// accounts and updates (cli.rs), and the launch arguments every chat engine
// builds the same way (the allow list).
//
// The chat engines (services/clichat, the interactive CLI in a hidden pty,
// and services/chat, the headless stream-json driver) use this; nothing here
// knows either of them. An engine that has open panes registers an `Engine`
// so that an update or the Settings "restart CLIs" button reaches its panes.

pub mod cli;
pub mod history;
pub mod mcp;

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

pub use cli::UpdateState;
pub use history::SessionSummary;
pub use mcp::SessionInfo;

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

// ---- the app's windows ----------------------------------------------------------------

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
}

/// webContents.send to every app window (BrowserWindow.getAllWindows).
pub fn broadcast(ch: &str, payload: Value) {
  use tauri::Manager;
  let Some(app) = APP.get() else { return };
  for label in app.webview_windows().keys() {
    if crate::commands::app_page(label) {
      crate::commands::emit_ipc(app, label, ch, json!([payload]));
    }
  }
}

// ---- engines with panes open ------------------------------------------------------------

/// A chat engine's panes, as an update or a restart sees them.
pub struct Engine {
  /// Panes open on this CLI ("claude" | "codex").
  pub open: fn(&str) -> u32,
  /// Put the installed CLI behind the panes of `cmd` (every CLI when None),
  /// or behind the one pane `key`, resuming each conversation. A pane in
  /// the middle of a turn gets it when the turn ends. (restarted, deferred).
  pub restart: fn(Option<String>, Option<String>) -> BoxFut<(u32, u32)>,
}

fn engines() -> &'static Mutex<Vec<Engine>> {
  static E: OnceLock<Mutex<Vec<Engine>>> = OnceLock::new();
  E.get_or_init(Default::default)
}

pub fn register(e: Engine) {
  engines().lock().unwrap_or_else(|e| e.into_inner()).push(e);
}

/// Panes open on a CLI, over every engine.
pub fn open_agents(cmd: &str) -> u32 {
  engines().lock().unwrap_or_else(|e| e.into_inner()).iter().map(|e| (e.open)(cmd)).sum()
}

async fn restart_all(cmd: Option<String>, key: Option<String>) -> (u32, u32) {
  let jobs: Vec<BoxFut<(u32, u32)>> = engines().lock().unwrap_or_else(|e| e.into_inner()).iter().map(|e| (e.restart)(cmd.clone(), key.clone())).collect();
  let (mut restarted, mut deferred) = (0, 0);
  for j in jobs {
    let (r, d) = j.await;
    restarted += r;
    deferred += d;
  }
  (restarted, deferred)
}

/// chat:restart, the Settings button (a CLI updated outside riven): every
/// pane, or one, gets the installed CLI, resuming its conversation.
pub async fn restart(key: Option<String>) -> Value {
  let (restarted, busy) = restart_all(None, key).await;
  json!({ "restarted": restarted, "busy": busy })
}

// ---- launch arguments --------------------------------------------------------------------

const DEFAULT_ALLOWED: &str = "Task,Read,Grep,Glob,LS,Edit,Write,MultiEdit,NotebookEdit,Bash,BashOutput,WebFetch,WebSearch,TodoWrite";

/// The allow-list minus what the user held back (not forbidden: the CLI asks).
pub fn allowed_base(denied: &Option<Vec<String>>) -> String {
  match denied.as_ref().filter(|d| !d.is_empty()) {
    None => DEFAULT_ALLOWED.into(),
    Some(off) => DEFAULT_ALLOWED.split(',').filter(|n| !off.iter().any(|o| o == n)).collect::<Vec<_>>().join(","),
  }
}

// ---- past conversations (chat:sessions and friends) ----------------------------------------

/// A conversation's messages for the phone and a restored chat: Claude Code's
/// transcript, else the Codex rollout with that id.
pub async fn transcript(cwd: String, id: String, config_dir: Option<String>) -> Vec<Value> {
  tokio::task::spawn_blocking(move || {
    let c = history::read_session_transcript(&cwd, &id, config_dir.as_deref());
    if c.is_empty() {
      history::read_codex_transcript(&id)
    } else {
      c
    }
  })
  .await
  .unwrap_or_default()
}

pub async fn sessions(cwd: String, config_dir: Option<String>) -> Vec<SessionSummary> {
  history::list_sessions(cwd, config_dir).await
}

/// Codex's conversations in this folder (its rollouts), newest first.
pub async fn codex_sessions(cwd: String) -> Vec<SessionSummary> {
  tokio::task::spawn_blocking(move || history::list_codex_sessions(&cwd)).await.unwrap_or_default()
}

/// Delete a Codex conversation: `codex delete <id>`, so Codex removes what
/// it keeps about it (the rollout and its index), not riven guessing.
pub async fn codex_session_delete(id: String) -> bool {
  if !history::is_session_id(&id) {
    return false;
  }
  let Some(bin) = crate::services::util::resolve_bin("codex").await else { return false };
  let r = crate::services::util::run(crate::services::util::Run {
    bin: &bin,
    args: vec!["delete".into(), "--force".into(), id.clone()],
    cwd: None,
    login: false,
    env: Default::default(),
    stderr: true,
    timeout: Duration::from_secs(20),
  })
  .await;
  r.spawned && r.code == Some(0) && history::find_rollout(&id).is_none()
}

pub async fn session_rename(cwd: String, id: String, title: String, config_dir: Option<String>) -> bool {
  tokio::task::spawn_blocking(move || history::rename_session(&cwd, &id, &title, config_dir.as_deref())).await.unwrap_or(false)
}

pub async fn session_delete(cwd: String, id: String, config_dir: Option<String>) -> bool {
  tokio::task::spawn_blocking(move || history::delete_session(&cwd, &id, config_dir.as_deref())).await.unwrap_or(false)
}

pub async fn session_title(cwd: String, id: String, config_dir: Option<String>) -> Option<String> {
  tokio::task::spawn_blocking(move || history::read_session_title(&cwd, &id, config_dir.as_deref())).await.ok().flatten()
}

pub async fn agents(cwd: String) -> Vec<Value> {
  tokio::task::spawn_blocking(move || history::list_agents(&cwd)).await.unwrap_or_default()
}

// ---- MCP servers (the /mcp card) ---------------------------------------------------------------

pub async fn session_info(cwd: String, config_dir: Option<String>, fresh: bool) -> SessionInfo {
  mcp::fetch_session_info(cwd, config_dir, fresh).await
}

pub async fn mcp_list(cwd: String, config_dir: Option<String>) -> Vec<Value> {
  mcp::mcp_list(cwd, config_dir).await
}

pub async fn mcp_logout(cwd: String, name: String, config_dir: Option<String>) -> Value {
  mcp::run_result(mcp::run_claude_mcp(&cwd, &["mcp", "logout", &name], Duration::from_secs(20), config_dir.as_deref()).await)
}

pub async fn mcp_approve(cwd: String, name: String, config_dir: Option<String>) -> Value {
  tokio::task::spawn_blocking(move || mcp::approve_mcp_json(&cwd, &name, config_dir.as_deref())).await.unwrap_or(Value::Null)
}

// ---- the CLIs: installed, accounts, updates -------------------------------------------------------

pub async fn detect_clis() -> Vec<Value> {
  cli::detect_clis().await
}

pub async fn accounts(config_dir: Option<String>) -> Vec<Value> {
  cli::accounts(config_dir).await
}

pub fn profile_dir(id: &str) -> String {
  cli::profile_dir(id)
}

pub async fn logout(config_dir: Option<String>) -> Value {
  let home = crate::services::util::home().to_string_lossy().into_owned();
  mcp::run_result(mcp::run_claude_mcp(&home, &["auth", "logout"], Duration::from_secs(30), config_dir.as_deref()).await)
}

pub async fn cli_update(cmd: String) -> Option<UpdateState> {
  if cmd != "claude" && cmd != "codex" {
    return None;
  }
  Some(cli::run_update(&cmd).await)
}

pub fn cli_update_status() -> Vec<UpdateState> {
  cli::update_status()
}

/// The user said yes: every open pane on this CLI gets the new build.
pub async fn cli_apply_update(cmd: String) -> Option<UpdateState> {
  if cmd != "claude" && cmd != "codex" {
    return None;
  }
  let cur = cli::current(&cmd).filter(|u| u.status == "done")?;
  let (restarted, deferred) = restart_all(Some(cmd), None).await;
  let next = UpdateState { restarted, deferred, answered: Some("applied".into()), ..cur };
  cli::publish(next.clone());
  Some(next)
}

pub fn cli_defer_update(cmd: &str) {
  cli::defer_update(cmd);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn args() {
    assert!(!allowed_base(&Some(vec!["Bash".into()])).contains("Bash,"));
    assert_eq!(allowed_base(&None), DEFAULT_ALLOWED);
  }
}
