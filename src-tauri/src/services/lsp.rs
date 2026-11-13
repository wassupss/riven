// Language servers (was src/main/lsp.ts). One server per serverKey, started
// lazily by the editor (src/renderer/src/lsp/client.ts), spoken to over stdio
// with LSP's Content-Length framing.
//
// Installed servers only (docs/tauri-rust-main.md section 4): nothing is
// bundled or downloaded. For each key, in order:
//   1. the workspace's own node_modules (walking up, as Node's require does),
//      run with the user's `node` from the login PATH
//   2. the server's own command on the login PATH
// A key with neither is left out of lsp:servers, and the editor shows which
// server to install in its status bar.
//
// Same behavior as the Node module: the initialize capabilities, the answers
// to server requests (workspace/configuration -> one {} per item,
// workspace/applyEdit -> not applied, anything else null), the idle stop
// (RIVEN_LSP_IDLE_STOP_MS, 10 minutes after the last open document of that
// server closes), lsp:stopRoot, and shutdown + exit + kill on quit.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, oneshot, watch};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
}

fn send_page(label: &str, ch: &str, args: Value) {
  if let Some(app) = APP.get() {
    crate::commands::emit_ipc(app, label, ch, args);
  }
}

fn idle_stop() -> Duration {
  let ms = std::env::var("RIVEN_LSP_IDLE_STOP_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0);
  Duration::from_millis(ms.unwrap_or(10 * 60_000))
}

// ---- finding servers ----------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Spec {
  command: PathBuf,
  args: Vec<String>,
  init_options: Option<Value>,
  client_watches_files: bool,
}

/// `rel` inside a node_modules of `root` or any folder above it.
fn from_workspace(root: &str, rel: &str) -> Option<PathBuf> {
  let mut dir = Some(Path::new(root));
  while let Some(d) = dir {
    let p = d.join("node_modules").join(rel);
    if p.is_file() {
      return Some(p);
    }
    dir = d.parent();
  }
  None
}

fn node() -> Option<PathBuf> {
  crate::services::tools::resolve_bin("node").map(PathBuf::from)
}

fn via_node(entry: PathBuf, args: &[&str]) -> Option<Spec> {
  let node = node()?;
  let mut a = vec![entry.to_string_lossy().into_owned()];
  a.extend(args.iter().map(|s| s.to_string()));
  Some(Spec { command: node, args: a, init_options: None, client_watches_files: false })
}

fn on_path(bin: &str, args: &[&str]) -> Option<Spec> {
  let command = PathBuf::from(crate::services::tools::resolve_bin(bin)?);
  Some(Spec { command, args: args.iter().map(|s| s.to_string()).collect(), init_options: None, client_watches_files: false })
}

/// The keys in the order the Node module listed them (lsp:servers keeps it).
pub const KEYS: &[&str] = &["typescript", "clangd", "pyright", "gopls", "rust", "bash", "yaml", "svelte"];

pub fn resolve(key: &str, root: &str) -> Option<Spec> {
  match key {
    "typescript" => {
      // The project's tsserver when it has one (the server finds its own otherwise).
      let tsserver = from_workspace(root, "typescript/lib/tsserver.js");
      let mut spec = from_workspace(root, "typescript-language-server/package.json")
        .and_then(|pkg| {
          let v: Value = serde_json::from_slice(&std::fs::read(&pkg).ok()?).ok()?;
          let rel = match v.get("bin")? {
            Value::String(s) => s.clone(),
            b => b.get("typescript-language-server")?.as_str()?.to_string(),
          };
          via_node(pkg.parent()?.join(rel), &["--stdio"])
        })
        .or_else(|| on_path("typescript-language-server", &["--stdio"]))?;
      if let Some(t) = tsserver {
        spec.init_options = Some(json!({ "tsserver": { "path": t.to_string_lossy() } }));
      }
      Some(spec)
    }
    "clangd" => on_path("clangd", &["--background-index"]),
    "pyright" => from_workspace(root, "pyright/langserver.index.js")
      .and_then(|e| via_node(e, &["--stdio"]))
      .or_else(|| on_path("pyright-langserver", &["--stdio"])),
    "gopls" => on_path("gopls", &[]),
    "rust" => on_path("rust-analyzer", &[]),
    "bash" => from_workspace(root, "bash-language-server/out/cli.js")
      .and_then(|e| via_node(e, &["start"]))
      .or_else(|| on_path("bash-language-server", &["start"])),
    "yaml" => from_workspace(root, "yaml-language-server/bin/yaml-language-server")
      .and_then(|e| via_node(e, &["--stdio"]))
      .or_else(|| on_path("yaml-language-server", &["--stdio"])),
    "svelte" => {
      if let Some(mut s) = from_workspace(root, "svelte-language-server/bin/server.js").and_then(|e| via_node(e, &["--stdio"])) {
        // See src/main/lsp.ts: the client owns file watching (the server's own
        // chokidar watcher dies with EMFILE on a large root), and Monaco filters.
        s.client_watches_files = true;
        s.init_options = Some(json!({
          "configuration": { "typescript": {}, "javascript": {} },
          "dontFilterIncompleteCompletions": true
        }));
        return Some(s);
      }
      on_path("svelteserver", &["--stdio"])
    }
    _ => None,
  }
}

