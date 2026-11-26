// Commands the page calls with Tauri invoke. One per ipcMain channel a group
// had: 'workspace:readFile' -> workspace_read_file (tauri/shim/rust-owned.ts
// holds the channel list the preload routes here, with the argument names).
//
// Every #[tauri::command] in this directory is allowed for the app's own
// pages by the generated permission set `rust-main` (build.rs scans these
// files), and the handler below refuses any other webview, so the browser
// panel's pages (bv-*) reach nothing.
//
// Main -> page events: emit_ipc() sends {ch, args} as the Tauri event
// 'riven:ipc' to one window; the preload hands it to ipcRenderer.on
// listeners exactly like Electron's webContents.send.

pub mod app;
pub mod browser;
pub mod agentcli;
pub mod chat;
pub mod clichat;
pub mod config;
pub mod db;
pub mod debug;
pub mod desk;
pub mod git;
pub mod lsp;
pub mod mcp;
pub mod notes;
pub mod notify;
pub mod petai;
pub mod power;
pub mod pty;
pub mod search;
pub mod sessions;
pub mod store;
pub mod tools;
pub mod watch;
pub mod workspace;

use tauri::ipc::Invoke;
use tauri::{AppHandle, Emitter, EventTarget, Wry};

pub type CmdResult<T> = Result<T, String>;

/// Runs blocking file-system work off the async runtime's worker threads.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
  tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

pub fn emit_ipc(app: &AppHandle, label: &str, ch: &str, args: serde_json::Value) {
  let _ = app.emit_to(
    EventTarget::AnyLabel { label: label.to_string() },
    "riven:ipc",
    serde_json::json!({ "ch": ch, "args": args }),
  );
}

pub(crate) fn app_page(label: &str) -> bool {
  (label.starts_with('w') && label[1..].chars().all(|c| c.is_ascii_digit()))
    || label.starts_with("pop-")
    || label == crate::services::pet::LABEL
}

