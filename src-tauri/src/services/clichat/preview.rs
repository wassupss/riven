// Best-effort live text from the hidden pty's screen.
//
// The transcript lands per message, not per token, so while a reply streams
// the only place its text exists is the TUI's own rendering. This reads that
// rendering back from the VT model: the reply under the last assistant
// bullet, above the input box. It is a heuristic over another program's
// layout and is kept tolerant: anything it does not recognise yields None,
// and the page then just shows a working indicator. The JSONL version always
// replaces whatever this produced.
//
// Layout it expects (Claude Code 2.1.x, wide pty so nothing wraps):
//
//   ❯ the prompt the person sent            <- echo of the user turn
//
//   ⏺ First line of the reply               <- assistant bullet
//     continuation lines, indented two
//
//   ✻ Puttering… (3s · esc to interrupt)    <- spinner / status
//   ─────────────────────────────────        <- input box top rule
//   ❯                                         <- input line
//   ─────────────────────────────────
//     status lines

const BULLET: char = '⏺';
const PROMPT: char = '❯';
const SPINNERS: &[char] = &['✻', '✶', '✳', '✢', '✽', '·', '*', '∗', '◐', '◓', '◑', '◒'];

fn is_rule(line: &str) -> bool {
  let t = line.trim();
  t.chars().count() >= 20 && t.chars().all(|c| c == '─' || c == '━' || c == '-')
}

// The spinner line ("✻ Puttering… (3s · esc to interrupt)") or a status
// line in the middle of a turn.
fn is_status(line: &str) -> bool {
  let t = line.trim_start();
  let Some(first) = t.chars().next() else { return false };
  SPINNERS.contains(&first) && (t.contains('…') || t.contains("esc to interrupt") || t.contains("tokens"))
}

// "⏺ Write(note.txt)" / "⏺ Bash(ls)" / "⏺ Read 2 files (ctrl+o to expand)":
// a tool call, not prose.
fn is_tool_head(rest: &str, next: Option<&str>) -> bool {
  if next.is_some_and(|n| n.trim_start().starts_with('⎿')) {
    return true;
  }
  let name_len = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == ':' || *c == '-').count();
  name_len > 0 && rest.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && rest[name_len..].starts_with('(')
}

/// The reply being streamed, or None when the screen does not look like one.
pub fn extract(screen: &str) -> Option<String> {
  let lines: Vec<&str> = screen.lines().map(|l| l.trim_end()).collect();
  // The input box: a prompt line with a rule right above it, from the
  // bottom (the reply above may itself contain rules or ❯).
  let mut top_rule = None;
  for i in (1..lines.len()).rev() {
    if lines[i].trim_start().starts_with(PROMPT) && is_rule(lines[i - 1]) {
      top_rule = Some(i - 1);
      break;
    }
  }
  let region = &lines[..top_rule?];
  // This turn starts at the last echo of a prompt.
  let start = region.iter().rposition(|l| l.starts_with(PROMPT)).map(|i| i + 1).unwrap_or(0);
  let turn = &region[start..];
  let b = turn.iter().rposition(|l| l.starts_with(BULLET))?;
  let rest = turn[b].trim_start_matches(BULLET).trim_start();
  if is_tool_head(rest, turn.get(b + 1).copied()) {
    return None;
  }
  let mut out: Vec<String> = vec![rest.to_string()];
  for l in &turn[b + 1..] {
    // The reply's own lines are indented two columns (or blank). Anything
    // else is the TUI again: the spinner, "✻ Worked for 3s", the next
    // bullet, a tool's ⎿ result, a right-aligned indicator.
    let indent = l.len() - l.trim_start().len();
    let blank = l.trim().is_empty();
    if !blank && (indent < 2 || indent > 40 || is_status(l) || l.trim_start().starts_with('⎿')) {
      break;
    }
    out.push(l.strip_prefix("  ").unwrap_or(l).to_string());
  }
  while out.last().is_some_and(|l| l.trim().is_empty()) {
    out.pop();
  }
  let text = out.join("\n").trim().to_string();
  (!text.is_empty()).then_some(text)
}

/// Whether the CLI is up and waiting at its input box (and not showing a
/// dialog that only the terminal view can answer).
#[cfg(test)]
pub fn input_ready(screen: &str) -> bool {
  has_input_box(screen) && blocked(screen).is_none()
}

/// The input box is on screen. When it is not (and nothing else explains
/// it), the CLI is showing a menu or dialog: /cost, /model without an
/// argument, an AskUserQuestion picker.
pub fn has_input_box(screen: &str) -> bool {
  let lines: Vec<&str> = screen.lines().collect();
  (1..lines.len()).any(|i| lines[i].trim_start().starts_with(PROMPT) && is_rule(lines[i - 1]))
}

/// A full-screen question the chat view cannot render: the folder trust
/// dialog on first run in a directory, a login prompt.
pub fn blocked(screen: &str) -> Option<&'static str> {
  let low = screen.to_lowercase();
  if low.contains("trust this folder") || low.contains("do you trust the files") {
    return Some("trust");
  }
  if low.contains("select login method") || low.contains("/login") && low.contains("not logged in") {
    return Some("login");
  }
  None
}

