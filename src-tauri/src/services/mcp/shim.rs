// The zsh startup dir riven owns (was setupShellShim in src/main/pty.ts),
// sourced INSTEAD of the user's (it sources theirs first). Its .zshrc defines
// `claude`/`codex` functions that inject riven's MCP server and agent hooks,
// so a CLI typed in a riven terminal gets the same tools as a chat pane.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static READY: AtomicBool = AtomicBool::new(false);

pub fn dir() -> PathBuf {
  crate::services::paths::user_data().join("zdotdir")
}

pub fn ready() -> bool {
  READY.load(Ordering::Relaxed)
}

fn sq(s: &str) -> String {
  format!("'{}'", s.replace('\'', "'\\''"))
}

const ZPROFILE: &str = r#"[ -r "$RIVEN_USER_ZDOTDIR/.zprofile" ] && source "$RIVEN_USER_ZDOTDIR/.zprofile""#;

const ZSHRC: &str = r#"[ -r "$RIVEN_USER_ZDOTDIR/.zshrc" ] && source "$RIVEN_USER_ZDOTDIR/.zshrc"
# riven: typing `claude` here gets riven's OWN tools (ask_user / open file /
# panels / browser / notes) and its lifecycle hooks, like the native chat pane.
if [ -n "$RIVEN_MCP_CONFIG" ]; then
  claude() {
    # Build flags in a zsh array, NOT via ${VAR:+--flag "$VAR"}: zsh does not
    # field-split parameter expansions, so that form passes '--flag value' to
    # claude as a single argv word and it rejects it.
    local -a rv
    rv+=(--mcp-config "$RIVEN_MCP_CONFIG")
    [ -n "$RIVEN_MCP_PROMPT" ] && rv+=(--append-system-prompt "$RIVEN_MCP_PROMPT")
    # Lifecycle hooks (deep-merged by the CLI, so the user's own hooks still fire).
    [ -n "$RIVEN_HOOKS_SETTINGS" ] && rv+=(--settings "$RIVEN_HOOKS_SETTINGS")
    command "${RIVEN_REAL_CLAUDE:-claude}" "${rv[@]}" "$@"
  }
fi
# The same for Codex: riven's MCP server and its hooks, as `-c` overrides (one
# per line of RIVEN_CODEX_ARGS), so the user's ~/.codex is never written to.
if [ -n "$RIVEN_CODEX_ARGS" ]; then
  codex() {
    local -a rv
    local line
    for line in "${(@f)RIVEN_CODEX_ARGS}"; do rv+=(-c "$line"); done
    command "${RIVEN_REAL_CODEX:-codex}" "${rv[@]}" "$@"
  }
fi
# Restore so .zlogin and any nested shell use the user's own dir, not ours.
export ZDOTDIR="$RIVEN_USER_ZDOTDIR""#;

/// Write the shim (0700 dir, 0600 files: everything here is SOURCED BY THE
/// SHELL). Once at start.
pub fn setup() {
  use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
  let d = dir();
  let r = (|| -> std::io::Result<()> {
    std::fs::create_dir_all(&d)?;
    std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700))?;
    let zshenv = format!(
      "ZDOTDIR=\"$HOME\"\n[ -r \"$HOME/.zshenv\" ] && source \"$HOME/.zshenv\"\nexport RIVEN_USER_ZDOTDIR=\"${{ZDOTDIR:-$HOME}}\"\nZDOTDIR={}",
      sq(&d.to_string_lossy())
    );
    for (name, body) in [(".zshenv", zshenv.as_str()), (".zprofile", ZPROFILE), (".zshrc", ZSHRC)] {
      let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(d.join(name))?;
      std::io::Write::write_all(&mut f, format!("{body}\n").as_bytes())?;
    }
    Ok(())
  })();
  match r {
    Ok(()) => READY.store(true, Ordering::Relaxed),
    Err(e) => {
      eprintln!("[riven] shell shim setup failed {e}");
      READY.store(false, Ordering::Relaxed);
    }
  }
}

/// The real `claude` / `codex` on the login PATH, resolved once (the shim's
/// functions call it by path, so they never call themselves).
pub async fn real_bin(cmd: &'static str) -> Option<String> {
  static CLAUDE: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();
  static CODEX: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();
  let cell = if cmd == "claude" { &CLAUDE } else { &CODEX };
  cell.get_or_init(|| crate::services::chat::util::resolve_bin(cmd)).await.clone()
}

pub(crate) fn user_has_codex_instructions() -> bool {
  let home = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| crate::services::paths::home().join(".codex"));
  let Ok(text) = std::fs::read_to_string(home.join("config.toml")) else { return false };
  regex::Regex::new(r"(?m)^\s*developer_instructions\s*=").map(|re| re.is_match(&text)).unwrap_or(false)
}

/// RIVEN_CODEX_ARGS for a terminal: one `-c` value per line.
pub fn codex_args(key: &str, names: &[String]) -> String {
  let url = super::pane_url(Some(names), Some(key));
  let instructions = (url.is_some() && !user_has_codex_instructions()).then(|| super::system_prompt(names));
  super::hooks::codex_config_overrides(url.as_deref(), instructions.as_deref(), (super::REQUEST_TIMEOUT_MS as f64 / 1000.0).round() as u64).join("\n")
}