pub fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
  let inner: Box<dyn Fn(Invoke<Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![
    app::env_defaults,
    app::capture_save,
    app::shell_open_external,
    app::ui_set_zoom,
    app::riven_drag_paths,
    app::riven_close_popout,
    app::riven_pop_theme,
    config::config_load,
    desk::usage_limits,
    desk::remote_key_available,
    desk::remote_key_load,
    desk::remote_key_save,
    desk::auth_oauth,
    desk::app_version,
    desk::update_current,
    desk::update_check,
    desk::update_install,
    desk::perm_report,
    desk::perm_ask,
    desk::perm_open,
    desk::tray_feed,
    desk::tray_diag,
    desk::pet_open,
    desk::pet_close,
    desk::pet_hide,
    desk::pet_dock,
    desk::pet_is_open,
    desk::pet_cursor_inside,
    desk::pet_resize,
    desk::pet_drag_start,
    desk::pet_drag_move,
    desk::pet_drag_end,
    desk::pet_window_box,
    desk::pet_room,
    desk::pet_set_break,
    desk::pet_set_on_top,
    desk::pet_ask_on_top,
    desk::pet_is_on_top,
    desk::pet_focusable,
    desk::pet_copy,
    desk::pet_open_settings,
    browser::browser_bookmarks,
    browser::browser_history,
    browser::browser_add_bookmark,
    browser::browser_remove_bookmark,
    browser::browser_clear_history,
    browser::browser_create,
    browser::browser_navigate,
    browser::browser_go,
    browser::browser_destroy,
    browser::browser_sync,
    browser::browser_hide_all,
    browser::browser_exec_js,
    browser::browser_capture,
    browser::browser_state,
    browser::browser_set_zoom,
    browser::browser_find,
    browser::browser_open_devtools,
    browser::browser_set_lang,
    browser::browser_suggest,
    browser::browser_bar_menu,
    browser::browser_pick_element,
    debug::debug_start,
    debug::debug_stop,
    debug::debug_continue,
    debug::debug_step_over,
    debug::debug_step_into,
    debug::debug_step_out,
    debug::debug_set_breakpoints,
    debug::debug_get_properties,
    debug::debug_evaluate,
    power::power_busy,
    power::power_remote,
    power::perf_metrics,
    notify::notify_show,
    notify::notify_presence,
    notify::notify_diag,
    tools::cli_list,
    tools::ports_list,
    tools::ports_kill,
    tools::models_claude,
    tools::diagnostics_run,
    tools::usage_today,
    tools::usage_codex,
    tools::api_request,
    lsp::lsp_servers,
    lsp::lsp_start,
    lsp::lsp_request,
    lsp::lsp_notify,
    lsp::lsp_stop_root,
    config::config_save,
    config::config_reveal,
    config::background_import,
    config::background_gc,
    sessions::sessions_load,
    sessions::sessions_save,
    store::store_load_all,
    store::store_save,
    workspace::workspace_set_roots,
    workspace::workspace_pick_folder,
    workspace::workspace_read_dir,
    workspace::workspace_list_files,
    workspace::workspace_read_file,
    workspace::workspace_write_file,
    workspace::workspace_create_file,
    workspace::workspace_create_folder,
    workspace::workspace_rename,
    workspace::workspace_delete,
    workspace::workspace_reveal,
    workspace::workspace_import_paths,
    workspace::workspace_snapshot_contents,
    workspace::image_save_temp,
    workspace::font_import,
    workspace::scripts_list,
    search::search_in_files,
    search::search_replace_in_files,
    notes::notes_list,
    notes::notes_read,
    notes::notes_write,
    notes::notes_append,
    notes::notes_delete,
    notes::notes_write_file,
    notes::notes_save_to_file,
    watch::watch_start,
    watch::watch_stop,
    pty::pty_open,
    pty::pty_stream,
    pty::pty_write,
    pty::pty_ack,
    pty::pty_visible,
    pty::pty_seen,
    pty::pty_resize,
    pty::pty_kill,
    pty::pty_codex_session_title,
    pty::pty_remote_text,
    pty::pty_remote_input,
    clichat::clichat_start,
    clichat::clichat_send,
    clichat::clichat_steer,
    clichat::clichat_keys,
    clichat::clichat_interrupt,
    clichat::clichat_stop,
    clichat::clichat_terminal,
    clichat::clichat_answer,
    clichat::clichat_restart,
    clichat::clichat_menu,
    clichat::clichat_question,
    clichat::clichat_reconfigure,
    clichat::clichat_rename,
    clichat::clichat_attach,
    clichat::clichat_image,
    agentcli::chat_restart,
    chat::chat_title,
    petai::pet_ai_run,
    petai::pet_ai_cancel,
    petai::pet_ai_engines,
    agentcli::chat_detect_clis,
    agentcli::chat_session_info,
    agentcli::chat_sessions,
    agentcli::chat_session_rename,
    agentcli::chat_session_delete,
    agentcli::chat_agents,
    agentcli::chat_session_transcript,
    agentcli::chat_session_title,
    agentcli::chat_mcp_list,
    agentcli::chat_mcp_session,
    agentcli::chat_mcp_logout,
    agentcli::chat_mcp_approve,
    agentcli::cli_update,
    agentcli::cli_update_status,
    agentcli::cli_apply_update,
    agentcli::cli_defer_update,
    agentcli::accounts_profile_dir,
    agentcli::accounts_logout,
    agentcli::accounts_list,
    agentcli::chat_codex_sessions,
    agentcli::chat_codex_session_delete,
    mcp::mcp_attach,
    mcp::mcp_result,
    git::git_info,
    git::git_repos,
    git::git_log,
    git::git_worktree_create,
    git::git_show_file,
    git::git_blame,
    git::git_status,
    git::git_push,
    git::git_pull,
    git::git_discard,
    git::git_stage,
    git::git_unstage,
    git::git_stage_all,
    git::git_commit,
    git::git_branches,
    git::git_checkout,
    git::git_create_branch,
    git::git_fetch,
    git::git_stash,
    git::git_stash_pop,
    git::git_stash_list,
    git::git_watch,
    git::gh_prs,
    git::gh_new_pr_draft,
    git::gh_create_pr,
    git::gh_push_branch,
    git::gh_create_web,
    git::gh_pr_detail,
    git::gh_pr_file,
    git::gh_submit_review,
    git::gh_reply_thread,
    git::gh_resolve_thread,
    db::db_list,
    db::db_save,
    db::db_delete,
    db::db_test,
    db::db_sqlite_pick,
    db::db_databases,
    db::db_schemas,
    db::db_objects,
    db::db_table,
    db::db_ddl,
    db::db_query,
    db::db_session_commit,
    db::db_session_rollback,
    db::db_session_status,
    db::db_session_close,
    db::db_edit_target,
    db::db_apply,
    db::db_ddl_apply,
    db::db_roles,
    db::db_privileges,
    db::db_default_acl,
    db::db_rls,
    db::db_completion_meta,
    db::db_role_grants,
    db::db_mon_overview,
    db::db_mon_sessions,
    db::db_mon_locks,
    db::db_mon_tables,
    db::db_mon_indexes,
    db::db_mon_settings,
    db::db_mon_signal,
    db::db_mon_reload,
    db::db_cancel,
    db::db_column,
    db::db_erd,
    db::db_schema_snapshot,
    db::db_save_text,
    db::db_import_pick,
    db::db_search_tables,
    db::db_search_run,
    db::db_search_cancel,
    db::db_import_preview,
    db::db_import_run,
    db::db_import_cancel,
    db::db_backup_tools,
    db::db_backup_server,
    db::db_backup_run,
    db::db_restore_pick,
    db::db_restore_inspect,
    db::db_restore_run,
    db::db_backup_cancel,
    db::db_export,
  ]);
  move |invoke: Invoke<Wry>| {
    let label = invoke.message.webview_ref().label().to_string();
    if !app_page(&label) {
      invoke.resolver.reject(format!("riven: '{}' is not allowed from {label}", invoke.message.command()));
      return true;
    }
    inner(invoke)
  }
}
