import { useSettings, getSettings } from './state/settings'

// ---------------------------------------------------------------------------
// Tiny in-repo i18n. Korean is the source language; English is the translation.
// Keys are short + stable so call sites read well: t('toolbar.terminal').
// Reactive via `useT()` (subscribes to the language setting → components
// re-render live when the user switches language). `t()` is the non-reactive
// variant for imperative code (notifications, confirm dialogs, payloads).
// ---------------------------------------------------------------------------

export type Lang = 'ko' | 'en'
type Params = Record<string, string | number>

export const DICT: Record<string, { ko: string; en: string }> = {
  // ---- editor tab context menu ----
  'tab.close': { ko: '닫기', en: 'Close' },
  'tab.closeOthers': { ko: '다른 탭 닫기', en: 'Close Others' },
  'tab.closeRight': { ko: '오른쪽 탭 닫기', en: 'Close to the Right' },
  'tab.closeAll': { ko: '모두 닫기', en: 'Close All' },
  'tab.copyPath': { ko: '경로 복사', en: 'Copy Path' },
  'tab.revealExplorer': { ko: '탐색기에서 표시', en: 'Reveal in Explorer' },

  // ---- shared ----
  'common.close': { ko: '닫기', en: 'Close' },
  'common.cancel': { ko: '취소', en: 'Cancel' },
  'common.confirm': { ko: '확인', en: 'OK' },
  'common.open': { ko: '열기', en: 'Open' },
  'common.search': { ko: '검색', en: 'Search' },
  'common.refresh': { ko: '새로고침', en: 'Refresh' },
  'common.noResults': { ko: '결과 없음', en: 'No results' },

  // ---- Toolbar ----
  'toolbar.terminal': { ko: '터미널', en: 'Terminal' },
  'toolbar.newTerminal': { ko: '새 터미널 (⌘T)', en: 'New terminal (⌘T)' },
  'toolbar.panels': { ko: '패널', en: 'Panels' },
  'toolbar.openPanel': { ko: '패널 열기', en: 'Open panel' },
  'toolbar.panel.editor': { ko: '코드 편집기', en: 'Code editor' },
  'toolbar.panel.preview': { ko: '프리뷰', en: 'Preview' },
  'toolbar.panel.search': { ko: '검색', en: 'Search' },
  'toolbar.openAgent': { ko: '에이전트 열기', en: 'Open agent' },
  'run.label': { ko: '실행', en: 'Run' },
  'run.title': { ko: 'package.json 스크립트 실행 (터미널에서)', en: 'Run a package.json script (in a terminal)' },
  'run.none': { ko: 'package.json 스크립트가 없어요', en: 'No package.json scripts' },
  'empty.tagline': { ko: '텅 빈 작업대예요 — 여기서부터 갈라 만들어 봐요.', en: "A blank workbench — let's carve something out." },
  'empty.addTerminal': { ko: '터미널 추가하기', en: 'Add a terminal' },
  'empty.addEditor': { ko: '코드 편집기 열기', en: 'Open the editor' },
  'toolbar.toggleExplorer': { ko: '탐색기 표시/숨김', en: 'Toggle Explorer' },
  'toolbar.popout': { ko: '현재 패널 새 창으로', en: 'Pop out current panel' },

  // ---- StatusBar ----
  'status.branch': { ko: '현재 브랜치', en: 'Current branch' },
  'status.notGit': { ko: 'git 아님', en: 'Not a git repo' },
  'status.ports': { ko: '이 레포에서 리스닝 중인 포트 (클릭: 프리뷰)', en: 'Ports listening in this repo (click to preview)' },
  'status.noFolder': { ko: '열린 폴더 없음 — 폴더를 열어주세요', en: 'No folder open — open a folder to start' },
  'status.settings': { ko: '설정', en: 'Settings' },
  'status.settingsTitle': { ko: '설정 (⌘,)', en: 'Settings (⌘,)' },

  // ---- WorkspaceTabs ----
  'ws.title': { ko: '워크스페이스', en: 'Workspaces' },
  'ws.openFolder': { ko: '폴더 열기', en: 'Open folder' },
  'ws.empty': { ko: '+ 로 폴더를 열어 시작해요', en: 'Open a folder with + to start' },
  'ws.recent': { ko: '최근 프로젝트', en: 'Recent' },
  'ws.close': { ko: '워크스페이스 닫기', en: 'Close workspace' },
  'ws.activity.attn': { ko: '입력 대기', en: 'Awaiting input' },
  'ws.activity.busy': { ko: '실행 중', en: 'Running' },
  'ws.activity.idle': { ko: '유휴', en: 'Idle' },
  'ws.desc.attn': { ko: '에이전트가 입력을 기다리고 있어요', en: 'The agent is waiting for input' },
  'ws.desc.busy': { ko: '에이전트가 작업 중이에요', en: 'The agent is working' },
  'ws.desc.idle': { ko: '대기 중', en: 'Idle' },

  // ---- AgentPicker ----
  'agentPicker.title': { ko: '어느 에이전트로 보낼까요?', en: 'Which agent should this go to?' },
  'agentPicker.sub': { ko: '실행 중인 LLM이 없어서 새로 열어요.', en: 'No LLM is running — a new one will open.' },
  'agentPicker.checking': { ko: '확인 중…', en: 'Checking…' },
  'agentPicker.empty': {
    ko: '설치된 LLM CLI가 없어요. claude / codex / aider / gemini 등을 설치하면 여기 표시돼요.',
    en: 'No LLM CLI installed. Install claude / codex / aider / gemini and it will show up here.'
  },

  // ---- Palette ----
  'palette.filePlaceholder': { ko: '파일 이름으로 이동…', en: 'Go to file…' },
  'palette.commandPlaceholder': { ko: '명령 검색…', en: 'Search commands…' },

  // ---- InputModal / Explorer name prompts ----
  'explorer.agentEdited': { ko: '에이전트가 수정함', en: 'Edited by agent' },
  'explorer.newFile': { ko: '새 파일', en: 'New file' },
  'explorer.newFolder': { ko: '새 폴더', en: 'New folder' },
  'explorer.collapseAll': { ko: '모두 접기', en: 'Collapse all' },
  'explorer.mentionInTerminal': { ko: '터미널로 @멘션 ({n})', en: 'Mention in terminal ({n})' },
  'explorer.sendToTerminal': { ko: '터미널로 내용 전송 ({n})', en: 'Send contents to terminal ({n})' },
  'explorer.rename': { ko: '이름 변경', en: 'Rename' },
  'explorer.delete': { ko: '삭제', en: 'Delete' },
  'explorer.revealInFinder': { ko: 'Finder에서 보기', en: 'Reveal in Finder' },
  'explorer.deleteConfirm': { ko: "'{name}' 을(를) 삭제할까요? 되돌릴 수 없어요.", en: "Delete '{name}'? This can't be undone." },
  'explorer.newFileName': { ko: '새 파일 이름', en: 'New file name' },
  'explorer.newFolderName': { ko: '새 폴더 이름', en: 'New folder name' },
  'explorer.namePlaceholder': { ko: '이름 입력', en: 'Enter a name' },

  // ---- DiffModal ----
  'diff.title': { ko: '변경 비교 — {name} (왼쪽: 이전 · 오른쪽: 에이전트 수정)', en: 'Diff — {name} (left: before · right: agent edit)' },

  // ---- SearchPanel ----
  'search.placeholder': { ko: '전체 파일에서 검색', en: 'Search across files' },
  'search.searching': { ko: '검색 중…', en: 'Searching…' },
  'search.summary': { ko: '{n}개 결과{more} · {files}개 파일', en: '{n} results{more} · {files} files' },
  'search.more': { ko: '+ (일부 생략)', en: '+ (truncated)' },
  'search.replacePlaceholder': { ko: '치환할 내용', en: 'Replace with' },
  'search.replaceAll': { ko: '모두 치환', en: 'Replace all' },
  'search.replaceConfirm': {
    ko: "'{q}'를 {files}개 파일에서 모두 치환할까요? 되돌리기 어렵습니다.",
    en: "Replace '{q}' across {files} files? This is hard to undo."
  },
  'search.replaced': { ko: '{r}곳 치환됨 · {f}개 파일', en: 'Replaced {r} · {f} files' },

  // ---- GitPanel ----
  'git.status.M': { ko: '수정', en: 'Modified' },
  'git.status.A': { ko: '추가', en: 'Added' },
  'git.status.D': { ko: '삭제', en: 'Deleted' },
  'git.status.R': { ko: '이름변경', en: 'Renamed' },
  'git.status.Q': { ko: '미추적', en: 'Untracked' },
  'git.status.C': { ko: '복사', en: 'Copied' },
  'git.status.U': { ko: '충돌', en: 'Conflict' },
  'git.notRepo': { ko: 'git 저장소가 아니에요.', en: 'Not a git repository.' },
  'git.commitFailed': { ko: '커밋 실패:\n{err}', en: 'Commit failed:\n{err}' },
  'git.unstage': { ko: '언스테이지', en: 'Unstage' },
  'git.stage': { ko: '스테이지', en: 'Stage' },
  'git.commitMessage': { ko: '커밋 메시지', en: 'Commit message' },
  'git.commit': { ko: '커밋 ({n})', en: 'Commit ({n})' },
  'git.staged': { ko: '스테이지됨 ({n})', en: 'Staged ({n})' },
  'git.changed': { ko: '변경됨 ({n})', en: 'Changes ({n})' },
  'git.stageAll': { ko: '모두 스테이지', en: 'Stage all' },
  'git.stageAllShort': { ko: '+ 전체', en: '+ All' },
  'git.noChanges': { ko: '변경 사항 없음', en: 'No changes' },
  'git.push': { ko: '푸시', en: 'Push' },
  'git.pull': { ko: '풀 (fast-forward)', en: 'Pull (fast-forward)' },
  'git.discard': { ko: '변경 버리기', en: 'Discard changes' },
  'git.discardConfirm': { ko: "'{name}' 의 변경을 버릴까요? 되돌릴 수 없어요.", en: "Discard changes to '{name}'? This can't be undone." },
  'git.syncFailed': { ko: '동기화 실패:\n{err}', en: 'Sync failed:\n{err}' },

  // ---- PreviewPanel ----
  'preview.captureTitle': { ko: '현재 화면을 캡처해 claude에 전달', en: 'Capture the current view and send to claude' },
  'preview.capture': { ko: '캡처', en: 'Capture' },
  'preview.empty': { ko: '실행 중인 서버 주소를 열어 미리 봐요.', en: 'Open a running server URL to preview.' },

  // ---- TerminalPanel ----
  'term.notifyTitle': { ko: 'riven — 터미널 {n}', en: 'riven — Terminal {n}' },
  'term.bell': { ko: '알림 🔔', en: 'Bell 🔔' },
  'term.done': { ko: '작업 완료 ✓', en: 'Done ✓' },
  'term.attn': { ko: '🔔 알림', en: '🔔 Alert' },
  'term.label': { ko: '터미널', en: 'Terminal' },
  'term.closeBusyConfirm': {
    ko: '이 터미널에서 에이전트가 실행 중입니다. 닫고 중지할까요?',
    en: 'An agent is still running in this terminal. Close and stop it?'
  },

  // ---- MonacoEditorPane ----
  'editor.revertThisChange': { ko: '이 변경 되돌리기', en: 'Revert this change' },
  'editor.sendSelTitle': { ko: '선택 영역을 @파일:줄 과 함께 실행 중인 에이전트로 전송 (⌘L)', en: 'Send selection with @file:line to the running agent (⌘L)' },
  'editor.noAgentTitle': { ko: '실행 중인 에이전트가 없어요 — 누르면 에이전트를 열어요', en: 'No agent running — click to open one' },
  'editor.toAgent': { ko: '에이전트로', en: 'To agent' },
  'editor.openAgent': { ko: '에이전트 열기', en: 'Open agent' },
  'editor.lines': { ko: '{n}줄', en: '{n} lines' },
  'editor.change': { ko: '변경 {cur}/{total}', en: 'Change {cur}/{total}' },
  'editor.prevChange': { ko: '이전 변경', en: 'Previous change' },
  'editor.nextChange': { ko: '다음 변경', en: 'Next change' },
  'editor.accept': { ko: '수락', en: 'Accept' },
  'editor.revert': { ko: '되돌리기', en: 'Revert' },
  'editor.emptyTitle': { ko: '파일을 선택하면 여기서 편집할 수 있어요.', en: 'Select a file to edit it here.' },
  'editor.emptyHint': { ko: '저장 ⌘S · claude 전송 ⌘L', en: 'Save ⌘S · Send to claude ⌘L' },

  // ---- EditorPanel ----
  'editor.unsavedConfirm': { ko: '저장하지 않은 변경이 있어요. 그래도 닫을까요?', en: 'You have unsaved changes. Close anyway?' },
  'editor.conflictBanner': { ko: '에이전트가 수정함 · 저장 안 한 변경과 충돌', en: 'Edited by agent · conflicts with unsaved changes' },
  'editor.loadDisk': { ko: '디스크 버전 불러오기', en: 'Load disk version' },
  'editor.agentEditedFull': { ko: '에이전트가 이 파일을 수정함 (전체)', en: 'The agent edited this file (whole file)' },

  // ---- SettingsModal ----
  'settings.title': { ko: '설정', en: 'Settings' },
  'settings.tab.general': { ko: '일반', en: 'General' },
  'settings.tab.keys': { ko: '단축키', en: 'Shortcuts' },
  'settings.tab.account': { ko: '계정', en: 'Account' },
  'settings.account.title': { ko: '계정 & 동기화', en: 'Account & Sync' },
  'settings.account.notConfigured': {
    ko: 'Supabase가 설정되지 않았습니다. 프로젝트 URL과 anon 키를 아래 환경변수로 지정하면 로그인·설정 동기화가 활성화됩니다.',
    en: 'Supabase is not configured. Set the project URL and anon key via the env vars below to enable login and settings sync.'
  },
  'settings.account.signInIntro': {
    ko: '로그인하면 테마·폰트·키맵 등 설정이 클라우드에 저장되어 다른 기기에서도 그대로 이어집니다.',
    en: 'Sign in to store your settings (theme, fonts, keymap, …) in the cloud and carry them across devices.'
  },
  'settings.account.continueGoogle': { ko: 'Google로 계속', en: 'Continue with Google' },
  'settings.account.continueGithub': { ko: 'GitHub로 계속', en: 'Continue with GitHub' },
  'settings.account.waiting': { ko: '로그인 창에서 인증을 완료해 주세요…', en: 'Complete sign-in in the login window…' },
  'settings.account.signOut': { ko: '로그아웃', en: 'Sign out' },
  'settings.account.syncNow': { ko: '지금 동기화', en: 'Sync now' },
  'settings.account.syncing': { ko: '동기화 중…', en: 'Syncing…' },
  'settings.account.synced': { ko: '동기화됨', en: 'Synced' },
  'settings.account.syncError': { ko: '동기화 실패', en: 'Sync failed' },
  'settings.account.syncNote': {
    ko: 'API 키 등 민감한 값은 동기화되지 않고 이 기기에만 저장됩니다.',
    en: 'Sensitive values like API keys are never synced — they stay on this device.'
  },
  'settings.language': { ko: '언어', en: 'Language' },
  'settings.theme': { ko: '테마', en: 'Theme' },
  'settings.editor': { ko: '에디터', en: 'Editor' },
  'settings.terminal': { ko: '터미널', en: 'Terminal' },
  'settings.font': { ko: '폰트', en: 'Font' },
  'settings.size': { ko: '크기', en: 'Size' },
  'settings.formatOnSave': { ko: '저장 시 자동 포맷', en: 'Format on save' },
  'settings.terminalProfiles': { ko: '터미널 프로파일', en: 'Terminal profiles' },
  'settings.terminalProfilesHint': {
    ko: '패널 메뉴에서 새 터미널로 실행할 명령 프리셋입니다.',
    en: 'Command presets launched as a new terminal from the panels menu.'
  },
  'settings.profileName': { ko: '이름', en: 'Name' },
  'settings.profileCommand': { ko: '실행 명령', en: 'Command' },
  'settings.addProfile': { ko: '+ 프로파일 추가', en: '+ Add profile' },
  'settings.snippets': { ko: '스니펫', en: 'Snippets' },
  'settings.snippetsHint': {
    ko: '접두어를 입력하면 본문이 자동완성으로 제안됩니다. ${1} 로 탭 정지점을 넣을 수 있어요.',
    en: 'Type the prefix to get the body as a completion. Use ${1} for tab stops.'
  },
  'settings.snippetPrefix': { ko: '접두어', en: 'Prefix' },
  'settings.snippetBody': { ko: '본문', en: 'Body' },
  'settings.addSnippet': { ko: '+ 스니펫 추가', en: '+ Add snippet' },
  'settings.resetDefaults': { ko: '기본값으로', en: 'Reset to defaults' },
  'settings.customFont': { ko: '커스텀…', en: 'Custom…' },
  'settings.importFontTitle': { ko: '폰트 파일(.ttf/.otf/.woff) 가져오기', en: 'Import a font file (.ttf/.otf/.woff)' },
  'settings.import': { ko: '가져오기', en: 'Import' },
  'settings.ai.inlineSection': { ko: '인라인 완성 (고스트 텍스트)', en: 'Inline completion (ghost text)' },
  'settings.ai.enable': { ko: '에디터 인라인 완성 사용', en: 'Enable editor inline completion' },
  'settings.ai.note1': {
    ko: '끄면 아무 백엔드도 안 돌아서 완전 경량이에요. 켜면 아래 백엔드로 커서 위치를 채워요 (Tab 수락).',
    en: 'Off means no backend runs — fully lightweight. On, the backend below fills in at the cursor (Tab to accept).'
  },
  'settings.ai.backend': { ko: '백엔드', en: 'Backend' },
  'settings.ai.ollama': { ko: 'Ollama (로컬 · 무료)', en: 'Ollama (local · free)' },
  'settings.ai.openai': { ko: 'OpenAI 호환 (API 키)', en: 'OpenAI-compatible (API key)' },
  'settings.ai.endpoint': { ko: '엔드포인트', en: 'Endpoint' },
  'settings.ai.model': { ko: '모델', en: 'Model' },
  'settings.ai.apiKey': { ko: 'API 키', en: 'API key' },
  'settings.ai.note2a': { ko: 'Ollama 예:', en: 'Ollama example:' },
  'settings.ai.note2b': { ko: '. OpenAI 호환은', en: '. OpenAI-compatible uses' },
  'settings.ai.note2c': { ko: '(suffix 지원 모델, 예', en: '(models supporting suffix, e.g.' },
  'usage.title': { ko: '오늘 에이전트 사용량 (로컬 로그 기반, 추정 비용)', en: "Today's agent usage (from local logs, estimated cost)" },
  'usage.today': { ko: '오늘 사용량', en: 'Usage today' },
  'usage.limitsHead': { ko: '남은 한도 (Claude)', en: 'Remaining (Claude)' },
  'usage.session': { ko: '세션 (5시간)', en: 'Session (5h)' },
  'usage.weekly': { ko: '주간 (7일)', en: 'Weekly (7d)' },
  'usage.pin': { ko: '사이드바에 고정', en: 'Pin to sidebar' },
  'usage.unpin': { ko: '고정 해제', en: 'Unpin' },
  'usage.resetIn': { ko: '{t} 후 초기화돼요', en: 'resets in {t}' },
  'usage.note': { ko: 'Claude Code 로컬 로그 기반 · API 가격 추정', en: 'From local Claude Code logs · estimated at API rates' },
  'title.editor': { ko: '코드', en: 'Code' },
  'title.preview': { ko: '프리뷰', en: 'Preview' },
  'title.search': { ko: '검색', en: 'Search' },
  'title.git': { ko: 'Git', en: 'Git' },
  'title.terminal': { ko: '터미널', en: 'Terminal' },
  'settings.ai.provider': { ko: '제공자', en: 'Provider' },
  'settings.ai.customModel': { ko: '커스텀…', en: 'Custom…' },
  'settings.ai.ollamaHint': {
    ko: '로컬 Ollama. 예: 터미널에서 ollama pull qwen2.5-coder:1.5b 후 사용. FIM 지원 코드 모델 권장.',
    en: 'Local Ollama. e.g. run `ollama pull qwen2.5-coder:1.5b`, then use it. FIM-capable code models recommended.'
  },
  'settings.ai.apiHint': {
    ko: '제공자를 고르면 엔드포인트가 자동 입력돼요. API 키만 넣으면 돼요. FIM(Codestral/DeepSeek)이 가장 정확, 나머지는 chat 기반.',
    en: 'Picking a provider auto-fills the endpoint — just add your API key. FIM (Codestral/DeepSeek) is most precise; others use chat.'
  },

  // ---- KeybindingsSettings ----
  'kb.tab.editor': { ko: '코드 에디터', en: 'Code editor' },
  'kb.tab.terminal': { ko: '터미널', en: 'Terminal' },
  'kb.tab.riven': { ko: '리븐 기본', en: 'Riven core' },
  'kb.hint': {
    ko: '바인딩을 클릭하고 원하는 키를 누르세요. Esc로 취소. 포커스된 영역에 따라 활성 단축키가 달라져요.',
    en: 'Click a binding and press the keys you want. Esc to cancel. Active shortcuts depend on the focused area.'
  },
  'kb.conflict': { ko: '충돌: {label}', en: 'Conflict: {label}' },
  'kb.recording': { ko: '키 입력…', en: 'Press keys…' },
  'kb.resetPreset': { ko: '프리셋 기본값', en: 'Preset default' },
  'kb.resetDefault': { ko: '기본값', en: 'Default' },
  'kb.presetHint': {
    ko: '프리셋 전환·개별 되돌리기는 다음 ⌘R(새로고침) 후 완전히 반영돼요.',
    en: 'Preset switches and per-key resets fully apply after the next ⌘R (reload).'
  },

  // ---- App ----
  'app.emptyHint': { ko: '왼쪽 워크스페이스 목록의 + 로 폴더를 열어 시작해요.', en: 'Open a folder with + in the workspace list on the left to start.' },
  'app.statusBarLabel': { ko: '상태바', en: 'Status bar' },

  // ---- categories (keybindings actions.ts) ----
  'category.리븐 기본': { ko: '리븐 기본', en: 'Riven core' },
  'category.터미널': { ko: '터미널', en: 'Terminal' },

  // ---- app action labels (keybindings/actions.ts) — translated at display sites ----
  'action.focus.editor': { ko: '에디터로 포커스', en: 'Focus editor' },
  'action.focus.terminal': { ko: '활성 터미널로 포커스', en: 'Focus active terminal' },
  'action.focus.panel.next': { ko: '다음 패널', en: 'Next panel' },
  'action.focus.panel.prev': { ko: '이전 패널', en: 'Previous panel' },
  'action.panel.explorer': { ko: '탐색기 사이드바 토글', en: 'Toggle Explorer sidebar' },
  'action.panel.search': { ko: '검색 패널', en: 'Search panel' },
  'action.panel.git': { ko: 'Git 패널', en: 'Git panel' },
  'action.panel.popout': { ko: '현재 패널 새 창으로', en: 'Pop out current panel' },
  'action.panel.preview': { ko: '프리뷰 패널', en: 'Preview panel' },
  'action.app.quickOpen': { ko: '파일 빠른 열기', en: 'Quick open file' },
  'action.app.commandPalette': { ko: '명령 팔레트', en: 'Command palette' },
  'action.app.settings': { ko: '설정 열기', en: 'Open settings' },
  'action.app.keybindings': { ko: '단축키 설정 열기', en: 'Open keyboard shortcuts' },
  'action.terminal.new': { ko: '새 터미널', en: 'New terminal' },
  'action.terminal.clear': { ko: '터미널 화면 지우기', en: 'Clear terminal' },
  'action.terminal.split.right': { ko: '터미널 오른쪽 분할', en: 'Split terminal right' },
  'action.terminal.split.down': { ko: '터미널 아래로 분할', en: 'Split terminal down' },
  'action.terminal.tab.next': { ko: '다음 터미널 탭', en: 'Next terminal tab' },
  'action.terminal.tab.prev': { ko: '이전 터미널 탭', en: 'Previous terminal tab' },
  'action.workspace.switch': { ko: '워크스페이스 {n}번으로 전환', en: 'Switch to workspace {n}' },
  'action.terminal.select': { ko: '{n}번 터미널로', en: 'Go to terminal {n}' },

  // ---- editor command labels (state/editorKeymaps.ts) — translated at display sites ----
  'editorcmd.actions.find': { ko: '찾기', en: 'Find' },
  'editorcmd.editor.action.startFindReplaceAction': { ko: '바꾸기', en: 'Replace' },
  'editorcmd.editor.action.addSelectionToNextFindMatch': { ko: '다음 같은 항목 선택', en: 'Add next occurrence' },
  'editorcmd.editor.action.selectHighlights': { ko: '같은 항목 모두 선택', en: 'Select all occurrences' },
  'editorcmd.editor.action.copyLinesDownAction': { ko: '줄 복제', en: 'Duplicate line' },
  'editorcmd.editor.action.deleteLines': { ko: '줄 삭제', en: 'Delete line' },
  'editorcmd.editor.action.moveLinesUpAction': { ko: '줄 위로 이동', en: 'Move line up' },
  'editorcmd.editor.action.moveLinesDownAction': { ko: '줄 아래로 이동', en: 'Move line down' },
  'editorcmd.editor.action.commentLine': { ko: '한 줄 주석', en: 'Toggle line comment' },
  'editorcmd.editor.action.blockComment': { ko: '블록 주석', en: 'Toggle block comment' },
  'editorcmd.editor.action.formatDocument': { ko: '문서 정렬', en: 'Format document' },
  'editorcmd.editor.action.rename': { ko: '이름 변경', en: 'Rename symbol' },
  'editorcmd.editor.action.quickFix': { ko: '빠른 수정', en: 'Quick fix' },
  'editorcmd.editor.action.revealDefinition': { ko: '정의로 이동', en: 'Go to definition' },
  'editorcmd.editor.action.goToReferences': { ko: '참조 찾기', en: 'Find references' },
  'editorcmd.editor.action.triggerSuggest': { ko: '자동완성', en: 'Trigger suggestions' },
  'editorcmd.editor.action.indentLines': { ko: '들여쓰기', en: 'Indent' },
  'editorcmd.editor.action.outdentLines': { ko: '내어쓰기', en: 'Outdent' },
  'editorcmd.editor.action.smartSelect.expand': { ko: '선택 확장', en: 'Expand selection' },
  'editorcmd.editor.action.smartSelect.shrink': { ko: '선택 축소', en: 'Shrink selection' },
  'editorcmd.editor.foldAll': { ko: '모두 접기', en: 'Fold all' },
  'editorcmd.editor.unfoldAll': { ko: '모두 펼치기', en: 'Unfold all' },
  'editorcmd.editor.action.quickCommand': { ko: '명령 팔레트', en: 'Command palette' },
  'editorcmd.editor.action.gotoLine': { ko: '줄 번호로 이동', en: 'Go to line' }
}

function interpolate(s: string, params?: Params): string {
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`))
}

// Core lookup. Second arg may be a Korean fallback string or a params object.
function translate(lang: Lang, key: string, arg1?: string | Params, arg2?: Params): string {
  const fallback = typeof arg1 === 'string' ? arg1 : undefined
  const params = typeof arg1 === 'string' ? arg2 : arg1
  const entry = DICT[key]
  const raw = entry ? (entry[lang] ?? entry.ko) : (fallback ?? key)
  return interpolate(raw, params)
}

export type TFn = (key: string, arg1?: string | Params, arg2?: Params) => string

// Reactive hook — re-renders the caller when the language setting changes.
export function useT(): TFn {
  const lang = useSettings((s) => s.settings.language)
  return (key, arg1, arg2) => translate(lang, key, arg1, arg2)
}

// Non-reactive translate for imperative code (confirm/alert/notifications).
export function t(key: string, arg1?: string | Params, arg2?: Params): string {
  return translate(getSettings().language, key, arg1, arg2)
}
