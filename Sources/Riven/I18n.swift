import AppKit

// Korean/English localization — a native port of riven's i18n.ts. Korean is the
// source language; English is the translation. `t("key", ["n": 3])` looks up the
// dictionary, picks ko/en by the current language, and interpolates {name} params.
// Language is a persisted setting; changing it posts `.rivenLanguageChanged` so the
// menu bar, panel titles and any observing view rebuild live (riven's useT()).
enum Lang: String { case ko, en }

extension Notification.Name {
    static let rivenLanguageChanged = Notification.Name("rivenLanguageChanged")
    static let rivenFormatOnSaveChanged = Notification.Name("rivenFormatOnSaveChanged")
    static let rivenEditorKeymapChanged = Notification.Name("rivenEditorKeymapChanged")
    static let rivenSnippetsChanged = Notification.Name("rivenSnippetsChanged")
    // 에디터/터미널 폰트 크기 설정이 바뀜 → 각 뷰가 즉시 반영 (재시작 불필요).
    static let rivenFontSizeChanged = Notification.Name("rivenFontSizeChanged")
    // Divider drag begin/end. NSSplitView's mouseDown runs a modal tracking loop for the whole
    // drag, so these bracket it exactly — unlike viewWillStartLiveResize, which isn't guaranteed
    // for divider tracking. Panes with expensive layout (the chat transcript) freeze on begin.
    static let rivenDividerDragBegan = Notification.Name("rivenDividerDragBegan")
    static let rivenDividerDragEnded = Notification.Name("rivenDividerDragEnded")
}

enum I18n {
    // 첫 접근 시 프로세스 선호 언어까지 맞춘다 — Sparkle 같은 프레임워크는 자기 .lproj를
    // AppleLanguages 기준으로 고르므로, 이걸 안 맞추면 앱은 한국어인데 업데이트 창만
    // 영어로 뜬다.
    static var current: Lang = {
        let lang = Lang(rawValue: Settings.shared.string("language", "ko")) ?? .ko
        applyProcessLanguage(lang)
        return lang
    }()

    static func setLanguage(_ lang: Lang) {
        guard lang != current else { return }
        current = lang
        Settings.shared.set("language", lang.rawValue)
        applyProcessLanguage(lang)
        NotificationCenter.default.post(name: .rivenLanguageChanged, object: nil)
    }

    // riven의 언어 선택을 프로세스 선호 언어(AppleLanguages)에 반영한다. 우리 UI는 t()로
    // 직접 그리지만, 시스템/프레임워크가 스스로 띄우는 창(Sparkle 업데이트 창·표준 알림
    // 버튼)은 이 값으로 번역본을 고른다. Sparkle.framework에는 ko.lproj가 들어 있으므로
    // 이것만 맞으면 업데이트 UI도 한국어로 나온다.
    // 주의: 앱 번들 Info.plist에 CFBundleLocalizations(ko, en)가 선언되어 있어야 시스템이
    // 한국어를 지원 언어로 인정한다 (build-app.sh에서 생성).
    // 이미 로컬라이제이션을 캐시한 번들은 다음 실행부터 반영된다.
    static func applyProcessLanguage(_ lang: Lang) {
        let d = UserDefaults.standard
        // 이미 같은 언어가 1순위면(예: 시스템이 ko-KR) 굳이 덮어쓰지 않는다.
        let first = (d.stringArray(forKey: "AppleLanguages") ?? []).first ?? ""
        if !first.hasPrefix(lang.rawValue) { d.set([lang.rawValue], forKey: "AppleLanguages") }
    }

