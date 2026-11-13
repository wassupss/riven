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

### 2단계 (2026-11-13): 터미널

`src/main/pty.ts`와 `src/main/terminal/*`(Node 워커, wasm 모델, 흐름 제어)를 Rust `services/pty`로 옮겼다. Tauri 빌드에는 터미널 워커(`terminal-worker.js`)와 node-pty가 더는 없다.

구조:

- **pty:** portable-pty. 셸은 로그인+인터랙티브(`-l -i`)로 띄우고, 환경은 Rust 자신의 환경에 로그인 셸 PATH(`shell_env::login_path()`), `TERM`, `CLAUDE_CONFIG_DIR`, UTF-8 로캘을 더한다. 예전엔 Node의 `process.env`를 그대로 넘겨 제어 회선 토큰(`RIVEN_TAURI_CTL_*`)까지 셸에 들어갔는데, 이제 들어가지 않는다.
- **터미널마다 스레드 2개:** 읽기(poll + read, 모델에 넣고, 묶어서 보내고, 화면이 밀리면 스스로 멈춤)와 쓰기(키 입력, 붙여넣기. pty가 가득 차면 막힐 수 있어서 따로). 화면이 보내는 write/ack/visible/resize/seen/kill은 제어 스레드 하나의 큐로 들어가 순서가 지켜진다. 메인 스레드는 큐에 넣기만 한다.
- **모델:** libghostty-vt를 네이티브 정적 라이브러리로 링크했다(`src-tauri/vendor/ghostty-vt/<target>/libghostty-vt.a`, `scripts/build-ghostty-vt-native.sh`로 화면 wasm과 같은 커밋에서 빌드, zig 0.17.0 필요, 빌드 42초, strip 후 3MB). 같은 엔진이라 Rust가 만든 스냅샷을 화면 wasm이 그대로 푼다(실앱 재접속에서 색, 한글, vim 대체 화면까지 확인). wasmtime으로 같은 wasm을 돌리거나 alacritty_terminal로 바꿀 이유가 없어졌다. 연속 바이트 추적(`CONTINUATION_MAX_BYTES`)을 켜서 이스케이프 중간에서도 스냅샷이 실패하지 않는다(Node 워커는 이때 빈 스냅샷을 보냈다).
- **흐름 제어:** 워커와 같은 값과 방식이다(UTF-16 단위로 보낸 양 - 화면이 처리했다고 알린 양, 2MB에서 멈추고 256KB에서 재개, 숨은 터미널은 보내지 않고 모델만 갱신). 멈춤은 읽기를 멈추는 것이라 셸의 쓰기가 커널 버퍼에서 막힌다. UTF-8 글자가 읽기 경계에서 잘리면 다음 읽기까지 들고 있어서 모델과 화면이 항상 같은 글자를 받는다.
- **화면으로 가는 출력: 루프백 WebSocket (바이너리).** 페이지(창 라벨)마다 연결 하나로 출력, 스냅샷, 종료, 벨, 제목을 순서대로 보낸다(`services/pty/stream.rs`, `tauri/shim/pty-stream.ts`). 토큰은 `pty_stream` 명령으로만 받는다. 상태 이벤트(`pty:status`, `pty:agent`, `pty:agentSession`, `pty:reply`, `pty:done`)는 1단계와 같은 `riven:ipc` 이벤트다. 화면 코드는 바꾸지 않았다.
- **Node에 남은 것 (`tauri/shim/moved/pty.ts`, 186줄):** MCP 서버와 훅 경로가 아직 Node라서, 셸에 넣을 riven 환경(zsh shim, `RIVEN_*`)은 Rust가 새 터미널마다 제어 회선으로 물어보고(`ptyEnv` -> `pty.env`), 에이전트 훅은 Node가 받아 Rust로 넘긴다(`pty.hook`). 종료 확인에 쓰는 "일하는 터미널 에이전트 수"는 Rust가 바뀔 때마다 알려준다(`ptyAgents`). `pty:codexSessionTitle`은 Node 그대로다. 4단계(MCP)에서 같이 옮긴다.

Tauri Channel이나 `webview.eval`을 쓰지 않은 이유 (측정):

