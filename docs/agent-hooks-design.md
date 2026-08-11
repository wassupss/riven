# Agent hooks - replacing viewport polling

## Why

riven derived a terminal pane's busy/idle state by dumping the visible viewport with
`ghostty_surface_read_text` every 0.3 s, per pane, forever (the timer was never paused
for hidden tabs or background workspaces).

Measured on a live 0.0.1 build, 2026-07-27:

| uptime | phys_footprint | MALLOC_SMALL |
|--------|---------------|--------------|
| 9m12s  | 754 MB        | 178 MB       |
| 28m15s | 957 MB        | 355 MB       |

`MALLOC_SMALL` grew **9.3 MB/min, perfectly linearly** - ~558 MB/hour, which is the
reported "6 GB after a long session". `leaks` confirmed genuinely unreferenced blocks
(32,522 leaks / 167 MB at 25 min), all in 5–24 KB size classes, appearing at ~13.3/s
- exactly (number of panes) × 3.33 Hz. Two `heap` snapshots 10.4 min apart showed
every AppKit view/constraint class flat, so this was not a view leak; it was the text
buffer from each `read_text` call.

libghostty's own header says of that API: *"This is an expensive operation so it
shouldn't be called too often. We recommend that callers cache the result and throttle
calls to this function."*

cmux (same architecture - Swift + libghostty) does not poll at all. It takes status
from OSC 9/99/777 escapes and from agent lifecycle hooks. This is that approach,
adapted.

## Verified facts

Probed against Claude Code with `claude --init-only` (runs Setup + SessionStart hooks
and exits without starting a conversation, so it costs no tokens):

1. **`--settings` deep-merges the `hooks` key.** A user hook in `CLAUDE_CONFIG_DIR`'s
   `settings.json` and a riven hook passed via `--settings` both fired. So riven can
   inject hooks without touching - or having to read and re-emit - the user's config.
   This was the single largest design risk and it is resolved.
2. **Hook processes inherit the pane's environment.** `RIVEN_PANE_SESSION` set on the
   terminal surface was readable from the hook process.
3. **Payload arrives on stdin as JSON** with `session_id`, `transcript_path`, `cwd`,
   `hook_event_name`.

Fact 2 is what makes the design agent-agnostic. The obvious routing key would be the
payload's `session_id` (riven already launches `claude --session-id <paneUUID>`), but
Codex has no way to be launched with a caller-chosen session id. Routing on the
inherited env var instead works for any agent that spawns hooks as child processes.

End-to-end verified: real Claude Code hook → `riven-hook` → unix socket → envelope
with the expected shape.

## Architecture

```
Claude Code / Codex  (the pane's command)
  │  hook fires, payload on stdin, async
  ▼
riven-hook <agent> <event>          Contents/MacOS/riven-hook
  │  reads $RIVEN_PANE_SESSION from its own env
  │  {"v":1,"agent":…,"event":…,"pane":<uuid>,"payload":{…}}\n
  ▼
AF_UNIX  ~/Library/Application Support/riven-native/hooks.sock   (0700 dir, 0600 sock)
  │
  ▼
AgentHookServer → AgentEvent.decode → PaneSessionRegistry → pane state machine
```

Three signal tiers, one active per pane:

| tier | pane kind | signal | idle cost |
|---|---|---|---|
| A | agent pane with hooks | lifecycle events | 0 |
| B | plain shell | Enter → busy, `GHOSTTY_ACTION_COMMAND_FINISHED` → idle | 0 |
| C | anything else | OSC 9/777, bell, child-exited | 0 |

Tier B uses the ghostty actions riven currently ignores. That decision was correct for
*agent TUIs* (they never emit `COMMAND_FINISHED`) but wrong for plain shells, where
OSC 133 is accurate. Splitting by pane kind makes both judgements right.

A pane stays on C until its first hook event arrives, then promotes to A
(`PaneSessionRegistry.markHookBacked`). A pane whose agent never delivers hooks is
therefore never stuck looking idle.

## State machine

| event | busy | attn | notify |
|---|---|---|---|
| `SessionStart` | false | false | - |
| `UserPromptSubmit` | **true** | false | - |
| `PermissionRequest` | false | **true** | tool awaiting approval |
| `Notification` | - | **true** | `message` |
| `Stop` | **false** | true if unwatched | `last_assistant_message` |
| `StopFailure` | false | **true** | `error_message` |

`Stop.last_assistant_message` replaces `lastAgentMessage()` - ~55 lines of regex that
filtered spinners, box-drawing, token counters and status lines out of scraped screen
text to guess what the agent said. The agent now just tells us.

`PermissionRequest` is a state riven could not previously represent: screen scraping
cannot distinguish "working" from "waiting for you to approve a tool".

Notification dedupe keys on `prompt_id` (one banner per turn). cmux has to hash
status+message because it lacks that field.

## Deliberate departures from cmux

| | cmux | riven |
|---|---|---|
| hook install | writes into user agent config | `--settings` / argv, user config untouched |
| routing key | dedicated plumbing | existing `RIVEN_PANE_SESSION` env |
| agent coverage | 8-agent catalog | Claude Code + Codex; others fall back to tier C |
| notify dedupe | status + message hash | `prompt_id` |

## Codex - UNVERIFIED

Codex documents the same hook event names and payload schema, loaded from
`$CODEX_HOME/hooks.json` or an inline `[hooks]` config section, gated on
`features.hooks = true`.

`AgentHooksInstall.codexLaunchOverrides()` implements the argv form (`-c` overrides)
so no user config is touched, but **Codex is not installed on the development machine
and this path has never been executed**. It is therefore behind the `codexHooks`
setting, default **off**: an unrecognised `-c` key would make the agent fail to launch,
and a dead pane is a much worse outcome than missing status badges.

To validate:

```
codex -c features.hooks=true \
      -c 'hooks.Stop=[{hooks=[{type="command",command="/bin/echo hi"}]}]'
```

If Codex starts and the hook runs at turn end, flip the default on and delete the
notice in `AgentHooksInstall`.

## Security

- socket in a 0700 directory, `chmod 0600` - filesystem permissions are the auth
- 256 KB line cap, 250 ms receive timeout, one line per connection
- `pane` must parse as a UUID **and** resolve in the registry; everything else dropped
- payload text is trimmed to 400 chars and only ever reaches a notification body -
  never a shell, never JS
- a stale socket is only reclaimed after a connect probe proves nothing is listening,
  so a second instance cannot steal a live one's socket

## Rollout

| PR | scope | status |
|---|---|---|
| 0 | probe `--settings` semantics | done - deep-merge confirmed |
| 1 | `riven-hook` target, `AgentHookServer`, registry, config generation. Not yet consumed | this branch |
| 2 | wire the state machine, delete `pollActivity()`; `agentActivitySource` setting for rollback | blocked on the in-flight per-pane session work |
| 3 | tier B shell integration, `PermissionRequest` UI, subagent badges, remove fallback | - |

Verification for PR 2 is the same measurement that found the leak: sample
`footprint -p <pid>` once a minute and confirm `MALLOC_SMALL` goes flat.

Per cmux's own guidance - *"Running heavy tools against a primary terminal-hosting
process can freeze the user's active terminal"* - `leaks`/`heap` should be run against
a dedicated profiling instance, not the one being used for work.
