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
        "api.hint.params": ("key: value  (줄마다 하나 — 쿼리스트링으로 전송)", "key: value  (one per line — sent as query string)"),
        "api.hint.headers": ("Header-Name: value  (줄마다 하나)", "Header-Name: value  (one per line)"),
        "api.hint.body": ("{ \"key\": \"value\" }  — JSON이면 Content-Type 자동", "{ \"key\": \"value\" }  — JSON auto-sets Content-Type"),
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
        "empty.tagline": ("텅 빈 작업대예요 — 여기서부터 갈라 만들어 봐요.", "A blank workbench — let's carve something out."),
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
