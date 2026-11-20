// Same data folder as Electron (paths.rs): the files Electron's src/main
// writes must read and write back the same here. Driven by
// scripts/data-parity.mjs, which writes a folder with Electron's own main
// process code, points this test at a copy of it (RIVEN_TAURI_DATA_DIR) and
// compares what comes back. Without RIVEN_PARITY_OUT the test does nothing.

#[cfg(test)]
mod tests {
  use crate::commands;
  use crate::services::{browser::Store, db::store as dbstore, notes, paths};
  use serde_json::{json, Value};

  #[test]
  fn electron_files_round_trip() {
    let Ok(out) = std::env::var("RIVEN_PARITY_OUT") else { return };
    let fixture: Value = serde_json::from_str(&std::env::var("RIVEN_PARITY_FIXTURE").unwrap()).unwrap();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let mut report = serde_json::Map::new();
    report.insert("userData".into(), json!(paths::user_data()));

    // config + sessions: load what Electron wrote and save it again.
    for name in ["settings.json", "keybindings.json"] {
      let v = rt.block_on(commands::config::config_load(name.into())).unwrap();
      rt.block_on(commands::config::config_save(name.into(), v)).unwrap();
    }
    let s = rt.block_on(commands::sessions::sessions_load()).unwrap();
    report.insert("sessionsWorkspaces".into(), json!(s.as_object().map(|m| m.len()).unwrap_or(0)));
    rt.block_on(commands::sessions::sessions_save(s)).unwrap();

    // notes: Electron's notes are found under the same hashed folder.
    let ws = fixture["workspace"].as_str().unwrap();
    let listed: Vec<Value> = notes::list(ws).into_iter().map(|n| json!({ "name": n.name, "title": n.title })).collect();
    let mut bodies = serde_json::Map::new();
    for n in &listed {
      let name = n["name"].as_str().unwrap();
      bodies.insert(name.into(), json!(notes::read(ws, name)));
    }
    report.insert("notes".into(), json!(listed));
    report.insert("noteBodies".into(), Value::Object(bodies));
    let wrote = notes::write(ws, None, "Tauri note 한글", "# Tauri note 한글\n\nbody\n").unwrap();
    report.insert("tauriNote".into(), json!(wrote));

    // db/connections.json: listing, and re-saving an entry unchanged.
    let conns = dbstore::list();
    report.insert("connections".into(), json!(conns));
    if let Some(first) = conns.first() {
      let mut c = first.as_object().unwrap().clone();
      c.remove("hasPassword");
      dbstore::save_connection(&Value::Object(c), None).unwrap();
    }

    // browser.json: parsed and written back as browser.ts writes it.
    let text = std::fs::read_to_string(paths::user_file("browser.json")).ok();
    report.insert("browserText".into(), json!(Store::parse(text.as_deref()).text()));

    // store/<name>.json (the renderer's data files): load all, save each back.
    let all = rt.block_on(commands::store::store_load_all()).unwrap();
    report.insert("store".into(), all.clone());
    for (name, v) in all.as_object().unwrap() {
      rt.block_on(commands::store::store_save(name.clone(), Some(v.clone()))).unwrap();
    }
    rt.block_on(commands::store::store_save("from-tauri".into(), Some(json!({ "by": "rust", "n": [1, 2.5] })))).unwrap();
    rt.block_on(commands::store::store_save("removed-by-tauri".into(), None)).unwrap();

    // Names Electron derives from user input.
    report.insert(
      "captureDirs".into(),
      json!(fixture["captureFolders"].as_array().unwrap().iter().map(|f| commands::app::capture_dir_name(f.as_str().unwrap())).collect::<Vec<_>>()),
    );
    report.insert(
      "profileDirs".into(),
      json!(fixture["profileIds"].as_array().unwrap().iter().map(|f| crate::services::chat::profile_dir(f.as_str().unwrap())).collect::<Vec<_>>()),
    );
    std::fs::write(out, serde_json::to_string_pretty(&Value::Object(report)).unwrap()).unwrap();
  }

  /// Secrets Electron sealed (DB password, remote key) open here, and what
  /// this side seals opens in Electron. Run against a scratch keychain whose
  /// item text is the one Electron used (RIVEN_TAURI_KEYCHAIN), never the
  /// login keychain. Without RIVEN_PARITY_SECRETS_OUT it does nothing.
  #[test]
  fn electron_secrets() {
    let Ok(out) = std::env::var("RIVEN_PARITY_SECRETS_OUT") else { return };
    assert!(std::env::var("RIVEN_TAURI_KEYCHAIN").is_ok_and(|k| !k.is_empty()), "a scratch keychain only");
    let mut report = serde_json::Map::new();
    report.insert("available".into(), json!(crate::services::safe_storage::available()));
    let conns = dbstore::list();
    let mut pw = serde_json::Map::new();
    for c in &conns {
      let id = c["id"].as_str().unwrap();
      pw.insert(id.into(), json!(dbstore::password(id)));
    }
    report.insert("passwords".into(), Value::Object(pw));
    report.insert("remoteKey".into(), crate::services::remote_key::load());
    // Seal new ones for Electron to open.
    let mut c = conns[0].as_object().unwrap().clone();
    c.remove("hasPassword");
    c.insert("id".into(), json!("from-tauri"));
    c.insert("name".into(), json!("sealed by tauri"));
    dbstore::save_connection(&Value::Object(c), Some(Some("tauri 비밀 \"pw\"".into()))).unwrap();
    crate::services::remote_key::save(&json!({ "publicKey": "tpk", "secretKey": "tsk" })).unwrap();
    std::fs::write(out, serde_json::to_string_pretty(&Value::Object(report)).unwrap()).unwrap();
  }
}
