# riven Tauri: Rust 메인 설계

작성 2026-11-13. 브랜치 `feat/tauri-port`.

## 1. 목표

Tauri로 옮기는 이유는 가볍고 빠르게 만들기 위해서다. 그래서 메인 프로세스는 Node 없이 Rust로만 돈다.

현재 측정 (빈 상태, 실행 25초 후):

| | Electron v0.3.2 | 지금 Tauri (Node 동봉) | 목표 |
|---|---|---|---|
| 앱 용량 | 379MB | 374MB | 40MB 이하 (언어 서버 제외) |
| 메인 쪽 메모리 | 73MB (Electron 메인) | 108MB (셸 36 + Node 72) | 30MB 이하 |
| 화면 쪽 메모리 | 224MB (Chromium 4개) | 484MB (WebKit 4개) | 별도 조사 후 목표 설정 |
| 쉴 때 CPU | 약 1.7% | 약 1.0% | 1% 이하 유지 |

화면 쪽(WebKit) 메모리는 메인을 Rust로 바꿔도 줄지 않는다. 3장 0단계에서 따로 원인을 잡는다.

## 2. 최종 구조

```
┌──────────── riven-tauri (Rust, 프로세스 1개) ────────────┐
│  tauri 셸: 창, 메뉴, 트레이, 다이얼로그, 브라우저 패널     │
│  commands/*: 화면이 부르는 기능 (invoke)                   │
│  events: 메인 → 화면 알림 (emit / Channel)                 │
│  services/*: pty, chat, mcp, db, git, lsp, watcher ...     │
│  tokio 런타임 하나 위에서 비동기로 동작                     │
└────────────────────────────────────────────────────────────┘
        │ 자식 프로세스 (riven 밖의 프로그램)
        ├─ 셸 (pty)
        ├─ claude / codex CLI (에이전트 채팅)
        ├─ git, gh
        └─ 언어 서버 (pyright 등, 사용자 Node로 실행)
```

- Node 런타임, node_modules, 셰임(shim) 코드는 최종 결과물에 없다.
- 화면(renderer) 코드는 바꾸지 않는다. 화면은 지금처럼 `window.api.*`를 부른다.
- `src/preload/index.ts` 대신 `tauri/api/index.ts`를 새로 만든다. 같은 `window.api` 모양을 Tauri `invoke` / `listen` / `Channel`로 구현한다. 화면이 보는 인터페이스는 그대로다.

## 3. 통신 규칙

지금 preload가 쓰는 방식은 invoke 207개, send 30개, on 32개, sendSync 2개다.

| Electron | Tauri |
|---|---|
| `ipcRenderer.invoke('a:b', x)` | `invoke('a_b', { x })`, Rust `#[tauri::command] async fn` |
| `ipcRenderer.send` (응답 없음) | 같은 `invoke`, 반환값 무시 |
| `webContents.send` → `ipcRenderer.on` | `app.emit` / 창별 `emit_to`. 고빈도 흐름(pty 출력, 채팅 스트림)은 `tauri::ipc::Channel`로 보낸다 |
| `sendSync` 2개 | 시작 시 한 번 받아 캐시하는 값으로 바꾼다 (동기 호출 없음) |

- 명령 이름은 `그룹_동작` 형식이다 (예: `git_status`, `pty_write`).
- 인자와 반환 타입은 Rust `serde` 구조체로 정의한다. 화면 쪽 타입은 `ts-rs` 등으로 Rust에서 생성해 어긋남을 막는다.
- pty 출력 같은 큰 바이트 흐름은 JSON 대신 바이너리(`Channel<Vec<u8>>` 또는 `tauri::ipc::Response`)로 보낸다.

## 4. 모듈 대응