pub fn servers(root: &str) -> Vec<String> {
  KEYS.iter().filter(|k| resolve(k, root).is_some()).map(|k| k.to_string()).collect()
}

// ---- a running server ---------------------------------------------------------------

type Pending = oneshot::Sender<Result<Value, String>>;

struct Server {
  gen: u64,
  root: String,
  sender: Mutex<String>,
  out: mpsc::UnboundedSender<Value>,
  pending: Mutex<HashMap<u64, Pending>>,
  next_id: AtomicU64,
  /// None while initializing, then the initialize result (or its error).
  init: watch::Receiver<Option<Result<Value, String>>>,
  open_docs: Mutex<HashSet<String>>,
  idle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
  child: Mutex<Option<Child>>,
}

impl Server {
  async fn initialized(&self) -> Result<Value, String> {
    let mut rx = self.init.clone();
    loop {
      if let Some(r) = rx.borrow().clone() {
        return r;
      }
      if rx.changed().await.is_err() {
        return Err("server exited before it initialized".into());
      }
    }
  }
  fn request(&self, method: &str, params: Value) -> oneshot::Receiver<Result<Value, String>> {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    self.pending.lock().unwrap().insert(id, tx);
    let mut m = json!({ "jsonrpc": "2.0", "id": id, "method": method });
    if !params.is_null() {
      m["params"] = params;
    }
    if self.out.send(m).is_err() {
      if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(Err(format!("server not running ({method})")));
      }
    }
    rx
  }
  fn notify(&self, method: &str, params: Value) {
    let mut m = json!({ "jsonrpc": "2.0", "method": method });
    if !params.is_null() {
      m["params"] = params;
    }
    let _ = self.out.send(m);
  }
}

static SERVERS: OnceLock<Mutex<HashMap<String, Arc<Server>>>> = OnceLock::new();
static STARTS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
static GEN: AtomicU64 = AtomicU64::new(1);

fn servers_map() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Server>>> {
  SERVERS.get_or_init(Default::default).lock().unwrap()
}

fn start_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
  STARTS.get_or_init(Default::default).lock().unwrap().entry(key.to_string()).or_default().clone()
}

fn get(key: &str) -> Option<Arc<Server>> {
  servers_map().get(key).cloned()
}

/// Drop `key` from the registry if it is still this instance.
fn forget(key: &str, gen: u64) {
  let mut m = servers_map();
  if m.get(key).is_some_and(|s| s.gen == gen) {
    m.remove(key);
  }
}

fn capabilities(spec: &Spec) -> Value {
  let mut workspace = json!({ "configuration": true, "workspaceFolders": true, "applyEdit": false });
  if spec.client_watches_files {
    workspace["didChangeWatchedFiles"] = json!({ "dynamicRegistration": true });
  }
  json!({
    "textDocument": {
      "synchronization": { "dynamicRegistration": false, "didSave": true },
      "completion": {
        "dynamicRegistration": false,
        "contextSupport": true,
        "completionItem": {
          "snippetSupport": true,
          "documentationFormat": ["markdown", "plaintext"],
          "resolveSupport": { "properties": ["documentation", "detail"] }
        }
      },
      "hover": { "dynamicRegistration": false, "contentFormat": ["markdown", "plaintext"] },
      "signatureHelp": {
        "dynamicRegistration": false,
        "signatureInformation": { "documentationFormat": ["markdown", "plaintext"] }
      },
      "definition": { "dynamicRegistration": false, "linkSupport": false },
      "references": { "dynamicRegistration": false },
      "implementation": { "dynamicRegistration": false, "linkSupport": false },
      "typeDefinition": { "dynamicRegistration": false, "linkSupport": false },
      "publishDiagnostics": { "relatedInformation": true }
    },
    "workspace": workspace
  })
}

async fn write_msg(stdin: &mut ChildStdin, m: &Value) -> std::io::Result<()> {
  let body = serde_json::to_vec(m).unwrap_or_default();
  stdin.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await?;
  stdin.write_all(&body).await?;
  stdin.flush().await
}

/// The answer to a server -> client request.
fn answer(method: &str, params: &Value) -> Value {
  match method {
    "workspace/configuration" => match params.get("items").and_then(Value::as_array) {
      Some(items) => Value::Array(items.iter().map(|_| json!({})).collect()),
      None => json!([]),
    },
    "workspace/applyEdit" => json!({ "applied": false }),
    _ => Value::Null,
  }
}

