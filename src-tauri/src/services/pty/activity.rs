// What an agent in a terminal is doing, as a small state machine (port of
// src/main/terminal/activity.ts).
//
// Two sources feed it. Agent hooks (Claude Code's UserPromptSubmit / Stop /
// Notification, relayed by Node's hook route) are authoritative. The output
// heuristic (bytes flowing = working; quiet for a while = idle) is the
// fallback for agents without hooks, and it is switched off the moment a hook
// speaks for a session, so a TUI's idle spinner is never mistaken for work.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
  Working,
  Idle,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Attention {
  Finished,
  NeedsInput,
}

impl Attention {
  pub fn as_str(self) -> &'static str {
    match self {
      Attention::Finished => "finished",
      Attention::NeedsInput => "needs_input",
    }
  }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HookEvent {
  Working,
  Idle,
  NeedsInput,
}

impl HookEvent {
  pub fn parse(s: &str) -> Option<HookEvent> {
    match s {
      "working" => Some(HookEvent::Working),
      "idle" => Some(HookEvent::Idle),
      "needs_input" => Some(HookEvent::NeedsInput),
      _ => None,
    }
  }
}

pub struct Activity {
  pub state: State,
  pub attention: Option<Attention>,
  /// Once true, the output heuristic is ignored for this terminal.
  pub hook_driven: bool,
}

impl Default for Activity {
  fn default() -> Self {
    Activity { state: State::Idle, attention: None, hook_driven: false }
  }
}

impl Activity {
  /// Apply a hook event. Returns the attention reason to notify about, if
  /// this transition produced one.
  pub fn hook(&mut self, ev: HookEvent) -> Option<Attention> {
    self.hook_driven = true;
    match ev {
      HookEvent::Working => self.set(State::Working, None),
      // Finishing is only news if it was working; a Stop after Stop is noise.
      HookEvent::Idle => {
        let a = if self.state == State::Working { Some(Attention::Finished) } else { self.attention };
        self.set(State::Idle, a)
      }
      HookEvent::NeedsInput => self.set(State::Idle, Some(Attention::NeedsInput)),
    }
  }

  /// Output-flow heuristic. No-op once hooks have been seen.
  pub fn heuristic(&mut self, state: State) -> Option<Attention> {
    if self.hook_driven {
      return None;
    }
    if state == State::Working {
      return self.set(State::Working, None);
    }
    let a = if self.state == State::Working { Some(Attention::Finished) } else { self.attention };
    self.set(State::Idle, a)
  }

  /// The user looked: attention is delivered.
  pub fn clear_attention(&mut self) -> bool {
    self.attention.take().is_some()
  }

  /// The agent EXITED. State goes idle unconditionally; only an unread
  /// 'finished' survives (a one-shot run finishes and quits in one breath).
  pub fn agent_gone(&mut self) {
    self.state = State::Idle;
    self.hook_driven = false;
    if self.attention == Some(Attention::NeedsInput) {
      self.attention = None;
    }
  }

  fn set(&mut self, state: State, attention: Option<Attention>) -> Option<Attention> {
    let was = self.attention;
    if state == self.state && attention == was {
      return None;
    }
    self.state = state;
    self.attention = attention;
    // News = attention newly raised (not merely kept).
    match attention {
      Some(a) if Some(a) != was => Some(a),
      _ => None,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn hook_turns() {
    let mut a = Activity::default();
    assert_eq!(a.hook(HookEvent::Working), None);
    assert_eq!(a.hook(HookEvent::Idle), Some(Attention::Finished));
    assert_eq!(a.hook(HookEvent::Idle), None);
    assert_eq!(a.heuristic(State::Working), None);
    assert!(a.clear_attention());
    assert_eq!(a.hook(HookEvent::NeedsInput), Some(Attention::NeedsInput));
    a.agent_gone();
    assert_eq!(a.attention, None);
  }

  #[test]
  fn heuristic_until_hooked() {
    let mut a = Activity::default();
    assert_eq!(a.heuristic(State::Working), None);
    assert_eq!(a.heuristic(State::Idle), Some(Attention::Finished));
    a.agent_gone();
    assert_eq!(a.attention, Some(Attention::Finished));
  }
}