| 기능 (지금 파일, 줄 수) | Rust 구현 | 쓸 crate |
|---|---|---|
| 설정, 세션, 워크스페이스 (config, sessions, workspace) | `services/workspace` | serde_json, notify (파일 감시) |
| 파일 검색 (search) | `services/search` | ignore, grep-searcher (ripgrep 엔진) |
| 터미널 (pty 682, terminal/worker 565) | `services/pty`: pty + 터미널 상태 모델 | portable-pty, libghostty-vt 네이티브 링크 |
| 에이전트 채팅 (agentChat 2088, codexChat 622) | `services/chat`: CLI 실행, stream-json 파싱 | tokio::process, serde_json |
| MCP 도구 서버 (mcpServer 931, mcpServers 257) | `services/mcp`: 루프백 HTTP MCP 서버 | axum, rmcp |
| 브라우저 패널 (browser 721) | 이미 Rust (`browser.rs`). TS 로직만 Rust로 이동 | 기존 코드 |
| DB (db/* 약 7천 줄) | `services/db` | tokio-postgres, mysql_async, rusqlite |
| git (git 418) | `services/git`: git CLI 실행 결과 파싱 | tokio::process |
| GitHub PR (githubPr*, 약 1300줄) | `services/github`: gh CLI 또는 REST | reqwest |
| 언어 서버 (lsp 416) | `services/lsp`: 설치된 서버 찾기, 프로세스 실행과 stdio 중계 | tokio::process |
| 디버거 (debugger 289) | `services/debug`: Node 실행 + CDP 중계 | tokio-tungstenite |
| 알림, 트레이, 잠자기 방지, 권한, 독 | 셸 쪽 | tauri-plugin-notification, IOPMAssertion (objc2) |
| 사용량, 포트, 진단, 펫, 메모, API 클라이언트 등 | 각각 작은 모듈 | reqwest, serde |
| 자동 업데이트 (update) | tauri-plugin-updater | |
| 로그인 (auth) | 셸의 OAuth 창 + 딥링크 | tauri-plugin-deep-link |

### 터미널 상태 모델

지금은 libghostty-vt wasm을 Node 워커에서 돌린다. Rust에서는 libghostty-vt를 네이티브 정적 라이브러리로 링크해서 같은 엔진을 쓴다. 화면 쪽 렌더러도 같은 엔진이라 재접속 스냅샷이 일치한다.

빌드가 막히면 alacritty_terminal로 대체한다. 이 경우 스냅샷 형식 변환이 추가로 필요하다.

### 언어 서버

pyright, typescript-language-server 등은 그 자체가 Node 프로그램이라 Rust로 바꿀 수 없다. 앱에 넣지도, 내려받지도 않는다. 사용자 컴퓨터에 설치된 것만 쓴다 (2026-11-13 결정).

1. 워크스페이스의 node_modules (지금도 우선)
2. 사용자 PATH의 언어 서버 (`pyright-langserver`, `bash-language-server` 등)
3. 사용자 PATH의 Node로 실행 (Node 프로그램인 서버)
4. 다 없으면 그 언어의 언어 서버 기능만 꺼지고, 에디터 상태줄에 무엇을 설치하면 되는지 안내한다

GUI 앱은 셸 설정(`~/.zshrc`의 nvm 등)을 읽지 않아 PATH가 짧다. 시작할 때 로그인 셸(`$SHELL -lic 'echo $PATH'`)에서 PATH를 한 번 받아 쓴다.

## 5. 진행 방식

한 번에 다 바꾸지 않는다. 그룹 단위로 옮기고, 매 단계마다 앱이 실제로 돌아가는 상태를 유지한다.

1. 새 `window.api` 구현(`tauri/api`)은 그룹마다 Rust 명령을 부른다. 아직 안 옮긴 그룹은 임시로 기존 Node 경로를 부른다.
2. 그룹 하나를 옮기면 그 그룹의 Node 쪽 코드는 셰임에서 지운다.
3. 마지막 그룹을 옮기면 Node, 셰임, node_modules 동봉을 통째로 삭제한다. 이게 끝난 상태가 목표 구조다.

Node 경로는 옮기는 동안만 쓰는 임시 발판이다. 단계마다 남은 Node 코드 줄 수를 기록해서 줄어드는 걸 확인한다.

## 6. 단계

각 단계의 완료 기준은 그 기능을 실앱에서 실제로 써서 확인하는 것이다.

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| 0 | WebKit 메모리 조사 (화면 프로세스 236MB 원인) | 원인과 줄일 수 있는 양을 숫자로 보고 |
| 1 | 뼈대: `tauri/api`, 명령/이벤트 규칙, 타입 생성. 설정, 세션, 워크스페이스, 파일, 검색, 감시 | 워크스페이스 열기, 파일 트리, 편집, 저장, 검색이 Rust로 동작 |
| 2 | 터미널: pty + libghostty-vt 모델, 흐름 제어, 재접속 | 셸 실행, 대량 출력, 창 크기 변경, 탭 재접속 |
| 3 | 에이전트 채팅: claude/codex 실행, 스트림, 권한 요청, 세션 복원 | 채팅 한 턴 왕복, 중단, 재시작 후 복원 |
| 4 | MCP 도구 서버 | claude CLI가 riven 도구를 호출해 결과 받기 |
| 5 | git, GitHub PR | 상태, 커밋, diff, PR 목록과 상세 |
| 6 | DB | pg, mysql, sqlite 연결, 조회, 스키마 |
| 7 | 언어 서버, 디버거, 나머지 작은 기능 | 각 기능 동작 확인 |
| 8 | Node 제거, 패키징, 서명/공증, tauri-plugin-updater, 배포 | `.app`에 Node 없음, 용량/메모리 목표 확인 |

0단계와 1단계는 독립이라 같이 진행할 수 있다.

## 7. 위험 요소

- **libghostty-vt 네이티브 빌드:** Zig 툴체인이 필요하다. 막히면 alacritty_terminal로 간다.
- **에이전트 채팅:** 가장 크고(2700줄) 실제 사용 빈도가 가장 높다. 옮기는 동안 Electron 버전을 계속 배포해서 사용자 영향을 막는다.
- **DB 드라이버 차이:** pg/mysql2와 Rust 드라이버의 타입 변환이 다르다(날짜, 숫자, JSON). 기존 통합 테스트(`*.integration.test.ts`)를 Rust 테스트로 옮겨 같은 결과를 확인한다.
- **화면 메모리:** WebKit이 Chromium보다 많이 쓰는 원인이 riven 코드가 아니면 줄이기 어렵다. 0단계 결과에 따라 목표를 조정한다.
- **Windows:** WebView2 기반이라 별도 확인이 필요하다. macOS 먼저 끝내고 진행한다.

## 8. 결정 사항 (2026-11-13)

1. **진행 방식:** 5장대로 Node를 임시 발판으로 두고 단계마다 앱이 돌아가게 한다. 8단계에서 Node를 통째로 지운다.
2. **Electron:** Tauri가 8단계를 마칠 때까지 Electron 버전을 계속 배포한다.
3. **Windows:** macOS를 끝낸 뒤 진행한다.
4. **언어 서버:** 설치된 것만 쓴다 (4장).

## 9. 진행 기록

### 1단계 (2026-11-13): 설정, 세션, 워크스페이스, 검색, 메모, 파일 감시

경계(seam): `tauri/shim/rust-owned.ts` 목록 하나가 기준이다. 여기 있는 채널은 preload 셰임이 Node 대신 Tauri `invoke`로 보내고(채널 `a:bC` -> 명령 `a_b_c`, 위치 인자 -> 이름 인자), Rust가 보내는 이벤트는 Tauri 이벤트 `riven:ipc`(`{ch, args}`, 창 라벨 대상)로 받아 기존 `ipcRenderer.on` 리스너에 넘긴다. 옮긴 그룹의 `src/main` 모듈은 Tauri 빌드에서 `tauri/shim/moved/*` 빈 모듈로 바뀐다(`tauri/build.mjs`의 `MOVED`). Rust 명령은 `src-tauri/src/commands/*`에 `#[tauri::command]`로 두면 build.rs가 권한 세트 `rust-main`을 만들어 앱 창(`w*`, `pop-*`)에만 허용한다.

Rust로 옮긴 채널 (invoke/send/sendSync 34개, 이벤트 1개):

- config: `config:load`, `config:save`, `config:reveal`, `config:save-sync`
- sessions: `sessions:load`, `sessions:save`, `sessions:save-sync`
- workspace: `workspace:setRoots`, `pickFolder`, `readDir`, `listFiles`, `readFile`, `writeFile`, `createFile`, `createFolder`, `rename`, `delete`, `reveal`, `importPaths`, `snapshotContents`, `image:saveTemp`, `font:import`, `scripts:list`
- search: `search:inFiles`, `search:replaceInFiles`
- notes: `notes:list`, `read`, `write`, `append`, `delete`, `writeFile`, `saveToFile`
- 감시: `watch:start`, `watch:stop`, 이벤트 `fs:changed`

그 밖에: 로그인 셸 PATH (`services/shell_env.rs`, 시작 시 `$SHELL -lic`로 한 번 읽음, 5초 제한). 이후 단계의 자식 프로세스는 `shell_env::command()` / `tokio_command()`로 띄운다.

남은 Node 코드 (`src/main`, 테스트 제외):

| | 줄 수 |
|---|---|
| 1단계 전 | 22,753 |
| 1단계 후 (Tauri 빌드의 Node 번들에 들어가는 것) | 22,026 |

`src/main` 파일 자체는 Electron 배포가 계속 쓰므로 지우지 않는다. 줄 수는 Tauri 빌드에서 빠진 모듈(config, sessions, workspace, search, notes, 727줄)을 뺀 값이다. bridge.ts의 watch 처리(약 60줄)는 번들에 남아 있지만 호출되지 않는다.

다음 단계가 알아야 할 것:

- **sendSync:** Tauri에는 동기 호출이 없다. Rust 소유 sendSync(`*-sync`)는 지금 Node의 동기 XHR 엔드포인트가 Rust로 중계한다(`ipc.sync`). WebKit이 페이지 종료 중에 동기 XHR을 거부하면 같은 저장의 비동기 명령을 Rust로 보내고 기다리지 않는다. Node를 지울 때는 이 중계 대신 창 닫기 시 Rust가 페이지에 저장을 요청하는 방식이 필요하다.
- **창 닫기 저장 누락 (기존 문제):** WKWebView는 스크립트나 셸이 시작한 새로고침/닫기에 beforeunload를 보내지 않는다. 셰임이 pagehide에서 beforeunload를 대신 보내도록 해서 새로고침은 해결했다. 창을 닫을 때는 pagehide도 오지 않아, 300ms 디바운스 안의 설정/세션 변경이 사라진다(1단계 전에도 같았다).
- **Node가 쓰는 Rust 상태:** media.ts의 `isConfined`는 워크스페이스 루트가 필요하다. Rust가 `setRoots` 때마다 제어 회선으로 `roots` 이벤트를 보내고 `tauri/shim/moved/workspace.ts`가 받는다. 다른 그룹을 옮길 때도 Node에 남는 코드가 그 그룹의 함수를 직접 부르는지 먼저 확인한다.
- **이름 정렬:** `readDir`의 `localeCompare`는 ICU 없이 `services/collate.rs`로 흉내 낸다(실제 파일 이름 7,745개로 Node와 같은 순서 확인). Node `fs.readdir`는 이름 바이트 순으로 정렬해서 돌려주므로 Rust 쪽 디렉터리 순회도 정렬한다(`fsx::read_dir_sorted`). 검색 결과 순서와 개수 제한이 여기에 달려 있다.
- **검색 정규식:** JS RegExp 대신 Rust `regex`를 쓴다. 전후방 탐색과 역참조는 지원하지 않아 결과 없음으로 처리된다(잘못된 정규식과 같음).
- **감시 이벤트:** FSEvents 기반이라 원자적 저장(임시 파일 + rename)은 chokidar의 `change` 대신 `add`로 온다. 받는 쪽(탐색기, git)은 둘을 같게 처리한다.