- 지금 페이지는 Node가 `http://127.0.0.1`로 주므로 WebKit이 Tauri의 `ipc://` fetch를 막는다. 그러면 Tauri가 postMessage + eval로 대신 보내고, 1KB 넘는 raw Channel 메시지는 숫자 JSON 배열로 온다(4배 크기, ArrayBuffer가 아니라 배열). 실제로 이 경로에서 프레임 해석이 깨졌다.
- 문자열을 `webview.eval`로 바로 넣는 방식은 동작은 했지만 300MB 출력 뒤 riven-tauri 메모리가 202MB에서 500MB로 늘고 돌아오지 않았다(footprint의 "Owned physical footprint (unmapped)" 441MB, 영역 4498개. eval 스크립트가 WebKit 쪽에서 풀릴 때까지 이 프로세스 몫으로 남는다).
- WebSocket으로 바꾼 뒤 같은 300MB에서 66MB -> 69MB. 8단계에서 페이지를 Tauri가 직접 주면 raw Channel이 진짜 바이너리 경로가 되므로 그때 다시 비교한다.

측정 (릴리스 빌드, 같은 바이너리에 1단계 Node 번들을 `RIVEN_TAURI_MAIN`으로 붙여 비교, 터미널 167x50, footprint 기준):

| | Node 워커 (1단계) | Rust (2단계) |
|---|---|---|
| 프로세스 | 셸 + Node 메인 + 터미널 워커 | 셸 + Node 메인 |
| `yes \| head -c 200MB` (커널 pty 한계 약 3.7MB/s, `script`로 따로 잰 값도 3.8MB/s) | 3.7MB/s, 워커 CPU 101%, 워커 메모리 19 -> 163MB (끝나도 163MB) | 3.5MB/s, Rust CPU 102% (78%가 커널 시간: pty read와 ghostty가 스크롤백 페이지를 재사용할 때 하는 madvise), Rust 메모리 69MB 이하 유지, 끝난 뒤 55MB |
| 줄바꿈 없는 300MB (`head -c /dev/zero \| tr`) | 25.7MB/s, 워커 18% + Node 메인 8%(중계), 워커 19 -> 67MB | 24.4~26.9MB/s, Rust 20%, Rust 66 -> 69MB |
| 숨은 터미널 100MB | | 4초, Rust 메모리 63 -> 64MB |
| 출력 중 화면 반응 (페이지에 eval 왕복) | 중앙값 4ms, 최대 7ms | 중앙값 1~3ms, 최대 4~6ms |
| 키 입력 왕복 (write -> 셸 에코 -> 화면 도착) | | 중앙값 2ms, 최대 4ms |

`yes`류 홍수에서 CPU는 비슷하다(둘 다 커널이 병목). 차이는 메모리(워커는 늘어난 채로 남음)와 프로세스 하나가 줄어든 것, Node 메인이 터미널 바이트를 중계하지 않게 된 것이다. 화면 쪽(WebContent) CPU와 메모리는 두 경우가 같았다. 측정 중 창이 가려져 `document.hidden`이었던 구간이 있다(그리기는 안 하고 해석은 함). 마지막 줄바꿈 없는 측정(26.9MB/s)과 키 입력 측정은 창을 앞에 둔 상태다.

실앱에서 확인한 것: 셸 PATH(로그인 PATH 25개 항목), 입력 에코, 창 크기 변경(`stty size`가 30 100 -> 41 132, 화면 크기 50 167), 한글/이모지/넓은 글자 줄바꿈, 벨, 제목, `exit 7` 종료 코드 전달, kill(프로세스 사라짐, exit 이벤트 없음은 Electron과 같음), 터미널 두 개 동시 출력, 새로고침 후 재접속 스냅샷(색, 한글, vim 대체 화면), 앱 종료 시 셸 정리, 에이전트 감지(pgrep, `pty:agent`), 훅 왕복(`UserPromptSubmit`/`Stop` -> `pty:status`, `pty:agentSession`, `pty:done` 요약, `pty:reply`), MCP `riven_agents`와 `riven_ask_agent`(터미널에 입력하고 Stop 훅의 답을 돌려받음), 터미널에서 띄운 MCP `riven_open_panel kind=terminal`.

추론만 한 것: 종료 확인 대화상자의 터미널 에이전트 수(`ptyAgents` 이벤트는 보내지만 Node 쪽 값을 직접 읽어 보지는 않았다), 셸이 SIGHUP을 무시할 때의 kill, 백그라운드 작업이 pty를 쥐고 있어 셸이 끝나도 EOF가 오지 않는 경우(그 작업이 끝날 때까지 터미널이 살아 있다), x86_64 정적 라이브러리(빌드만 하고 링크/실행은 안 해 봄), `tauri/package.mjs`의 `tauri build` 전체(스테이징만 확인: node-pty 제거로 app 246MB -> 183MB).

