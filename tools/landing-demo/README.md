# Landing demo clip - source

`landing/assets/riven-demo.mp4` is **not** a screen recording of the app. It's a
synthetic mock: `index.html` draws a fake riven window (fake `taskflow` project,
fabricated code and git state, no real account) as a deterministic still frame per
`?f=N`, and the clip is those frames encoded in order.

Shot this way on purpose - a real capture leaks whatever is on screen (source,
commit messages, shell prompt, usage figures), and it has to be re-shot by hand
every time the UI moves. This one is text you can edit.

Because it's a mock, the chrome is only as accurate as what it was traced from -
so trace it from the Swift, never from a screenshot. Current sources of truth:
`Theme.swift` (ember tokens), `main.swift` (sidebar 220 / header 30 / status 25,
folder label LEFT in the header, usage+gear right, folder+branch left and
lang+account right in the status bar), `Dock/DockTabBar.swift` (30px strip on
bg2; the ACTIVE tab fills with bg so it merges into the panel, plus a 2px accent
underline and a right hairline), `Components.swift` (RivenTabStrip 32px,
radius 6), `Workspace/WorkspaceRail.swift` (agent panes as child rows with
activity dots), `Workspace/ChatViews.swift` (accent-bar user bubble, dim `◇`
tool lines, glass composer with mode chip + circular + and an accent send pill),
`Workspace/AgentGroupPanel.swift` (168×58 avatar cards on a dot canvas, joined by
a per-parent bus), and `I18n.swift` for the English labels (Code · Terminal ·
Changes · Agent group · Source Control · Notes · Browser · API).

The 23s storyboard: chat panel opens → prompt is typed → agent edits `store.ts`
with an inline diff → `riven_ask_agents` fans work out to two teammates, each in
its own sub-agent pane → Changes panel reviews the edits → Agents tab shows the
group roster and reporting tree.

## Re-shooting

Nothing to install: headless Chrome captures the frames, AVFoundation encodes
them (no ffmpeg needed).

```bash
cd landing/demo
python3 -m http.server 8901 &                  # serve index.html
python3 capture.py http://localhost:8901/index.html ./frames 552
swift encode.swift ./frames ../assets/riven-demo.mp4 24 1280 760 1400
swift probe.swift ../assets/riven-demo.mp4 ./probe 9 14 21        # sanity-check frames
sips -Z 1280 --out ../assets/riven-poster.png frames/0330.png    # poster
```

`capture.py` drives one browser over the DevTools protocol and calls
`renderFrame(n)` per frame (~35s for the whole clip). Launching Chrome per frame
instead takes hours - don't.

Frame count = `duration × 24`; the scene clock lives in `T` at the top of the
script in `index.html`.

The page is 1280×760 captured at `deviceScaleFactor: 2` and downscaled during
encode, which is where the text crispness comes from. Only mp4/H.264 is shipped -
VP9 would need ffmpeg, and `<video>` falls back to the poster anyway.