fn spawn(key: &str, root: &str, label: &str) -> Result<Arc<Server>, String> {
  let spec = resolve(key, root).ok_or_else(|| format!("LSP server {key} is not installed"))?;
  let mut cmd = crate::services::shell_env::tokio_command(&spec.command);
  cmd
    .args(&spec.args)
    .current_dir(root)
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
  let mut child = cmd.spawn().map_err(|e| format!("spawn {} {e}", spec.command.display()))?;
  let mut stdin = child.stdin.take().ok_or("no stdin")?;
  let stdout = child.stdout.take().ok_or("no stdout")?;
  let stderr = child.stderr.take();

  let gen = GEN.fetch_add(1, Ordering::Relaxed);
  let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
  let (init_tx, init_rx) = watch::channel::<Option<Result<Value, String>>>(None);
  let server = Arc::new(Server {
    gen,
    root: root.to_string(),
    sender: Mutex::new(label.to_string()),
    out: out_tx,
    pending: Mutex::new(HashMap::new()),
    next_id: AtomicU64::new(1),
    init: init_rx,
    open_docs: Mutex::new(HashSet::new()),
    idle: Mutex::new(None),
    child: Mutex::new(Some(child)),
  });

  if let Some(err) = stderr {
    let key = key.to_string();
    tauri::async_runtime::spawn(async move {
      let mut lines = BufReader::new(err).lines();
      while let Ok(Some(l)) = lines.next_line().await {
        let l = l.trim();
        if !l.is_empty() {
          eprintln!("[lsp:{key}] {l}");
        }
      }
    });
  }

  // Reader: responses to their waiters, server requests answered, notifications
  // to the page that last started this server.
  {
    let s = server.clone();
    let key = key.to_string();
    tauri::async_runtime::spawn(async move {
      let mut r = BufReader::new(stdout);
      loop {
        let mut len: Option<usize> = None;
        loop {
          let mut h = String::new();
          match r.read_line(&mut h).await {
            Ok(0) | Err(_) => return exited(&key, &s).await,
            Ok(_) => {}
          }
          let h = h.trim_end();
          if h.is_empty() {
            break;
          }
          if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
              len = v.trim().parse().ok();
            }
          }
        }
        let Some(n) = len else { continue };
        let mut body = vec![0u8; n];
        if r.read_exact(&mut body).await.is_err() {
          return exited(&key, &s).await;
        }
        let Ok(m) = serde_json::from_slice::<Value>(&body) else { continue };
        let method = m.get("method").and_then(Value::as_str);
        let id = m.get("id").filter(|v| !v.is_null());
        match (method, id) {
          (Some(method), Some(id)) => {
            let res = answer(method, m.get("params").unwrap_or(&Value::Null));
            let _ = s.out.send(json!({ "jsonrpc": "2.0", "id": id, "result": res }));
          }
          (Some(method), None) => {
            let label = s.sender.lock().unwrap().clone();
            send_page(&label, "lsp:notify", json!([{ "serverKey": key, "method": method, "params": m.get("params").cloned().unwrap_or(Value::Null) }]));
          }
          (None, Some(id)) => {
            let Some(id) = id.as_u64() else { continue };
            let tx = s.pending.lock().unwrap().remove(&id);
            if let Some(tx) = tx {
              let r = match m.get("error") {
                Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("request failed").to_string()),
                None => Ok(m.get("result").cloned().unwrap_or(Value::Null)),
              };
              let _ = tx.send(r);
            }
          }
          _ => {}
        }
      }
    });
  }

  // Writer: initialize first; everything else waits for its answer, in order.
  {
    let s = server.clone();
    let root_uri = format!("file://{root}");
    let name = root.rsplit('/').next().unwrap_or("").to_string();
    let mut params = json!({
      "processId": std::process::id(),
      "rootUri": root_uri,
      "workspaceFolders": [{ "uri": root_uri, "name": name }],
      "capabilities": capabilities(&spec),
    });
    if let Some(o) = &spec.init_options {
      params["initializationOptions"] = o.clone();
    }
    let init_rx = {
      let (tx, rx) = oneshot::channel();
      s.pending.lock().unwrap().insert(0, tx);
      rx
    };
    tauri::async_runtime::spawn(async move {
      let first = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": params });
      if write_msg(&mut stdin, &first).await.is_err() {
        let _ = init_tx.send(Some(Err("server closed its input".into())));
        return;
      }
      let r = init_rx.await.unwrap_or_else(|_| Err("server exited before it initialized".into()));
      let ok = r.is_ok();
      if ok && write_msg(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} })).await.is_err() {
        return;
      }
      let _ = init_tx.send(Some(r));
      if !ok {
        return;
      }
      while let Some(m) = out_rx.recv().await {
        if write_msg(&mut stdin, &m).await.is_err() {
          break;
        }
      }
      drop(s);
    });
  }
  Ok(server)
}