남은 Node 코드 (`src/main`, 테스트 제외, Tauri 빌드의 Node 번들에 들어가는 것):

| | 줄 수 |
|---|---|
| 1단계 후 | 22,026 |
| 2단계 후 | 20,512 (pty.ts 682 + terminal 워커/모델/흐름 제어 832 제외) |

`src/main/terminal/activity.ts`(139줄)는 agents.ts가 훅 이름 해석에 써서 번들에 남는다. 이와 별도로 `tauri/shim/moved/pty.ts` 186줄이 4단계까지 Node에 남는다.

다음 단계가 알아야 할 것:

- **`cargo build --release` 함정:** `tauri build`를 한 번 하면 `target/release/app`과 `target/release/node`가 남고, `main.rs`의 `bundled()`가 그걸 리소스로 보고 옛 앱 트리를 띄운다. 릴리스 바이너리로 시험할 때는 `RIVEN_TAURI_MAIN=$PWD/out-tauri/main/index.js`를 준다.
- **WebSocket 경로는 채팅 스트림(3단계)에도 쓸 수 있다.** `stream::send(label, frame)`에 종류만 더하면 된다. 큰 데이터를 `emit`/`eval`로 보내면 위의 메모리 문제가 난다.
- **MCP를 옮길 때(4단계):** `ptyEnv`/`pty.hook`/`ptyAgents` 왕복을 없애고 `services/pty::open`에서 직접 환경을 만들면 된다. zsh shim 파일 내용은 `tauri/shim/moved/pty.ts`에 있다.
- **ghostty 메모리 압축:** libghostty-vt에 `ghostty_terminal_compress`가 있다. 숨은 터미널의 스크롤백을 줄이는 데 쓸 수 있다(아직 안 씀).

### 시험 실행: 백그라운드 모드 (2026-11-13)

에이전트나 스크립트가 앱을 띄울 때는 반드시 `RIVEN_TAURI_BACKGROUND=1`을 준다 (예: `RIVEN_TAURI_BACKGROUND=1 RIVEN_TAURI_TEST_KEY=... tauri/run.sh --no-renderer`). 사용자가 다른 작업을 하는 중에 시험 창이 앞으로 나오면 안 되기 때문이다. `tauri/run.sh`는 이 값을 기본으로 켜지 않는다(평소 개발은 앞에 띄운다).

- 앱을 Accessory로 돌린다(독 아이콘 없음, 활성화 안 됨). Node 쪽 `app.activationPolicy`, `app.focus`, `win.focus`는 무시한다.
- 창(메인, 펫, dockview 팝아웃)은 포커스 없이 만들고 앞에 띄우는 대신 `orderBack`으로 모든 창 뒤에 놓는다. `win.show`도 같다(시험 훅의 `op=front` 포함).
- 창은 화면에 있는 상태라 WebKit이 페이지를 숨김으로 보지 않는다(`document.visibilityState`가 `visible`).
- Node에는 `RIVEN_TEST_BACKGROUND=1`을 넘긴다(index.ts: `showInactive`, 알림 센터 등록 생략).
- 확인 방법: 실행 전후로 맨 앞 앱(`lsappinfo info -only name $(lsappinfo front)`)이 바뀌지 않고, `CGWindowListCopyWindowInfo` 순서에서 riven-tauri 창이 맨 뒤에 있어야 한다. `osascript`로 System Events에 묻는 방법은 이 환경에서 Apple 이벤트 권한이 없어 쓰지 못했다.

### 3단계 (2026-11-13): 에이전트 채팅

`src/main/agentChat.ts`, `codexChat.ts`와 채팅만 쓰던 도우미(mcpServers, mcpRepair, sessionProbe, sessionScan, sessionTitle, turnClaim, resultError, cliArgs, chatContent)를 Rust `services/chat`으로 옮겼다. 명령은 `commands/chat.rs`.

Rust로 옮긴 채널 (invoke/send 28개, 이벤트 2개):