/// A numbered menu the TUI is showing (plan approval, the trust dialog, a
/// permission dialog answered in the terminal, any list picker): what the
/// chat view draws as buttons, answered with arrows + Enter.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Menu {
  pub title: String,
  pub options: Vec<MenuOption>,
  /// Index into options of the highlighted row (the ❯ one).
  pub selected: usize,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuOption {
  pub label: String,
  /// Selecting it opens a text field in the row ("Tell Claude what to
  /// change"): the answer is typed there, then Enter.
  pub input: bool,
}

// "❯ 2. Banana" / "  3. Tell Claude what to change" -> (selected, 2, label)
fn option_line(line: &str) -> Option<(bool, u32, &str)> {
  let t = line.trim_start();
  // The highlighted row: ❯ (Claude Code) or › (Codex).
  let (sel, t) = match t.strip_prefix(PROMPT).or_else(|| t.strip_prefix('›')) {
    Some(r) => (true, r.trim_start()),
    None => (false, t),
  };
  let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
  if digits == 0 || digits > 2 {
    return None;
  }
  let n: u32 = t[..digits].parse().ok()?;
  let label = t[digits..].strip_prefix(". ")?.trim();
  (!label.is_empty()).then_some((sel, n, label))
}

fn input_label(label: &str) -> bool {
  let l = label.to_lowercase();
  // Not Codex's "No, and tell Codex what to do differently (esc)": that row
  // cancels, and its menu takes letters as shortcuts, so nothing is typed.
  !l.contains("tell codex") && (l.contains("tell claude") || l.contains("type something") || l.contains("what to do differently"))
}

/// The last numbered menu on the screen (1, 2, 3... in order, description
/// lines and rules between them allowed), with the line or two above it as
/// its title. None when there is no such list of at least two options.
pub fn menu(screen: &str) -> Option<Menu> {
  let lines: Vec<&str> = screen.lines().map(|l| l.trim_end()).collect();
  let parsed: Vec<Option<(bool, u32, &str)>> = lines.iter().map(|l| option_line(l)).collect();
  let start = (0..lines.len()).rev().find(|&i| matches!(parsed[i], Some((_, 1, _))))?;
  let mut options = Vec::new();
  let mut selected = 0;
  for (want, (sel, n, label)) in (1..).zip(parsed[start..].iter().flatten()) {
    if *n != want {
      break;
    }
    if *sel {
      selected = options.len();
    }
    options.push(MenuOption { label: label.to_string(), input: input_label(label) });
  }
  if options.len() < 2 {
    return None;
  }
  let mut title: Vec<&str> = Vec::new();
  for l in lines[..start].iter().rev() {
    let t = l.trim();
    if t.is_empty() || is_rule(l) || t.chars().all(|c| c == '╌' || c == '▔' || c == '─') {
      if title.is_empty() {
        continue;
      }
      break;
    }
    // The conversation above the dialog (a tool call, its result).
    if t.starts_with(BULLET) || t.starts_with('⎿') {
      break;
    }
    title.push(t);
    if title.len() == 2 {
      break;
    }
  }
  title.reverse();
  Some(Menu { title: title.join(" "), options, selected })
}

/// Keys that move the highlight from `from` to `to` and pick it, typing
/// `text` into the row first when it is a text option.
pub fn menu_keys(from: usize, to: usize, text: Option<&str>) -> String {
  let mut k = String::new();
  let step = if to > from { "\x1b[B" } else { "\x1b[A" };
  for _ in 0..from.abs_diff(to) {
    k.push_str(step);
  }
  if let Some(t) = text.map(|t| t.replace(['\n', '\r'], " ")).filter(|t| !t.trim().is_empty()) {
    k.push_str(&t);
  }
  k
}

#[cfg(test)]
mod tests {
  use super::*;

  const RULE: &str = "────────────────────────────────────────────────────────────";

  fn screen(body: &[&str]) -> String {
    let mut v: Vec<String> = body.iter().map(|s| s.to_string()).collect();
    v.push(RULE.into());
    v.push("❯ ".into());
    v.push(RULE.into());
    v.push("  ⏵⏵ auto mode on (shift+tab to cycle)".into());
    v.join("\n")
  }

  #[test]
  fn reads_the_streaming_reply() {
    let s = screen(&[
      " ▐▛███▜▌   Claude Code v2.1.330",
      "",
      "❯ earlier question",
      "",
      "⏺ old answer",
      "",
      "❯ Explain it",
      "",
      "⏺ First line of the answer",
      "  second line",
      "",
      "  - a list item",
      "",
      "✻ Puttering… (3s · esc to interrupt)",
      "",
    ]);
    assert_eq!(extract(&s).as_deref(), Some("First line of the answer\nsecond line\n\n- a list item"));
    assert!(input_ready(&s));
  }

