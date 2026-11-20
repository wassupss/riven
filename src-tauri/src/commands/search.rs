// search:inFiles / search:replaceInFiles (src/main/search.ts).

use super::{blocking, CmdResult};
use crate::services::search::{self, ReplaceResult, SearchOpts, SearchResult};

#[tauri::command]
pub async fn search_in_files(opts: SearchOpts) -> CmdResult<SearchResult> {
  blocking(move || search::in_files(&opts)).await
}

#[tauri::command]
pub async fn search_replace_in_files(opts: SearchOpts) -> CmdResult<ReplaceResult> {
  Ok(search::replace_in_files(opts).await)
}