- 채팅: `chat:start`, `send`, `alive`, `interrupt`, `restart`, `setModel`, `setMode`, `stop`, `title`, `detectClis`
- 지난 세션: `chat:sessions`, `sessionRename`, `sessionDelete`, `sessionTitle`, `sessionTranscript`(Claude, 없으면 Codex rollout), `agents`
- MCP: `chat:sessionInfo`, `mcpSession`, `mcpList`, `mcpLogout`, `mcpApprove`
- 계정, CLI 업데이트: `accounts:list`, `profileDir`, `logout`, `cli:update`, `updateStatus`, `applyUpdate`, `deferUpdate`
- 이벤트: `chat:event`(그 패널을 시작하거나 다시 붙은 페이지로), `cli:update-changed`(모든 앱 창)

구조:

- 패널마다 CLI 자식 하나(`claude -p --input-format stream-json ...` 또는 `codex app-server`). 인자, 환경, 이벤트 내용은 Node 판과 같다. stdin은 쓰기 태스크 하나가 순서대로 쓰고, stdout은 줄 단위로 읽어 `claude.rs`/`codex.rs`가 ChatEvent로 바꾼다. CLI는 로그인 셸 PATH(`shell_env::login_path`)로 찾고 띄운다. 구독 로그인을 쓰도록 API 키나 `--bare`를 넣지 않는 것도 같다.
- 스트림은 1단계와 같은 `riven:ipc` 이벤트로 보낸다. 2단계의 WebSocket은 쓰지 않았다. 측정: 600줄 답(텍스트 이벤트 151개, 3초) 동안 riven-tauri CPU 최대 5.5%, 평균 0.6%(디버그 빌드), footprint 58MB 그대로. Node CPU는 0~0.1%. 채팅은 한 턴이 수 KB라 pty의 메모리 문제(eval이 쌓임)가 생길 양이 아니다.
- 유휴 park(15분, `RIVEN_CHAT_IDLE_PARK_MS`), 파킹된 패널에 메시지가 오면 `--resume`으로 되살리기, 오래된 resume 대상이면 새로 시작하고 못 보낸 메시지 다시 보내기, CLI가 바뀌면 그 자리에서 교체(턴이나 백그라운드 작업이 끝날 때까지 미룸), 턴 id 대기열과 백그라운드 보고 턴 처리(turnClaim)를 그대로 옮겼다.
- 디스크 형식은 바꾸지 않았다. 지난 세션은 CLI의 `.jsonl`을 그대로 읽고, 이름 바꾸기는 CLI의 `custom-title` 줄을 덧붙이며, `userData/mcp-servers.json`은 같은 키(`configDir\0cwd`)와 모양이다.
- JSON 읽기: JS가 쓴 외톨이 서로게이트 이스케이프(`\ud83d`)를 `JSON.parse`는 받고 serde는 거부한다. 그 줄을 버리면 세션의 메시지 수가 하나 모자라서(실제 데이터에서 발견), 실패한 줄은 그 이스케이프를 U+FFFD로 바꿔 다시 읽는다(`util::parse`).
- 종료: 셸이 끝날 때 `services::chat::shutdown()`이 모든 자식을 끈다(RunEvent::Exit). 셸이 SIGTERM으로 바로 죽으면 Exit이 오지 않지만 stdin이 닫혀 claude와 codex 모두 스스로 끝났다(확인).

Node에 남은 것 (`tauri/shim/moved/agentChat.ts`, 4단계 MCP와 같이 지운다):

- `chatEnv` -> `chat.env`: 패널을 띄울 때 Rust가 riven MCP 설정(`--mcp-config` JSON, 도구 안내 프롬프트, 허용 접두사), 훅 환경(`RIVEN_HOOK_*`, `--settings` 파일), `MCP_TOOL_TIMEOUT`, Codex용 URL/토큰을 묻는다. Node는 `mcpReady()`를 기다린 뒤 답한다(8초 제한, 없으면 riven 도구 없이 띄움). 환경 탐침(`chat:sessionInfo`)은 기다리지 않는다(원래 동작).
- `chatEdit`: Codex 패널의 파일 변경을 변경 타임라인으로(`agentHooks.reportAgentEdit`).
- `chatRunning`: 턴 중인 패널 수. 종료 확인 대화상자가 쓴다(`runningChatCount`).
- MCP 도구(`riven_ask_agent`, `riven_open_panel kind=chat` 등)는 전부 화면을 거쳐 `window.api.chat.*`를 부르므로 Node가 채팅 함수를 직접 부르는 곳은 없었다. 4단계에서는 위 세 메시지를 없애고 `services/mcp`가 설정과 훅 환경을 직접 주면 된다.

