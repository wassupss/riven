// git:* (src/main/git.ts) and gh:* (src/main/githubPr.ts, githubPrDetail.ts,
// githubPrReview.ts). Loosely typed arguments arrive as JSON values and are
// read the way the Node handlers read them (`??`, truthiness, String()).
// 'git:changed' goes to the page that last called git:watch.

use super::emit_ipc;
use crate::services::chat::util::js_string;
use crate::services::git::{github, repo, watch_head};
use serde_json::Value;
use tauri::{AppHandle, Webview};

#[tauri::command]
pub async fn git_info(folder: String) -> Value {
  repo::info(&folder).await
}

#[tauri::command]
pub async fn git_repos(folder: String) -> Value {
  repo::repos(&folder).await
}

#[tauri::command]
pub async fn git_log(folder: String, limit: Option<Value>) -> Value {
  repo::log(&folder, limit.as_ref()).await
}

#[tauri::command]
pub async fn git_show_file(folder: String, rel_path: String) -> Value {
  repo::show_file(&folder, &rel_path).await
}

#[tauri::command]
pub async fn git_blame(file_path: String) -> Value {
  repo::blame(&file_path).await
}

#[tauri::command]
pub async fn git_status(folder: String) -> Value {
  repo::status(&folder).await
}

#[tauri::command]
pub async fn git_push(folder: String) -> Value {
  repo::push(&folder).await
}

#[tauri::command]
pub async fn git_pull(folder: String) -> Value {
  repo::pull(&folder).await
}

#[tauri::command]
pub async fn git_discard(folder: String, rel_path: String, untracked: Option<Value>) -> Value {
  repo::discard(&folder, &rel_path, untracked.as_ref()).await
}

#[tauri::command]
pub async fn git_stage(folder: String, rel_path: String) -> Value {
  repo::stage(&folder, &rel_path).await
}

#[tauri::command]
pub async fn git_unstage(folder: String, rel_path: String) -> Value {
  repo::unstage(&folder, &rel_path).await
}

#[tauri::command]
pub async fn git_stage_all(folder: String) -> Value {
  repo::stage_all(&folder).await
}

#[tauri::command]
pub async fn git_commit(folder: String, message: Option<Value>) -> Value {
  repo::commit(&folder, &message.as_ref().map(js_string).unwrap_or_else(|| "undefined".into())).await
}

#[tauri::command]
pub async fn git_branches(folder: String) -> Value {
  repo::branches(&folder).await
}

#[tauri::command]
pub async fn git_checkout(folder: String, branch: String) -> Value {
  repo::checkout(&folder, &branch).await
}

#[tauri::command]
pub async fn git_create_branch(folder: String, name: String) -> Value {
  repo::create_branch(&folder, &name).await
}

#[tauri::command]
pub async fn git_fetch(folder: String) -> Value {
  repo::fetch(&folder).await
}

#[tauri::command]
pub async fn git_stash(folder: String, message: Option<Value>) -> Value {
  repo::stash(&folder, message.as_ref()).await
}

#[tauri::command]
pub async fn git_stash_pop(folder: String) -> Value {
  repo::stash_pop(&folder).await
}

#[tauri::command]
pub async fn git_stash_list(folder: String) -> Value {
  repo::stash_list(&folder).await
}

#[tauri::command]
pub fn git_watch(app: AppHandle, webview: Webview, folder: String) {
  let label = webview.label().to_string();
  watch_head(&folder, Box::new(move || emit_ipc(&app, &label, "git:changed", serde_json::json!([]))));
}

#[tauri::command]
pub async fn gh_prs(repo_dir: String, state: Option<Value>) -> Value {
  github::list_pull_requests(&repo_dir, state.as_ref()).await
}

#[tauri::command]
pub async fn gh_new_pr_draft(repo_dir: String) -> Value {
  github::new_pr_draft(&repo_dir).await
}

#[tauri::command]
pub async fn gh_create_pr(repo_dir: String, input: Option<Value>) -> Value {
  github::create_pull_request(&repo_dir, input.as_ref()).await
}

#[tauri::command]
pub async fn gh_push_branch(repo_dir: String, branch: String) -> Value {
  github::push_branch(&repo_dir, &branch).await
}

#[tauri::command]
pub async fn gh_create_web(repo_dir: String) -> Value {
  github::create_web(&repo_dir).await
}

#[tauri::command]
pub async fn gh_pr_detail(repo_dir: String, number: Option<Value>) -> Value {
  github::pr_detail(&repo_dir, number.as_ref()).await
}

#[tauri::command]
pub async fn gh_pr_file(repo_dir: String, number: Option<Value>, file_path: Option<Value>) -> Value {
  // String(filePath ?? '')
  let p = file_path.as_ref().map(js_string).unwrap_or_default();
  github::pr_file_contents(&repo_dir, number.as_ref(), &p).await
}

#[tauri::command]
pub async fn gh_submit_review(
  repo_dir: String,
  number: Option<Value>,
  event: Option<Value>,
  body: Option<Value>,
  comments: Option<Value>,
  commit_id: Option<Value>,
) -> Value {
  github::submit_review(&repo_dir, number.as_ref(), event.as_ref(), body.as_ref(), comments.as_ref(), commit_id.as_ref()).await
}

fn thread_id(v: Option<&Value>) -> String {
  v.map(js_string).unwrap_or_else(|| "undefined".into())
}

#[tauri::command]
pub async fn gh_reply_thread(repo_dir: String, thread_id: Option<Value>, body: Option<Value>) -> Value {
  github::reply_to_thread(&repo_dir, &self::thread_id(thread_id.as_ref()), body.as_ref()).await
}

#[tauri::command]
pub async fn gh_resolve_thread(repo_dir: String, thread_id: Option<Value>, resolved: Option<Value>) -> Value {
  let resolved = crate::services::chat::util::truthy(resolved.as_ref());
  github::set_thread_resolved(&repo_dir, &self::thread_id(thread_id.as_ref()), resolved).await
}
