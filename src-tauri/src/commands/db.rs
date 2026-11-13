// db:* (services/db/engine.rs has the channel table and the handlers). Each
// command reads its arguments from the raw invoke body, so an argument the page
// left undefined (absent) stays distinct from one it sent as null: db:save
// keeps a stored password on undefined and clears it on null.

use super::{blocking, emit_ipc, CmdResult};
use crate::services::db::engine::{self, BoxFut, Ctx, Dialog, CHANNELS};
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::{InvokeBody, Request};
use tauri::{Manager, Webview, Window};
use tauri_plugin_dialog::DialogExt;

fn args(ch: &str, req: &Request<'_>) -> Vec<Option<Value>> {
  let names = CHANNELS.iter().find(|(c, _)| *c == ch).map(|(_, n)| *n).unwrap_or(&[]);
  let body = match req.body() {
    InvokeBody::Json(v) => v.clone(),
    _ => Value::Null,
  };
  names.iter().map(|n| body.get(*n).cloned()).collect()
}

async fn pick(win: Window, d: Dialog) -> Option<String> {
  let mut b = win.dialog().file().set_parent(&win);
  let fl = match &d {
    Dialog::Open { filters, .. } | Dialog::Save { filters, .. } => filters.clone(),
  };
  // Electron's "All files" (*) lifts the filter; macOS panels take no wildcard.
  if !fl.iter().any(|(_, e)| e.iter().any(|x| x == "*")) {
    for (name, exts) in &fl {
      let e: Vec<&str> = exts.iter().map(String::as_str).collect();
      b = b.add_filter(name, &e);
    }
  }
  let path = blocking(move || match d {
    Dialog::Open { directory, create_dirs, .. } => {
      let b = if create_dirs { b.set_can_create_directories(true) } else { b };
      if directory {
        b.blocking_pick_folder()
      } else {
        b.blocking_pick_file()
      }
    }
    Dialog::Save { default_path, .. } => b.set_file_name(default_path).set_can_create_directories(true).blocking_save_file(),
  })
  .await
  .ok()
  .flatten()?;
  path.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

fn ctx(webview: &Webview) -> Ctx {
  let app = webview.app_handle().clone();
  let label = webview.label().to_string();
  let win = webview.window();
  Ctx {
    emit: Arc::new(move |ch: &str, a: Vec<Value>| emit_ipc(&app, &label, ch, Value::Array(a))),
    dialog: Arc::new(move |d: Dialog| -> BoxFut<Option<String>> { Box::pin(pick(win.clone(), d)) }),
  }
}

async fn run(ch: &str, webview: Webview, req: Request<'_>) -> CmdResult<Value> {
  let a = args(ch, &req);
  let c = ctx(&webview);
  let ch = ch.to_string();
  // Off the invoke task: a long query never holds the page's command queue.
  crate::services::db::runtime().spawn(async move { engine::call(&ch, a, c).await }).await.map_err(|e| e.to_string())?.map_err(|e| e.msg)
}

#[tauri::command]
pub async fn db_list(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:list", webview, request).await
}

#[tauri::command]
pub async fn db_save(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:save", webview, request).await
}

#[tauri::command]
pub async fn db_delete(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:delete", webview, request).await
}

#[tauri::command]
pub async fn db_test(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:test", webview, request).await
}

#[tauri::command]
pub async fn db_sqlite_pick(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:sqlite-pick", webview, request).await
}

#[tauri::command]
pub async fn db_databases(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:databases", webview, request).await
}

#[tauri::command]
pub async fn db_schemas(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:schemas", webview, request).await
}

#[tauri::command]
pub async fn db_objects(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:objects", webview, request).await
}

#[tauri::command]
pub async fn db_table(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:table", webview, request).await
}

#[tauri::command]
pub async fn db_ddl(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:ddl", webview, request).await
}

#[tauri::command]
pub async fn db_query(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:query", webview, request).await
}

#[tauri::command]
pub async fn db_session_commit(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:session-commit", webview, request).await
}

#[tauri::command]
pub async fn db_session_rollback(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:session-rollback", webview, request).await
}

#[tauri::command]
pub async fn db_session_status(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:session-status", webview, request).await
}

#[tauri::command]
pub async fn db_session_close(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:session-close", webview, request).await
}

#[tauri::command]
pub async fn db_edit_target(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:editTarget", webview, request).await
}

#[tauri::command]
pub async fn db_apply(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:apply", webview, request).await
}

#[tauri::command]
pub async fn db_ddl_apply(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:ddl-apply", webview, request).await
}

#[tauri::command]
pub async fn db_roles(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:roles", webview, request).await
}

#[tauri::command]
pub async fn db_privileges(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:privileges", webview, request).await
}

#[tauri::command]
pub async fn db_default_acl(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:default-acl", webview, request).await
}

#[tauri::command]
pub async fn db_rls(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:rls", webview, request).await
}

#[tauri::command]
pub async fn db_completion_meta(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:completion-meta", webview, request).await
}

#[tauri::command]
pub async fn db_role_grants(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:role-grants", webview, request).await
}

#[tauri::command]
pub async fn db_mon_overview(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:mon-overview", webview, request).await
}

#[tauri::command]
pub async fn db_mon_sessions(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:mon-sessions", webview, request).await
}

#[tauri::command]
pub async fn db_mon_locks(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:mon-locks", webview, request).await
}

#[tauri::command]
pub async fn db_mon_tables(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:mon-tables", webview, request).await
}

#[tauri::command]
pub async fn db_mon_indexes(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:mon-indexes", webview, request).await
}

#[tauri::command]
pub async fn db_mon_settings(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:mon-settings", webview, request).await
}

#[tauri::command]
pub async fn db_mon_signal(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:mon-signal", webview, request).await
}

#[tauri::command]
pub async fn db_mon_reload(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:mon-reload", webview, request).await
}

#[tauri::command]
pub async fn db_cancel(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:cancel", webview, request).await
}

#[tauri::command]
pub async fn db_column(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:column", webview, request).await
}

#[tauri::command]
pub async fn db_erd(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:erd", webview, request).await
}

#[tauri::command]
pub async fn db_schema_snapshot(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:schema-snapshot", webview, request).await
}

#[tauri::command]
pub async fn db_save_text(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:save-text", webview, request).await
}

#[tauri::command]
pub async fn db_import_pick(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:import-pick", webview, request).await
}

#[tauri::command]
pub async fn db_search_tables(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:search-tables", webview, request).await
}

#[tauri::command]
pub async fn db_search_run(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:search-run", webview, request).await
}

#[tauri::command]
pub async fn db_search_cancel(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:search-cancel", webview, request).await
}

#[tauri::command]
pub async fn db_import_preview(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:import-preview", webview, request).await
}

#[tauri::command]
pub async fn db_import_run(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:import-run", webview, request).await
}

#[tauri::command]
pub async fn db_import_cancel(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:import-cancel", webview, request).await
}

#[tauri::command]
pub async fn db_backup_tools(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:backup-tools", webview, request).await
}

#[tauri::command]
pub async fn db_backup_server(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:backup-server", webview, request).await
}

#[tauri::command]
pub async fn db_backup_run(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:backup-run", webview, request).await
}

#[tauri::command]
pub async fn db_restore_pick(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:restore-pick", webview, request).await
}

#[tauri::command]
pub async fn db_restore_inspect(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:restore-inspect", webview, request).await
}

#[tauri::command]
pub async fn db_restore_run(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:restore-run", webview, request).await
}

#[tauri::command]
pub async fn db_backup_cancel(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:backup-cancel", webview, request).await
}

#[tauri::command]
pub async fn db_export(webview: Webview, request: Request<'_>) -> CmdResult<Value> {
  run("db:export", webview, request).await
}
