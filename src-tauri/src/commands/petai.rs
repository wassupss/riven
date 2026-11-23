// The pet maker's and the decoration layout's one-shot AI call
// (services/petai.rs). 'petAi:run' resolves when the CLI is done.

use crate::services::petai;
use serde_json::{json, Value};

#[tauri::command]
pub async fn pet_ai_run(req: Value) -> Value {
  match serde_json::from_value::<petai::Req>(req) {
    Ok(r) => petai::run(r).await,
    Err(e) => json!({ "ok": false, "error": "failed", "detail": e.to_string() }),
  }
}

#[tauri::command]
pub fn pet_ai_cancel(id: String) {
  petai::cancel(&id)
}

#[tauri::command]
pub async fn pet_ai_engines() -> Value {
  petai::engines().await
}
