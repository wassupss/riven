// When a CLI chat session's process should go away or come back, as a pure
// decision over a snapshot of the session (tested without a pty).
//
// - Park: nothing has happened for PARK_AFTER and nothing is in flight. The
//   process is stopped (a parked CLI holds hundreds of MB and its MCP
//   children); the conversation stays on screen and the next message brings
//   it back with --resume.
// - Restart: something the running process cannot pick up by itself (a
//   model or permission mode chosen in the header, a new CLI binary on
//   disk). Never mid-turn, never with a question, menu or permission open:
//   it waits for the turn boundary.

use std::time::Duration;

pub const PARK_AFTER: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, Default)]
pub struct Snapshot {
  pub dead: bool,
  pub parked: bool,
  pub busy: bool,
  /// Permission cards or questions waiting on the person.
  pub asking: bool,
  /// A TUI menu or dialog is up (blocked).
  pub menu: bool,
  /// The terminal view is showing the pty: whatever the person is doing
  /// there is theirs.
  pub terminal: bool,
  /// Background agents or shells the CLI reported at its last Stop.
  pub background: bool,
  /// The header asked for another model or mode.
  pub reconfigure: bool,
  /// The CLI binary changed on disk since this process started.
  pub updated: bool,
  pub idle_for: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Next {
  Stay,
  Park,
  Restart(Why),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Why {
  Reconfigure,
  Update,
}

pub fn next(s: &Snapshot) -> Next {
  if s.dead || s.parked || s.busy || s.asking || s.menu || s.terminal {
    return Next::Stay;
  }
  if s.reconfigure {
    return Next::Restart(Why::Reconfigure);
  }
  if s.updated {
    return Next::Restart(Why::Update);
  }
  if !s.background && s.idle_for >= PARK_AFTER {
    return Next::Park;
  }
  Next::Stay
}

/// What identifies the CLI binary on disk: the resolved file (the installer
/// swaps a symlink to a new version folder) and its size and mtime.
#[derive(Clone, Debug, PartialEq)]
pub struct Fingerprint {
  pub path: std::path::PathBuf,
  pub len: u64,
  pub mtime: Option<std::time::SystemTime>,
}

pub fn fingerprint(bin: &std::path::Path) -> Option<Fingerprint> {
  let path = std::fs::canonicalize(bin).ok()?;
  let m = std::fs::metadata(&path).ok()?;
  Some(Fingerprint { path, len: m.len(), mtime: m.modified().ok() })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn idle(mins: u64) -> Snapshot {
    Snapshot { idle_for: Duration::from_secs(mins * 60), ..Default::default() }
  }

  #[test]
  fn parks_only_when_quiet_for_long_enough() {
    assert_eq!(next(&idle(29)), Next::Stay);
    assert_eq!(next(&idle(30)), Next::Park);
    for blocker in [
      Snapshot { busy: true, ..idle(90) },
      Snapshot { asking: true, ..idle(90) },
      Snapshot { menu: true, ..idle(90) },
      Snapshot { terminal: true, ..idle(90) },
      Snapshot { background: true, ..idle(90) },
      Snapshot { parked: true, ..idle(90) },
      Snapshot { dead: true, ..idle(90) },
    ] {
      assert_eq!(next(&blocker), Next::Stay, "{blocker:?}");
    }
  }

  #[test]
  fn restarts_wait_for_the_turn_boundary() {
    let want = Snapshot { reconfigure: true, ..idle(0) };
    assert_eq!(next(&want), Next::Restart(Why::Reconfigure));
    assert_eq!(next(&Snapshot { busy: true, ..want }), Next::Stay);
    assert_eq!(next(&Snapshot { asking: true, ..want }), Next::Stay);
    // A background agent does not hold a restart back: --resume brings the
    // conversation back, and the person asked for it.
    assert_eq!(next(&Snapshot { background: true, ..want }), Next::Restart(Why::Reconfigure));
    let upd = Snapshot { updated: true, ..idle(0) };
    assert_eq!(next(&upd), Next::Restart(Why::Update));
    assert_eq!(next(&Snapshot { menu: true, ..upd }), Next::Stay);
    // Both: the requested change wins (it restarts on the new binary anyway).
    assert_eq!(next(&Snapshot { reconfigure: true, ..upd }), Next::Restart(Why::Reconfigure));
  }

  #[test]
  fn fingerprints_follow_the_file() {
    let dir = std::env::temp_dir().join(format!("riven-life-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a");
    std::fs::write(&a, "v1").unwrap();
    let link = dir.join("claude");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&a, &link).unwrap();
    let f1 = fingerprint(&link).unwrap();
    let b = dir.join("b");
    std::fs::write(&b, "v2-longer").unwrap();
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&b, &link).unwrap();
    let f2 = fingerprint(&link).unwrap();
    assert_ne!(f1, f2);
    assert_eq!(fingerprint(&link), Some(f2));
    assert_eq!(fingerprint(&dir.join("missing")), None);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