async fn exited(key: &str, s: &Arc<Server>) {
  let code = {
    let c = s.child.lock().unwrap().take();
    match c {
      Some(mut c) => c.wait().await.ok(),
      None => None,
    }
  };
  if let Some(st) = code {
    if !st.success() {
      eprintln!("[lsp:{key}] exited ({st})");
    }
  }
  for (_, tx) in s.pending.lock().unwrap().drain() {
    let _ = tx.send(Err(format!("server {key} exited")));
  }
  forget(key, s.gen);
}

fn stop_server(key: &str, s: &Arc<Server>) {
  if let Some(h) = s.idle.lock().unwrap().take() {
    h.abort();
  }
  let _ = s.request("shutdown", Value::Null);
  s.notify("exit", Value::Null);
  if let Some(mut c) = s.child.lock().unwrap().take() {
    let _ = c.start_kill();
  }
  forget(key, s.gen);
}

// ---- the channels ---------------------------------------------------------------------

pub async fn start(key: String, root: String, label: String) -> Result<Value, String> {
  let lock = start_lock(&key);
  let server = {
    let _g = lock.lock().await;
    match get(&key) {
      Some(s) if s.root == root => {
        *s.sender.lock().unwrap() = label; // a reload: notifications go to the new page
        s
      }
      other => {
        // A different root (workspace switch): that server indexes the old
        // project; replace it.
        if let Some(old) = other {
          old.notify("exit", Value::Null);
          if let Some(mut c) = old.child.lock().unwrap().take() {
            let _ = c.start_kill();
          }
          forget(&key, old.gen);
        }
        let s = spawn(&key, &root, &label)?;
        servers_map().insert(key.clone(), s.clone());
        s
      }
    }
  };
  server.initialized().await
}

pub async fn request(key: String, method: String, params: Value) -> Result<Value, String> {
  let s = get(&key).ok_or_else(|| format!("server {key} not started"))?;
  s.initialized().await?;
  s.request(&method, params).await.unwrap_or_else(|_| Err(format!("server {key} exited")))
}

pub fn notify(key: String, method: String, params: Value) {
  let Some(s) = get(&key) else { return };
  track_open_docs(&key, &s, &method, &params);
  s.notify(&method, params);
}

fn track_open_docs(key: &str, s: &Arc<Server>, method: &str, params: &Value) {
  let Some(uri) = params.get("textDocument").and_then(|d| d.get("uri")).and_then(Value::as_str) else { return };
  match method {
    "textDocument/didOpen" => {
      s.open_docs.lock().unwrap().insert(uri.to_string());
      if let Some(h) = s.idle.lock().unwrap().take() {
        h.abort();
      }
    }
    "textDocument/didClose" => {
      let empty = {
        let mut d = s.open_docs.lock().unwrap();
        d.remove(uri);
        d.is_empty()
      };
      let mut idle = s.idle.lock().unwrap();
      if !empty || idle.is_some() {
        return;
      }
      let (key, s2, wait) = (key.to_string(), s.clone(), idle_stop());
      *idle = Some(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(wait).await;
        s2.idle.lock().unwrap().take();
        let current = get(&key).is_some_and(|c| c.gen == s2.gen);
        if !current || !s2.open_docs.lock().unwrap().is_empty() {
          return;
        }
        eprintln!("[lsp:{key}] no open files for {}min, stopping", wait.as_secs() / 60);
        stop_server(&key, &s2);
        // The editor remembers it started this server; the next file of the
        // language starts a fresh one.
        let label = s2.sender.lock().unwrap().clone();
        send_page(&label, "lsp:stopped", json!([key]));
      }));
    }
    _ => {}
  }
}

pub fn stop_root(root: &str) -> usize {
  let list: Vec<(String, Arc<Server>)> = servers_map().iter().filter(|(_, s)| s.root == root).map(|(k, s)| (k.clone(), s.clone())).collect();
  for (k, s) in &list {
    stop_server(k, s);
    let label = s.sender.lock().unwrap().clone();
    send_page(&label, "lsp:stopped", json!([k]));
  }
  list.len()
}

/// Quit: don't orphan the heavy indexers.
pub fn shutdown() {
  let list: Vec<(String, Arc<Server>)> = servers_map().drain().collect();
  for (_, s) in list {
    let _ = s.request("shutdown", Value::Null);
    s.notify("exit", Value::Null);
    if let Some(mut c) = s.child.lock().unwrap().take() {
      let _ = c.start_kill();
    }
  }
}