    // key -> (ko, en). Grouped by UI area; mirrors riven's DICT (subset in active use,
    // extended as call sites are localized).
    static let dict: [String: (ko: String, en: String)] = [
        // common
        "common.close": ("닫기", "Close"), "common.cancel": ("취소", "Cancel"),
        "common.ok": ("확인", "OK"),
        // crash reporting (opt-out disclosure + settings toggle)
        "crash.noticeTitle": ("익명 크래시 리포트", "Anonymous crash reports"),
        "crash.noticeBody": ("riven은 안정성 개선을 위해 익명 크래시 리포트를 보냅니다 (계정·토큰 없이, 홈 경로는 가려서). 설정에서 언제든 끌 수 있습니다.",
            "riven sends anonymous crash reports to improve stability (no account or tokens; your home path is masked). You can turn this off anytime in Settings."),
        "crash.turnOff": ("끄기", "Turn off"),
        "settings.crashReports": ("크래시 리포트 전송 (익명)", "Send crash reports (anonymous)"),
        "quit.title": ("riven을 종료할까요?", "Quit riven?"),
        "quit.body": ("마지막 패널을 닫으면 앱이 종료됩니다.", "Closing the last panel quits the app."),
        "quit.confirm": ("종료", "Quit"),
        "common.confirm": ("확인", "OK"), "common.open": ("열기", "Open"),
        "common.search": ("검색", "Search"), "common.refresh": ("새로고침", "Refresh"),
        "common.save": ("저장", "Save"), "common.dontSave": ("저장 안 함", "Don't Save"),
        "common.delete": ("삭제", "Delete"), "common.rename": ("이름 변경", "Rename"),
        // panel titles
        "title.editor": ("코드", "Code"), "title.preview": ("브라우저", "Browser"),
        "title.search": ("검색", "Search"), "title.git": ("소스 컨트롤", "Source Control"),
        "title.changes": ("변경 사항", "Changes"), "title.terminal": ("터미널", "Terminal"),
        "title.api": ("API", "API"),
        "title.notes": ("메모", "Notes"),
        "notes.editing": ("입력 중…", "Editing…"),
        "notes.savedAt": ("{t} 저장", "saved {t}"),
        "notes.new": ("새 메모", "New note"),
        "notes.delete": ("메모 삭제", "Delete note"),
        "notes.untitled": ("제목 없음", "Untitled"),
        "notes.empty": ("메모가 없습니다. + 로 추가하세요.", "No notes yet. Press + to add one."),
        "notes.titlePlaceholder": ("제목", "Title"),
        "notes.back": ("목록", "Notes"),
        "menu.notes": ("메모", "Notes"),
        "app.restoring": ("작업 공간 복원 중…", "Restoring your workspaces…"),
        "api.addRow": ("행 추가", "Add row"),
        // ---- agent group (orchestration) ----
        "title.team": ("에이전트 그룹", "Agent group"),
        "menu.team": ("에이전트 그룹", "Agent group"),
        "team.hint": ("에이전트를 여러 개 만들어 서로 일을 넘기게 합니다. 메인이 왼쪽 한 칸 전체, 멤버는 옆 칸에 위에서 아래로 최대 3개씩 열리고 4번째부터 새 칸이 생깁니다. 이름은 에이전트끼리 서로를 부를 때 씁니다.",
                      "Create several agents that hand work to each other. The main one takes the left slot; members stack in the next slot, up to three, then a new slot starts. Names are how agents address each other."),
        "team.add": ("에이전트 추가", "Add agent"),
        "team.active": ("활성 그룹", "Active groups"),
        "team.none": ("아직 만든 그룹이 없습니다", "No groups yet"),
        "team.draft": ("새 그룹", "New group"),
        "team.preview": ("조직도 미리보기", "Preview org chart"),
        "team.backToSetup": ("구성으로 돌아가기", "Back to setup"),
        "team.reportsTo": ("보고 대상", "Reports to"),
        "team.model": ("모델", "Model"),
        "team.nameField": ("이름", "Name"),
        "team.noParent": ("없음 (메인)", "None (main)"),
        "team.closed": ("닫힘 · 눌러서 다시 열기", "closed · click to reopen"),
        "team.addOne": ("추가", "Add"),
        "team.remove": ("삭제", "Remove"),
        "team.addToGroup": ("이 그룹에 에이전트 추가", "Add an agent to this group"),
        "team.removed": ("「{name}」 을(를) 그룹에서 뺐습니다.", "Removed \u{201C}{name}\u{201D} from the group."),
        "team.reopened": ("「{name}」 패널을 다시 열었습니다.", "Reopened \u{201C}{name}\u{201D}."),
        "team.renamed": ("이름을 「{name}」 (으)로 바꿨습니다.", "Renamed to \u{201C}{name}\u{201D}."),
        "team.members": ("{n}명", "{n}"),
        "team.removeTip": ("이 에이전트 제거", "Remove this agent"),
        "team.persona": ("페르소나", "Persona"),
        "team.name": ("그룹 이름", "Group name"),
        "team.nameDefault": ("팀", "Team"),
        "team.create": ("그룹 만들기", "Create group"),
        "team.main": ("메인", "MAIN"),
        "team.mainName": ("메인 에이전트 이름", "Main agent name"),
        "team.memberName": ("에이전트 {n} 이름", "Agent {n} name"),
        "team.mainDefault": ("리드", "Lead"),
        "team.memberDefault": ("멤버{n}", "Member{n}"),
        "team.noPersona": ("기본", "Default"),
        "team.created": ("에이전트 그룹 「{group}」 생성: {names}. 서로 riven_ask_agent 로 일을 넘길 수 있습니다.",
                         "Agent group \u{201C}{group}\u{201D} created: {names}. They can delegate with riven_ask_agent."),
        // 팀 입력줄 — 사용자가 그룹에 직접 말을 건다
        "team.bar.placeholder": ("@이름 메시지  ·  /all 메시지  ·  그냥 쓰면 리드에게",
                                 "@name message  ·  /all message  ·  plain text goes to the lead"),
        "team.bar.send": ("보내기", "Send"),
        "team.bar.sent": ("→ {n}", "→ {n}"),
        "team.bar.back": ("← {n} 응답 도착 · {k}명 대기 중", "← {n} replied · {k} still working"),
        "team.bar.allBack": ("← {n} 응답 완료", "← {n} replied"),
        "team.bar.unknown": ("이 그룹에 없는 이름: {n}", "Not in this group: {n}"),
        "team.bar.closedTarget": ("닫힌 멤버에게는 보낼 수 없습니다: {n}", "Closed members can't receive: {n}"),
        "team.bar.noTarget": ("보낼 대상이 없습니다", "No one to send to"),
        "team.bar.noMessage": ("보낼 내용을 입력하세요", "Type something to send"),
        // 조직도 상태 칩
        "team.st.idle": ("대기", "Idle"),
        "team.st.thinking": ("생각 중", "Thinking"),
        "team.st.tool": ("{t} 실행", "Running {t}"),
        "team.st.waiting": ("승인 대기", "Needs approval"),
        "team.closedShort": ("닫힘", "Closed"),
        "chat.cancel": ("취소", "Cancel"),
        "chat.delegated": ("{a} 에게 전달했습니다. 끝나면 답이 이 대화로 옵니다.",
                           "Sent to {a}. The answer will arrive in this conversation when it's done."),
        "chat.peerAnswer": ("[{a} 의 작업 결과]", "[Result from {a}]"),
        "chat.tool.expired": ("이 요청은 이미 만료되어 선택을 전달하지 못했습니다.",
                              "That request already expired, so the choice wasn't delivered."),
        "chat.plan.tip": ("계획 파일 열기 · {f}", "Open the plan file · {f}"),
        // /cost — plan usage from the OAuth usage API
        "chat.usage.title": ("사용량", "Usage"),
        "chat.usage.loading": ("사용량 확인 중…", "Checking usage…"),
        "chat.usage.session": ("5시간 창", "5-hour window"),
        "chat.usage.week": ("주간", "Weekly"),
        "chat.usage.resets": ("{t} 초기화", "resets {t}"),
        "chat.usage.unavailable": ("플랜 사용량을 가져오지 못했습니다 (로그인 상태를 확인하세요).",
                                   "Couldn't fetch plan usage (check that you're logged in)."),
        "chat.usage.turn": ("이번 세션 최근 턴", "Last turn this session"),
        // /mcp
        "chat.mcp.title": ("MCP 서버", "MCP servers"),
        "chat.mcp.tools": ("도구 {n}개", "{n} tools"),
        "chat.mcp.riven": ("riven (내장)", "riven (built-in)"),
        "chat.mcp.needsAuth": ("인증 필요: 터미널에서 `claude mcp` 로 로그인하세요",
                               "needs auth: run `claude mcp` in a terminal"),
        // /status
        "chat.status.title": ("상태", "Status"),
        "chat.status.workspace": ("작업 공간", "Workspace"),
        "chat.status.cli": ("CLI", "CLI"),
        "chat.status.tools": ("도구", "Tools"),
        // /permissions
        "chat.perm.title": ("권한 모드", "Permission mode"),
        "chat.perm.planDesc": ("읽기 전용, 계획만 세우고 실행하지 않음", "Read-only: plans, never executes"),
        "chat.perm.askDesc": ("파일 수정·명령 실행 전에 승인 카드", "Asks before edits and commands"),
        "chat.perm.autoDesc": ("승인 없이 모두 실행", "Runs everything without asking"),
        "chat.perm.pick": ("권한 모드를 선택하세요", "Choose a permission mode"),
        // /agents
        "chat.agents.pick": ("새 패널로 열 에이전트를 선택하세요", "Pick an agent to open in a new panel"),
        "chat.agents.none": (".claude/agents 에 정의된 에이전트가 없습니다.", "No agents defined in .claude/agents."),
        "chat.agents.default": ("기본 (에이전트 없음)", "Default (no agent)"),
        "chat.other": ("기타(직접 입력)", "Other (type it)"),
        "chat.cardHintCancel": ("←/→ 선택 · Enter 결정 · Esc 취소", "←/→ choose · Enter confirm · Esc cancel"),
        // ---- native chat panel ----
        "chat.placeholder": ("Claude에게 메시지…  ( / 명령 · Shift+Enter 줄바꿈 )",
                             "Message Claude…  ( / commands · Shift+Enter for newline )"),
        "chat.send": ("보내기", "Send"), "chat.stop": ("중단", "Stop"),
        "chat.attach": ("첨부", "Attach"), "chat.attachFile": ("파일 첨부", "Attach file"),
        "chat.toBottom": ("맨 아래로", "Scroll to latest"),
        "chat.thinking": ("생각 중", "Thinking"), "chat.done": ("완료", "Done"),
        "chat.queued": ("대기 중", "Queued"),
        "chat.interrupted": ("⏹ 중단됨", "⏹ Stopped"),
        "chat.resumed": ("이전 세션에서 이어짐", "continued from a previous session"),
        "chat.olderNote": ("⋯ 이전 대화 {n}개 (위로 스크롤해 불러오기)",
                           "⋯ {n} earlier messages (scroll up to load)"),
        "chat.error": ("⚠ 오류: {e}", "⚠ Error: {e}"),
        "chat.sessionEnded": ("⚠ 세션이 종료되었습니다. /resume 로 이어가거나 새 챗을 여세요.",
                              "⚠ Session ended. Use /resume to continue, or open a new chat."),
        "chat.sessionExit": ("세션 종료(code {c}). 로그인/권한을 확인하세요.",
                             "Session exited (code {c}). Check login/permissions."),
        "chat.sessionCrashed": ("세션이 예기치 않게 종료됨 (code {c})", "Session ended unexpectedly (code {c})"),
        "chat.sessionStartFailed": ("세션을 시작하지 못했습니다.", "Couldn't start the session."),
        "chat.noCLI": ("claude CLI를 찾을 수 없습니다. 터미널에서 `claude` 로그인 여부를 확인하세요.",
                       "claude CLI not found. Check that `claude` is installed and logged in."),
        "chat.noCLIShort": ("claude CLI를 찾을 수 없습니다.", "claude CLI not found."),
        "chat.cliChanged": ("claude CLI가 {prev} → {now} 로 변경되었습니다. 이상 동작 시 riven 업데이트를 확인하세요.",
                            "claude CLI changed {prev} → {now}. If something misbehaves, check for a riven update."),
        "chat.updating": ("claude 업데이트 확인 중…", "Checking for claude updates…"),
        "chat.updateDone": ("업데이트 완료(출력 없음)", "Update finished (no output)"),
        "chat.updateApplies": ("업데이트된 CLI는 새 챗(또는 재시작)부터 적용됩니다.",
                               "The updated CLI applies to new chats (or after a restart)."),
        "chat.runFailed": ("실행 실패", "Failed to run"),
        // permission modes + approval
        "chat.mode.plan": ("계획", "Plan"), "chat.mode.ask": ("승인 요청", "Ask"),
        "chat.mode.auto": ("자동 실행", "Auto"),
        "chat.mode.tip": ("권한 모드 (Shift+Tab 으로 전환)", "Permission mode (Shift+Tab to cycle)"),
        "chat.mode.now": ("권한 모드: {m}", "Permission mode: {m}"),
        "chat.mode.help": ("권한 모드: {m}. Shift+Tab 또는 하단 모드 셀렉터로 전환 (계획/승인 요청/자동 실행).",
                           "Permission mode: {m}. Switch with Shift+Tab or the selector below (Plan / Ask / Auto)."),
        "chat.approve": ("승인", "Approve"), "chat.deny": ("거부", "Deny"),
        "chat.autoThisSession": ("이 세션 자동 실행", "Auto-run this session"),
        "chat.permReq": ("권한 요청 · {name}", "Permission · {name}"),
        "chat.planProceed": ("이 계획대로 진행할까요?", "Proceed with this plan?"),
        "chat.planGo": ("진행", "Proceed"), "chat.planRevise": ("계획 수정", "Revise plan"),
        // model
        "chat.model.default": ("기본 (CLI 기본값)", "Default (CLI default)"),
        "chat.model.now": ("현재: {m}", "Current: {m}"),
        "chat.model.set": ("모델: {m}", "Model: {m}"),
        // status / usage
        "chat.status.model": ("모델: {m}", "Model: {m}"),
        "chat.status.perm": ("권한: {m}", "Permission: {m}"),
        "chat.status.session": ("세션 {id}", "Session {id}"),
        "chat.usage.recent": ("최근 턴 · ↑{in} ↓{out} 토큰 · 캐시 {cache}",
                              "Last turn · ↑{in} ↓{out} tokens · cache {cache}"),
        "chat.usage.recentShort": ("최근 턴 ↑{in} ↓{out}", "Last turn ↑{in} ↓{out}"),
        "chat.usage.none": ("아직 사용량 정보가 없습니다.", "No usage data yet."),
        "chat.tokens": ("↑{in} ↓{out} 토큰", "↑{in} ↓{out} tokens"),
        "chat.quota.session": ("세션 {n}%", "Session {n}%"),
        "chat.quota.week": ("주간 {n}%", "Weekly {n}%"),
        "chat.thinkFor": ("생각 {d}", "Thought {d}"), "chat.writeFor": ("작성 {d}", "Wrote {d}"),
        // durations
        "chat.dur.sec": ("{n}초", "{n}s"), "chat.dur.min": ("{n}분", "{n}m"),
        "chat.dur.minSec": ("{m}분 {s}초", "{m}m {s}s"), "chat.dur.hour": ("{n}시간", "{n}h"),
        "chat.dur.hourMin": ("{h}시간 {m}분", "{h}h {m}m"),
        // mcp / sessions / misc
        "chat.mcp.connected": ("연결된 MCP 서버:", "Connected MCP servers:"),
        "chat.mcp.none": ("· (없음)", "· (none)"),
        "chat.sessions.none": ("이 워크스페이스에 이전 세션이 없습니다.", "No previous sessions in this workspace."),
        "chat.sessions.pick": ("이어서 열 세션 선택", "Pick a session to resume"),
        "chat.compactNote": ("컨텍스트는 한도에 가까워지면 자동으로 압축됩니다. headless 세션에선 수동 /compact 이 지원되지 않습니다.",
                             "Context is compacted automatically as it fills. Manual /compact isn't supported in headless sessions."),
        "chat.agentsNote": ("서브에이전트는 Task 도구로 자동 실행되며, 실행 중이면 오른쪽에 컬럼으로 표시됩니다.",
                            "Sub-agents are launched automatically via the Task tool; running ones appear as panels beside the chat."),
        "chat.help": ("/clear 지우기 · /resume 이전 세션 · /agents 에이전트 새 패널 · /model 모델 · /permissions 권한 · /cost 사용량 · /status 상태 · /mcp 서버 · /init·/review 실행 · /config 설정 · /update CLI 업데이트 · Shift+Tab 권한모드",
                      "/clear · /resume · /agents (new panel) · /model · /permissions · /cost usage · /status · /mcp servers · /init·/review · /config · /update · Shift+Tab permission mode"),
        "chat.openedEditor": ("📄 에디터에 열었습니다: {p}", "📄 Opened in the editor: {p}"),
        "chat.openedPreview": ("🌐 미리보기 패널에 열었습니다: {u}", "🌐 Opened in the preview panel: {u}"),
        "chat.capturing": ("📸 스크린샷 캡처 중…", "📸 Capturing a screenshot…"),
        "chat.apiPanel": ("↗ API 패널: {s}", "↗ API panel: {s}"),
        "chat.prompt.init": ("이 프로젝트를 분석해서 CLAUDE.md 파일을 생성하거나 업데이트해줘.",
                             "Analyze this project and create or update its CLAUDE.md."),
        "chat.prompt.review": ("최근 변경사항(git diff)을 리뷰해서 버그와 개선점을 알려줘.",
                               "Review the recent changes (git diff) and report bugs and improvements."),
        // slash command descriptions
        "chat.cmd.clear": ("대화 지우기", "Clear conversation"),
        "chat.cmd.compact": ("대화 압축", "Compact conversation"),
        "chat.cmd.context": ("컨텍스트 사용량", "Context usage"),
        "chat.cmd.cost": ("토큰 사용량", "Token usage"),
        "chat.cmd.config": ("설정", "Settings"),
        "chat.cmd.help": ("도움말", "Help"),
        "chat.cmd.init": ("CLAUDE.md 생성", "Create CLAUDE.md"),
        "chat.cmd.mcp": ("MCP 서버", "MCP servers"),
        "chat.cmd.memory": ("메모리 편집", "Edit memory"),
        "chat.cmd.model": ("모델 변경", "Change model"),
        "chat.cmd.permissions": ("권한 설정", "Permissions"),
        "chat.cmd.resume": ("이전 세션 열기", "Resume a session"),
        "chat.cmd.review": ("코드 리뷰", "Code review"),
        "chat.cmd.agents": ("서브에이전트", "Sub-agents"),
        "chat.cmd.status": ("상태", "Status"),
        "chat.cmd.update": ("claude CLI 업데이트", "Update the claude CLI"),
        "chat.cmd.user": ("사용자 명령", "User command"),
        "chat.writing": ("작성 중", "Writing"),
        "chat.running": ("{name} 실행 중", "Running {name}"),
        "chat.awaitingApproval": ("⏸ 승인 대기 중…", "⏸ Waiting for approval…"),
        "chat.queuedTag": ("⋯ 대기 중", "⋯ queued"),
        "chat.cardHint": ("←/→ 선택 · Enter 결정", "←/→ choose · Enter confirm"),
        "chat.viewDiff": ("변경 보기", "View diff"),
        "chat.openInEditor": ("에디터에서 보기", "Open in editor"),
        "chat.plan": ("플랜 ", "Plan "),
        "common.copy": ("복사", "Copy"),
        // relative time (compact)
        "time.now": ("방금", "now"), "time.sec": ("{n}초", "{n}s"), "time.min": ("{n}분", "{n}m"),
        "time.hour": ("{n}시간", "{n}h"), "time.day": ("{n}일", "{n}d"),
        // command palette / quick panel
        "api.test": ("API 테스트", "API test"), "agent.label": ("에이전트", "Agent"),
        "palette.placeholder": ("명령 실행…", "Run a command…"),
        // search panel results / replace
        "search.summary": ("{n}개 · {files}개 파일", "{n} in {files} files"),
        "search.replaceConfirm": ("\"{q}\"을(를) {files}개 파일에서 바꿀까요?", "Replace \"{q}\" in {files} files?"),
        "search.replaceBody": ("디스크에 즉시 기록되며 되돌리기 어렵습니다.", "Written to disk immediately and hard to undo."),
        "search.replace": ("바꾸기", "Replace"), "search.replacing": ("바꾸는 중…", "Replacing…"),
        "search.replaceDone": ("{n}곳 · {files}개 파일 변경됨", "{n} replacements in {files} files"),
        // git panel alerts
        "git.opFailed": ("{name} 실패", "{name} failed"),
        "git.remoteFailBody": ("원격 작업에 실패했습니다. 원격/인증 설정을 확인하세요.", "Remote operation failed. Check your remote/auth settings."),
        "git.commitFailed": ("커밋 실패", "Commit failed"),
        "git.discardConfirm": ("{name}의 변경을 버릴까요?", "Discard changes to {name}?"),
        "git.discardBody": ("되돌릴 수 없습니다.", "This cannot be undone."),
        "git.discardBtn": ("버리기", "Discard"),
        "quick.footer": ("↑↓ 이동 · ↵ 실행 · esc 닫기", "↑↓ move · ↵ run · esc close"),
        "cmd.aiComplete": ("AI 자동완성", "AI completion"),
        "cmd.gitGraph": ("소스 컨트롤 (그래프)", "Source Control (graph)"),
        "cmd.apiPanel": ("API 테스트 패널", "API test panel"),
        "cmd.distributeEvenly": ("패널 크기 균등화", "Distribute panels evenly"),
        "changes.revertAll.confirm": ("에이전트 변경을 모두 되돌리시겠습니까?", "Revert all agent changes?"),
        "changes.revertAll.body": ("이 세션에서 에이전트가 편집한 내용이 편집 전 상태로 복원됩니다.", "Everything the agent edited this session is restored to its pre-edit state."),
        "changes.revertConfirm": ("되돌리기", "Revert"),
        // preview panel
        "preview.empty": ("미리볼 URL을 입력하세요", "Enter a URL to preview"),
        "preview.reload": ("새로고침 (⌘R)", "Reload (⌘R)"),
        "preview.openExternal": ("기본 브라우저에서 열기", "Open in default browser"),
        "preview.loadFailed": ("로드 실패: {msg}", "Load failed: {msg}"),
        // API client panel
        "api.services": ("서비스", "Services"), "api.templates": ("템플릿", "Templates"),
        "api.env": ("환경", "Env"), "api.history": ("요청 기록", "History"),
        "api.saved": ("저장된 요청", "Saved requests"),
        "api.importCurl": ("클립보드에서 cURL 가져오기", "Import cURL from clipboard"),
        "api.hint.send": ("요청을 보내보세요", "Send a request"),
        "api.hint.params": ("key: value  (줄마다 하나, 쿼리스트링으로 전송)", "key: value  (one per line, sent as query string)"),
        "api.hint.headers": ("Header-Name: value  (줄마다 하나)", "Header-Name: value  (one per line)"),
        "api.hint.body": ("{ \"key\": \"value\" }  (JSON이면 Content-Type 자동)", "{ \"key\": \"value\" }  (JSON auto-sets Content-Type)"),
        "api.auth.token": ("토큰", "Token"), "api.auth.user": ("사용자", "User"),
        "api.auth.pass": ("비밀번호", "Password"), "api.auth.label": ("인증", "Auth"),
        "api.status.badURL": ("잘못된 URL", "Invalid URL"), "api.status.sending": ("요청 중…", "Sending…"),
        "api.status.failed": ("요청 실패 · {ms}ms", "Request failed · {ms}ms"),
        "api.history.empty": ("기록 없음", "No history"),
        "api.saveCurrent": ("현재 요청 저장…", "Save current request…"),
        "api.saved.empty": ("저장된 요청 없음", "No saved requests"),
        "api.save.title": ("요청 저장", "Save request"), "api.save.msg": ("이름을 입력하세요", "Enter a name"),
        "api.env.none": ("없음", "None"), "api.env.edit": ("환경 편집…", "Edit environments…"),
        "api.env.promptTitle": ("환경", "Environment"),
        "api.env.promptMsg": ("환경 이름 (새 이름이면 생성)", "Environment name (new name creates one)"),
        "api.env.hint": ("key=value  줄마다 하나 · {{key}} 로 사용", "key=value  one per line · use as {{key}}"),
        "api.env.varsTitle": ("『{name}』 변수", "{name} variables"),
        "api.scanning": ("스캔…", "Scanning…"), "api.services.empty": ("실행 중인 서비스 없음", "No running services"),
        "api.curl.none": ("클립보드에 cURL 명령이 없습니다", "No cURL command in clipboard"),
        "api.curl.parseFail": ("cURL 파싱 실패", "Failed to parse cURL"),
        "api.curl.imported": ("cURL 가져옴 · Send로 실행", "cURL imported · press Send"),
        "title.explorer": ("탐색기", "Explorer"),
        // empty workbench
        "empty.tagline": ("텅 빈 작업대예요. 여기서부터 갈라 만들어 봐요.", "A blank workbench. Let's carve something out."),
        "empty.addTerminal": ("터미널 추가하기", "Add a terminal"),
        "empty.addEditor": ("코드 편집기 열기", "Open the editor"),
        // explorer
        "explorer.newFile": ("새 파일", "New file"), "explorer.newFolder": ("새 폴더", "New folder"),
        "explorer.collapseAll": ("모두 접기", "Collapse all"), "explorer.rename": ("이름 변경", "Rename"),
        "explorer.delete": ("삭제", "Delete"), "explorer.revealInFinder": ("Finder에서 보기", "Reveal in Finder"),
        "explorer.copyPath": ("경로 복사", "Copy Path"),
        // git
        "git.notRepo": ("git 저장소가 아니에요.", "Not a git repository."),
        "git.commitMessage": ("커밋 메시지", "Commit message"),
        "git.commit": ("커밋", "Commit"), "git.staged": ("스테이지됨", "Staged"),
        "git.changed": ("변경됨", "Changes"), "git.stageAllShort": ("+ 전체", "+ All"),
        "git.noChanges": ("변경 사항 없음", "No changes"), "git.push": ("푸시", "Push"),
        "git.pull": ("풀", "Pull"), "git.stage": ("스테이지", "Stage"),
        "git.unstage": ("언스테이지", "Unstage"), "git.discard": ("변경 버리기", "Discard changes"),
        "git.status.M": ("수정", "Modified"), "git.status.A": ("추가", "Added"),
        "git.status.D": ("삭제", "Deleted"), "git.status.R": ("이름변경", "Renamed"),
        "git.status.Q": ("미추적", "Untracked"), "git.status.C": ("복사", "Copied"),
        "git.status.U": ("충돌", "Conflict"),
        // changes
        "changes.empty": ("에이전트가 이 세션에서 편집한 파일이 여기 요약됩니다.", "Files an agent edits in this session are summarized here."),
        "changes.acceptAll": ("전체 수락", "Accept all"), "changes.revertAll": ("전체 되돌리기", "Revert all"),
        "changes.accept": ("수락", "Accept"), "changes.revert": ("되돌리기", "Revert"),
        // search
        "search.placeholder": ("파일에서 검색", "Search across files"),
        "search.searching": ("검색 중…", "Searching…"),
        "search.noResults": ("결과 없음", "No results"),
        "search.replacePlaceholder": ("바꾸기", "Replace with"),
        "search.replaceAll": ("모두 바꾸기", "Replace all"),
        "changes.empty2": ("에이전트 편집 내역이 없습니다", "No agent edits yet"),
        // settings sections
        "settings.editor": ("에디터", "Editor"), "settings.terminal": ("터미널", "Terminal"),
        "settings.fontSize": ("폰트 크기", "Font size"),
        "settings.colorTheme": ("색상 테마", "Color theme"),
        "settings.notifications": ("알림", "Notifications"),
        "settings.notifyDesc": ("데스크톱 알림 사용 (에이전트 완료 · 터미널 벨)", "Enable desktop notifications (agent done · terminal bell)"),
        "settings.aiSection": ("AI 자동완성", "AI completion"),
        "settings.aiEnable": ("AI 자동완성 켜기 (⌃Space)", "Enable AI completion (⌃Space)"),
        "settings.status": ("상태", "Status"),
        "settings.formatOnSave": ("저장 시 자동 포맷", "Format on save"),
        "about.tagline": ("통합 개발 환경", "Integrated dev environment"),
        "about.update": ("업데이트", "Update"), "about.check": ("업데이트 확인", "Check for updates"),
        "about.checkHint": ("최신 버전 여부를 확인하세요.", "Check whether you're up to date."),
        "about.checking": ("확인 중…", "Checking…"),
        "update.available": ("업데이트", "update"),
        "update.unavailable": ("업데이트를 확인할 수 없습니다", "Can't check for updates"),
        "update.noFeed": ("이 빌드에는 업데이트 피드가 설정되어 있지 않습니다(개발 빌드).",
                          "This build has no update feed configured (development build)."),
        "about.links": ("링크", "Links"), "about.landing": ("홈페이지 보기", "Homepage"),
        "about.github": ("깃헙 보기", "GitHub"),
        "account.title": ("계정 & 동기화", "Account & Sync"),
        "account.continueGithub": ("GitHub로 계속", "Continue with GitHub"),
        "settings.saveFonts": ("폰트 크기 적용", "Apply font size"),
        "settings.saveAI": ("AI 설정 저장", "Save AI settings"),
        "settings.snippets": ("스니펫", "Snippets"),
        "settings.snippetsHint": ("접두어를 입력하면 본문이 자동완성으로 제안됩니다. ${1} 로 탭 정지점을 넣을 수 있어요.", "Type the prefix to get the body as a completion. Use ${1} for tab stops."),
        "settings.snippetPrefix": ("접두어", "Prefix"), "settings.snippetBody": ("본문", "Body"),
        "settings.addSnippet": ("+ 스니펫 추가", "+ Add snippet"),
        // settings tabs
        "settings.title": ("설정", "Settings"), "settings.tab.general": ("일반", "General"),
        "settings.tab.ai": ("AI", "AI"), "settings.tab.keys": ("단축키", "Shortcuts"),
        "settings.tab.account": ("계정", "Account"), "settings.tab.about": ("정보", "About"),
        "settings.language": ("언어", "Language"), "settings.theme": ("테마", "Theme"),
        // workspace activity + rail
        "ws.activity.attn": ("입력 대기", "Awaiting input"), "ws.activity.busy": ("실행 중", "Running"),
        "ws.activity.idle": ("유휴", "Idle"),
        "ws.title": ("워크스페이스", "Workspaces"), "ws.rename": ("이름 변경", "Rename"),
        "ws.copyPath": ("경로 복사", "Copy Path"), "ws.close": ("워크스페이스 닫기", "Close workspace"),
        "ws.reveal": ("Finder에서 보기", "Reveal in Finder"), "ws.color": ("색상", "Color"),
        "ws.renameTitle": ("워크스페이스 이름 변경", "Rename workspace"),
        // editor (webview — injected via rivenSetI18n)
        "editor.emptyTitle": ("파일을 선택하세요", "Select a file to edit"),
        "editor.prevChange": ("이전 변경", "Previous change"), "editor.nextChange": ("다음 변경", "Next change"),
        "editor.accept": ("수락", "Accept"), "editor.revert": ("되돌리기", "Revert"),
        "editor.revertThisChange": ("이 변경 되돌리기", "Revert this change"),
        "editor.snippet": ("스니펫", "Snippet"), "editor.changeWord": ("변경", "Change"),
        // run / preview
        "run.label": ("실행", "Run"), "run.title": ("스크립트 실행", "Run script"),
        "preview.capture": ("캡처", "Capture"),
        "preview.captureTitle": ("현재 화면을 캡처해 에이전트에 전달", "Capture the current view and send to the agent"),
        // notifications
        "term.done": ("작업이 완료되었습니다", "Done"),
        // agent lifecycle (hook-driven — see docs/agent-hooks-design.md)
        "agent.needsApproval": ("승인이 필요합니다", "Approval needed"),
        "agent.needsApprovalTool": ("{tool} 실행 승인이 필요합니다", "Approval needed to run {tool}"),
        "agent.failed": ("턴이 오류로 끝났습니다", "The turn ended with an error"),
        // editor guards
        "editor.tooLarge": ("파일이 너무 큽니다", "File is too large"),
        "editor.tooLargeBody": ("{name} ({size})은(는) 에디터에서 열기에 너무 큽니다. {limit}보다 작은 파일만 열 수 있습니다.",
            "{name} ({size}) is too large to open in the editor. Only files smaller than {limit} can be opened."),
        // toolbar / menu-ish
        "toolbar.addPanel": ("패널 추가", "Add panel"),
        "toolbar.newTerminal": ("새 터미널", "New terminal"),
        // menu bar
        "menu.about": ("riven 정보", "About riven"), "menu.settings": ("설정…", "Settings…"),
        "menu.quit": ("riven 종료", "Quit riven"),
        "menu.file": ("파일", "File"), "menu.addPanel": ("패널 추가", "Add Panel"),
        "menu.quickOpen": ("빠른 파일 열기", "Quick Open File"), "menu.commandPalette": ("명령 팔레트", "Command Palette"),
        "menu.openFolder": ("폴더 열기…", "Open Folder…"), "menu.newWorkspace": ("새 워크스페이스", "New Workspace"),
        "menu.save": ("저장", "Save"), "menu.closeTab": ("탭 닫기", "Close Tab"),
        "menu.edit": ("편집", "Edit"), "menu.undo": ("실행 취소", "Undo"), "menu.redo": ("다시 실행", "Redo"),
        "menu.cut": ("잘라내기", "Cut"), "menu.copy": ("복사", "Copy"), "menu.paste": ("붙여넣기", "Paste"),
        "menu.selectAll": ("모두 선택", "Select All"),
        "menu.view": ("보기", "View"), "menu.toggleSidebar": ("사이드바 토글", "Toggle Sidebar"),
        "menu.search": ("검색", "Search"), "menu.git": ("소스 컨트롤", "Source Control"),
        "menu.preview": ("브라우저", "Browser"), "menu.changes": ("변경 사항", "Changes"),
        "menu.focusEditor": ("에디터로 포커스", "Focus Editor"), "menu.focusTerminal": ("터미널로 포커스", "Focus Terminal"),
        "menu.popout": ("패널 새 창으로", "Pop Out Panel"),
        "menu.splitEditor": ("에디터 분할", "Split Editor"),
        "menu.zoomIn": ("글자 크게", "Zoom In"), "menu.zoomOut": ("글자 작게", "Zoom Out"), "menu.zoomReset": ("글자 크기 초기화", "Reset Zoom"),
        "menu.terminal": ("터미널", "Terminal"), "menu.newTerminal": ("새 터미널", "New Terminal"),
        "menu.clearTerminal": ("터미널 화면 지우기", "Clear Terminal"),
        "menu.splitRight": ("오른쪽으로 분할", "Split Right"), "menu.splitDown": ("아래로 분할", "Split Down"),
        "menu.nextTerminal": ("다음 터미널", "Next Terminal"), "menu.prevTerminal": ("이전 터미널", "Previous Terminal"),
        "menu.paneLeft": ("왼쪽 창으로", "Focus Pane Left"), "menu.paneRight": ("오른쪽 창으로", "Focus Pane Right"),
        "menu.paneUp": ("위쪽 창으로", "Focus Pane Up"), "menu.paneDown": ("아래쪽 창으로", "Focus Pane Down"),
        "menu.selectTerminalN": ("{n}번 터미널", "Terminal {n}"),
    ]

    // Look up + interpolate. Falls back to Korean, then the raw key.
    static func t(_ key: String, _ params: [String: CustomStringConvertible] = [:]) -> String {
        let entry = dict[key]
        var s = entry.map { current == .en ? $0.en : $0.ko } ?? key
        for (k, v) in params { s = s.replacingOccurrences(of: "{\(k)}", with: v.description) }
        return s
    }
}

// Free function shorthand, matching riven's `t(...)`.
func t(_ key: String, _ params: [String: CustomStringConvertible] = [:]) -> String { I18n.t(key, params) }
