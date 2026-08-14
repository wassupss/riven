## A refreshed agent chat

Streamed answers now appear smoothly, character by character, and raw markdown no longer flashes before tables, blockquotes, and code render. The done line shows a check with the elapsed time and token counts, and notices like a permission-mode switch or model change are now small chips.

## Commands are grouped together

Tool calls like Read, Bash, and Edit are collected into an "N commands" accordion so they no longer clutter the conversation. Expand it to see each command; commands with code open their code block on click. Edits show how much changed with +/- counts. When a session is restored after a restart, this command history comes back too.

## Stability and performance

Fixed a rare crash (broken pipe) while recording file changes, and the terminal now pauses drawing when the app is in the background or its tab is hidden, saving CPU.

## Also

This screen appears the first time you launch after an update. You can reopen it any time from Settings → About.