  // As 2.1.330 drew it in the measurement run: the finished-turn line and
  // the right-aligned effort indicator sit between the reply and the box.
  #[test]
  fn stops_at_the_tui_lines_after_the_reply() {
    let pad = " ".repeat(150);
    let s = screen(&["❯ Reply with exactly: alpha", "⏺ alpha", "", "✻ Worked for 0s · done 1:59 PM", "", "", &format!("{pad}◐ medium · /effort")]);
    assert_eq!(extract(&s).as_deref(), Some("alpha"));
    let s = screen(&["❯ q", "⏺ 42", "", &format!("{pad}◐ medium · /effort")]);
    assert_eq!(extract(&s).as_deref(), Some("42"));
  }

  #[test]
  fn none_before_any_reply_and_for_tool_calls() {
    let waiting = screen(&["❯ Explain it", "", "✻ Thinking… (1s · esc to interrupt)"]);
    assert_eq!(extract(&waiting), None);
    let tool = screen(&["❯ write it", "", "⏺ Write(note.txt)", "  ⎿  Wrote 1 lines to note.txt", "", "✶ Brewing…"]);
    assert_eq!(extract(&tool), None);
    let tool2 = screen(&["❯ write it", "", "⏺ Bash(echo hi)", "", "✶ Brewing…"]);
    assert_eq!(extract(&tool2), None);
  }

  #[test]
  fn text_after_a_tool_call_is_the_reply() {
    let s = screen(&["❯ write it", "", "⏺ Write(note.txt)", "  ⎿  Wrote 1 lines", "", "⏺ Done, the file", "  is written.", ""]);
    assert_eq!(extract(&s).as_deref(), Some("Done, the file\nis written."));
  }

  // As 2.1.330 drew them in the live probes (trimmed).
  const PLAN: &str = "  ⎿  /plan to preview
  ──────────────────────────────────────────────────────────────
   Ready to code?
   Here is Claude's plan:
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   Create plan-test.txt in the working directory containing the word hi.
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  ──────────────────────────────────────────────────────────────
   Claude has written up a plan and is ready to execute. Would you like to proceed?
   ❯ 1. Yes, and use auto mode
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this feedback
   ctrl+g to edit in Vim · ~/.claude/plans/plan-create-a-file.md";

  const ASK: &str = "❯ Use the AskUserQuestion tool
────────────────────────────────────────────────────────────────
 ☐ Fruit
Which fruit do you prefer?
  1. Apple
     Choose apple
❯ 2. Banana
     Choose banana
  3. Type something.
────────────────────────────────────────────────────────────────
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel";

  #[test]
  fn reads_menus() {
    let m = menu(PLAN).unwrap();
    assert_eq!(m.title, "Claude has written up a plan and is ready to execute. Would you like to proceed?");
    assert_eq!(m.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Yes, and use auto mode", "Yes, manually approve edits", "Tell Claude what to change"]);
    assert_eq!(m.selected, 0);
    assert!(m.options[2].input && !m.options[0].input);
    assert!(!has_input_box(PLAN));
    let a = menu(ASK).unwrap();
    assert_eq!(a.options.len(), 4);
    assert_eq!(a.selected, 1);
    assert_eq!(a.title, "☐ Fruit Which fruit do you prefer?");
    assert!(a.options[2].input);
    let trust = "Quick safety check: Is this a project you created or one you trust?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel";
    let t = menu(trust).unwrap();
    assert_eq!(t.options[1].label, "No, exit");
    assert_eq!(t.title, "Quick safety check: Is this a project you created or one you trust?");
    // A numbered list in a reply is not a menu once a later list restarts,
    // and a lone "1." is not one either.
    assert_eq!(menu("⏺ Steps:\n  1. only one\n"), None);
    let perm = "⏺ Write(plan-test.txt)\n Do you want to create plan-test.txt?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n   3. No\n Esc to cancel · Tab to amend";
    let p = menu(perm).unwrap();
    assert_eq!((p.title.as_str(), p.options.len()), ("Do you want to create plan-test.txt?", 3));
  }

  #[test]
  fn keys_for_a_menu_pick() {
    assert_eq!(menu_keys(0, 2, None), "\x1b[B\x1b[B");
    assert_eq!(menu_keys(3, 1, None), "\x1b[A\x1b[A");
    assert_eq!(menu_keys(0, 2, Some("say hello\ninstead")), "\x1b[B\x1b[Bsay hello instead");
    assert_eq!(menu_keys(1, 1, Some("  ")), "");
  }

  #[test]
  fn tolerant_of_unknown_screens() {
    assert_eq!(extract(""), None);
    assert_eq!(extract("random\ntext\n❯ no rule above"), None);
    assert!(!input_ready("loading…"));
    let trust = "Accessing workspace:\n\n Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n";
    assert_eq!(blocked(trust), Some("trust"));
    // /cost as 2.1.330 draws it: a dialog, no input box.
    let dialog = "  What's contributing to your usage?\n  Last 24h\n  ←/→ to switch · Esc to close";
    assert!(!has_input_box(dialog));
    assert!(!input_ready(trust));
  }
}
