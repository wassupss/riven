// power:busy, power:remote (sends) and perf:metrics (services/power).

use crate::services::power;
use serde_json::Value;

#[tauri::command]
pub fn power_busy(count: Option<f64>, on: Option<bool>) {
  power::busy(count.unwrap_or(0.0), on.unwrap_or(false))
}

#[tauri::command]
pub fn power_remote(on: Option<bool>) {
  power::remote(on.unwrap_or(false))
}

#[tauri::command]
pub fn perf_metrics() -> Value {
  power::metrics()
}