Node 판과 다른 점:

- 존재하지 않는 cwd 등으로 spawn이 실패하면 Node는 `{ok:true}`를 준 뒤 조용히 세션을 지웠다. Rust는 그 자리에서 `{ok:false, error}`를 준다.
- 자식 환경에 Node의 제어 회선 토큰(`RIVEN_TAURI_CTL_*`)이 더는 들어가지 않는다(2단계 pty와 같음).
- stdout 끝의 줄바꿈 없는 마지막 조각은 Node처럼 버린다. 자식이 끝난 뒤 남은 출력은 최대 2초까지 다 읽고 exit을 보낸다(Node는 exit이 먼저 올 수 있었다).

실앱에서 확인한 것(백그라운드 모드, 개발 빌드): Claude 한 턴 왕복과 스트리밍(첫 글자 0.9초), AI 제목(`chat:title`), `ask_user` 질문이 패널에 뜨고 화면에서 "Yes"를 눌러 답이 에이전트에게 돌아감, 턴 중 중단(버튼 누르고 10ms 뒤 turnDone, 프로세스는 유지), 앱 재시작 뒤 대화 복원(화면 기록 + `--resume`), 유휴 park(90초로 줄여서 확인, 자식 종료, `alive`는 true) 뒤 메시지로 되살아나 앞 대화 기억, Codex 한 턴(init/text/usage/turnDone, turn id 일치), Codex 대화 기록 복원, Codex stop 시 프로세스 종료와 exit 이벤트, `riven_open_panel kind=chat agent=codex` + `riven_ask_agent` 왕복(Codex 쪽 오류가 그대로 돌아옴, 시험용으로 기본 모델을 haiku로 둔 탓), `chat:sessionInfo` 탐침(명령 97개, MCP 상태)과 자식 정리, `chat:mcpList`, 셸 종료 시 claude/codex 자식 정리.

같은 입력으로 Node 판(원래 agentChat.ts를 electron 대역으로 묶어 실행)과 Rust 판 결과를 바이트 단위로 비교: `chat:sessions`(8개 cwd), `agents`, `sessionTranscript`/`sessionTitle`(세션 파일 약 35개, Codex rollout 포함), `accounts:list`, `detectClis` 88건 중 87건 같음(나머지 1건은 대역의 userData 경로 차이). 처음엔 위 서로게이트 문제로 1건이 달랐다.

추론만 한 것: 내장 도구 거부(`permission_denied` -> `denied`), `chat:restart`/CLI 업데이트 적용, `chat:mcpApprove`(사용자의 `~/.claude.json`을 건드려서 실행하지 않음), `chat:mcpLogout`, `accounts:logout`, 프로필(`CLAUDE_CONFIG_DIR`) 패널과 플러그인 링크, 이미지 첨부, 백그라운드 작업 보고 턴, 종료 확인 대화상자의 채팅 수(`chatRunning`은 보내지만 Node 값을 직접 읽지는 않음), 정상 종료 경로(Node의 app.quit -> 셸 Exit -> shutdown)로 자식이 꺼지는 것(SIGTERM으로 셸을 죽인 경우만 확인).

남은 Node 코드 (`src/main`, 테스트 제외, Tauri 빌드의 Node 번들에 들어가는 것):

| | 줄 수 |
|---|---|
| 2단계 후 | 20,512 |
| 3단계 후 | 17,126 (agentChat 2,088 + codexChat 622 + 도우미 676 제외) |

`lineStream.ts`와 `codexSessions.ts`는 다른 모듈이 써서 남는다. 이와 별도로 `tauri/shim/moved/agentChat.ts` 85줄이 4단계까지 Node에 남는다. 번들의 소스맵으로 센 실제 `src/main` 줄 수는 14,827이다(전에도 이 방법으로 세지 않아 비교용으로만 적는다).

다음 단계가 알아야 할 것:

- `usage.ts`(usage:today 등), `modelCatalog.ts`, `cli.ts`(cli:list)는 채팅 그룹이 아니라서 Node에 남겼다(7단계 작은 기능).
- 시험 중 채팅 패널 입력은 `.chat-panel` 안의 textarea에 값을 넣고 Enter keydown을 보내면 된다. 새 패널이 열리면 보이는 textarea가 바뀌니 대상 패널을 골라서 넣을 것.
