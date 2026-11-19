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
- 앱이 뜰 때 tao가 `activateIgnoringOtherApps:YES`로 앱을 활성화한다. Accessory여도 다른 앱이 바쁘지 않으면 시험 앱이 맨 앞으로 왔다(5단계 시험 중 한 번 발생). 백그라운드 모드에서는 `activate_ignoring_other_apps(false)`(다른 앱이 활성이면 활성화하지 않음)로 빌드하고, 활성화 정책도 `setup` 전, 띄우기 직전에 Accessory로 둔다. 이후 시험에서는 50ms 간격 감시(맨 앞이 되면 바로 종료)로 한 번도 앞에 오지 않았다.
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

### 4단계 (2026-11-13): MCP 도구 서버

`src/main/mcpServer.ts`, `agentHooks.ts`, `agents.ts`, `agentEdits.ts`, 훅 해석(`terminal/activity.ts`의 `claudeHookToEvent`), 터미널에 넣던 riven 환경과 zsh shim, `pty:codexSessionTitle`(`codexSessions.ts`)을 Rust `services/mcp`로 옮겼다. `tauri/build.mjs`의 `MOVED`에 `mcpServer`, `agentHooks`를 더했다.

구조:

- **서버:** 루프백 HTTP/1.1을 직접 구현했다(`services/mcp/http.rs`, 연결마다 스레드). `rmcp` + axum을 쓰지 않은 이유: Node 판도 JSON 응답만 하는 수제 구현이었고(SSE 없음, 도구만 있는 서버라 필요 없음), 이 프로세스에는 hyper가 아직 없다. rmcp의 streamable-http 서버는 axum, hyper, tower, SSE를 끌고 오는데 쓰는 메서드는 6개(initialize, ping, tools/list, tools/call, notifications/cancelled, DELETE)뿐이고, 세션 처리 방식(실행 동안 Mcp-Session-Id 하나, 알림은 202, 취소된 호출은 문장으로 답함)도 지금 에이전트가 보는 것과 달라진다.
- **같은 프로토콜:** 경로(`/mcp`, `/hook`), 인증(Bearer 또는 `?token=`, 실행마다 새 UUID), 상태 코드(401, 404, 405 + `allow`, 400 parse error, 202, 204, 413(1MB), 100 Continue), 응답 본문, `Mcp-Session-Id`, 30분 대기(`REQUEST_TIMEOUT_MS`), `MCP_TOOL_TIMEOUT`, 서버별 `timeout`, 환경 변수 이름(`RIVEN_PANE`, `RIVEN_HOOK_URL`, `RIVEN_HOOK_TOKEN`, `RIVEN_HOOKS_SETTINGS`, `RIVEN_MCP_CONFIG`, `RIVEN_MCP_PROMPT`, `RIVEN_MCP_TOKEN`, `RIVEN_CODEX_ARGS`, `RIVEN_REAL_CLAUDE`, `RIVEN_REAL_CODEX`, `ZDOTDIR`)가 그대로다. Node의 timeout도 같다(요청 중 무제한, 헤더 60초, keep-alive 65초).
- **도구 목록과 안내 프롬프트는 한 곳:** `src/main/mcpServer.ts`가 계속 원본이다(Electron이 그대로 씀). `tauri/build.mjs`가 그 모듈을 묶어 실행해서 `src-tauri/src/services/mcp/catalog.json`(ASCII 이스케이프)을 만들고, Rust가 `include_str!`로 읽는다. 바뀔 때만 쓰고, 커밋해 둬서 `cargo build`만 해도 된다. 그래서 두 빌드의 도구 이름, 스키마, 설명, 프롬프트가 어긋날 수 없다. 이를 위해 `mcpServer.ts`에서 `PROMPT_LINES`, `PROMPT_HEAD`를 export하고, `runApiRequest`를 `src/main/apiRequest.ts`로 뺐다(동작 변경 없음).
- **도구 호출:** Rust가 화면에 `mcp:invoke`를 보내고 `mcp:result`(Rust 명령 `mcp_result`)를 기다린다. 받을 페이지는 App.tsx가 `mcp:invoke`를 듣기 시작할 때 preload 셰임이 알려 준다(`mcp_attach`, Electron의 `setAppWindow` 대신). 에이전트가 끊으면(소켓 닫힘 확인) 또는 `notifications/cancelled`가 오면 화면에 `mcp:cancel`을 보내고 "riven: the caller cancelled this request"로 답한다. 그 페이지가 다시 로드되기 시작하면(`on_page_load` Started) 기다리던 호출을 모두 "riven: the app reloaded ..."로 끝낸다(Electron의 did-start-navigation).
- **훅:** `/hook`이 PreToolUse/PostToolUse의 파일 기준본을 204 전에 읽고(EditTracker), 바뀐 파일은 Rust가 `agent:fileEdit`로 모든 앱 페이지에 보낸다. 나머지 훅은 204를 먼저 보낸 뒤 `services::pty::hook`을 직접 부른다. `RIVEN_HOOK_DEBUG=1` 로그도 같다.
- **설정 파일:** `userData/hooks/claude-settings.json`과 `userData/zdotdir/.zshenv`, `.zprofile`, `.zshrc`를 시작할 때 쓴다. Node 판이 쓴 파일과 바이트 단위로 같다(확인).

없앤 다리 (2, 3단계가 남긴 것):

- `ptyEnv` / `pty.env`: 터미널 환경은 `services::mcp::pty_env`를 직접 부른다.
- `pty.hook`: 훅 라우트가 Rust라 중계가 없다.
- `ptyAgents`, `chatRunning`: 바뀔 때마다 Node로 밀던 수를 없애고, 종료 확인이 필요할 때 Node가 동기 호출(`pty.working`, `chat.running`)로 묻는다.
- `chatEnv` / `chat.env`: 채팅 패널의 MCP 설정, 프롬프트, 훅 환경은 `services::mcp::chat_env`가 바로 준다(8초 대기 없음).
- `chatEdit`: Codex 패널의 파일 변경도 Rust가 바로 `agent:fileEdit`로 보낸다.

새로 생긴 다리 (엔진이 아직 Node인 도구, 해당 단계에서 지운다):

- `riven_db_*`(6단계 DB)와 `riven_api_request`(7단계 API 클라이언트): Rust가 제어 회선으로 `mcpTool`을 보내고 Node(`tauri/shim/moved/mcpServer.ts`, 46줄)가 실행해 `mcp.toolResult`로 답한다. `riven_db_execute`의 확인은 Node가 `mcp.ask`로 Rust에 부탁하고, Rust가 호출한 패널에 ask_user 카드를 띄운다. 에이전트가 끊으면 이 확인도 같이 취소된다.

실앱에서 확인한 것(백그라운드 모드, 개발 빌드, 앞 앱이 바뀌지 않음):

- 같은 입력으로 3단계 빌드(Node 서버)와 비교: 터미널 셸 환경 전체(`env -0`, 포트와 토큰만 다름), `typeset -f claude codex`, zsh shim 3개 파일, 훅 설정 파일, Claude 채팅 패널의 argv와 환경, Codex 패널의 argv와 환경이 모두 같았다. 프로토콜 16가지 요청(인증 없음, 틀린 토큰, 없는 경로, GET, DELETE, parse error, 알림, initialize 2가지, ping, 없는 메서드, tools/list 전체 14,518바이트, tools/list 좁힘, 없는 도구, pane 없는 훅, 1.1MB 본문)의 상태와 본문이 같았다(헤더 순서와 빈 응답의 `content-length: 0`만 다름).
- 채팅 패널의 Claude(haiku)가 riven_panels, riven_note_write, riven_note_read, riven_open_file, riven_browser_state, riven_ask_agent(다른 채팅 패널 P4B, "[P4B] PONG")를 차례로 호출하고 결과를 받음.
- 터미널에서 친 `claude -p`(zsh shim 경유)가 riven_panels를 호출하고 Edit을 함: 훅 왕복으로 `pty:agentSession`(세션 id, SessionEnd에서 null), `pty:status`(busy -> finished), `agent:fileEdit`(before/after), `pty:done`, `pty:reply`가 화면에 옴.
- Codex 채팅 패널(gpt-5.6-luna)이 URL과 토큰으로 riven MCP에 붙어 riven_panels를 호출(rollout에 기록). `gpt-5.5`는 ChatGPT 계정에서 지원하지 않는다는 Codex 오류였다(riven과 무관).
- 틀린 토큰(헤더, `?token=`) 401. riven_api_request와 riven_db_connections가 Node 다리로 동작.
- 취소 세 가지: 에이전트가 끊음(화면에 `mcp:cancel`), `notifications/cancelled`(같은 문장으로 답함), 기다리는 중 페이지 새로고침(재로드 문장, 로그 "[mcp] dropped 1 tool call(s)"). 새로고침 뒤 다시 붙어서 도구 호출이 됨.
- 종료 확인의 수: 채팅 턴과 터미널 에이전트가 일하는 동안 `chat 1, terminal 1`, 끝나면 0. 대화상자는 띄우지 않고 index.ts가 부르는 같은 함수를 시험 훅(`op=busy`, `tauri/shim/server.ts`)으로 읽었다.
- `pty:codexSessionTitle`: 최근 Codex rollout 40개에서 Node 판과 결과가 모두 같음.

추론만 한 것: `riven_db_execute`의 확인 경로(`mcp.ask`, DB 연결이 없어 실행 못 함), 30분 시간 초과, 터미널에서 친 `codex`(환경 변수가 Node 판과 바이트 단위로 같은 것만 확인), Codex 패널의 apply_patch 파일 변경이 타임라인으로 가는 것(같은 `report_edit`을 쓰는 훅 경로만 확인), WebContent 프로세스가 죽었을 때(Electron의 render-process-gone에 해당하는 Tauri 이벤트가 없어 처리하지 않음, 페이지가 다시 로드되면 위 경로로 끝남), 릴리스 빌드.

측정 (개발 빌드, 빈 상태, 실행 45초 후, footprint):

| | 3단계 | 4단계 |
|---|---|---|
| riven-tauri | 55MB | 56MB |
| Node | 177MB | 175MB |

MCP 서버는 원래 작아서 메모리 차이는 측정 오차 수준이다. 쉴 때 CPU는 둘 다 0.0%.

남은 Node 코드 (`src/main`, 테스트 제외, Tauri 빌드의 Node 번들에 들어가는 것):

| | 줄 수 |
|---|---|
| 3단계 후 | 17,126 (소스맵 기준 14,827) |
| 4단계 후 | 15,477 (소스맵 기준 13,178). mcpServer 931 + agentHooks 198 + agents 105 + agentEdits 142 + terminal/activity 139 + codexSessions 159 제외, apiRequest 25 추가 |

`tauri/shim/moved`의 다리 코드는 pty.ts 186 + agentChat.ts 85 = 271줄에서 89줄이 됐다(pty 18, agentChat 18, agentHooks 7, mcpServer 46). Rust 쪽은 `services/mcp` 1,331줄 + `commands/mcp.rs` 16줄이 늘었다.

다음 단계가 알아야 할 것:

- **도구 목록을 바꿀 때:** `src/main/mcpServer.ts`만 고치고 `node tauri/build.mjs`를 돌리면 `catalog.json`이 바뀐다. Rust에 도구 이름을 따로 적지 않는다. 화면이 수행하는 도구는 Rust가 이름만 보고 넘기므로 새 도구도 Rust 변경이 필요 없다(Node 엔진 도구만 `services::mcp::call_tool`의 분기).
- **6단계(DB)와 7단계(API 클라이언트):** 엔진을 Rust로 옮기면 `call_tool`의 `node_call` 분기와 `mcp.ask`, `mcp.toolResult`, `tauri/shim/moved/mcpServer.ts`를 지운다. DB 확인은 `page_call("ask_user", ...)`에 부모 호출 id를 넘기면 취소가 같이 된다.
- **8단계:** 종료 확인(index.ts의 before-quit)을 Rust로 옮기면 `pty.working`, `chat.running` 동기 호출도 없어진다. `mcp_attach`는 페이지를 Tauri가 직접 주게 돼도 그대로 쓸 수 있다.
- **시험할 때:** 이 환경의 셸에는 사용자의 실제 riven이 넣은 `RIVEN_*`, `MCP_TOOL_TIMEOUT`, `ZDOTDIR`, `CLAUDE_CODE_*`가 있다. 그대로 시험 앱을 띄우면 그 값이 자식에게 새어 들어가 훅이 사용자의 riven으로 갈 수 있으니, 띄우기 전에 지운다.

### 5단계 (2026-11-13): git, GitHub PR

`src/main/git.ts`, `githubPr.ts`, `githubPrDetail.ts`, `githubPrReview.ts`를 Rust `services/git`(`mod.rs` 실행 도우미와 `git:watch`, `repo.rs` git, `github.rs` gh)으로 옮겼다. 명령은 `commands/git.rs`. 1단계에서 bridge.ts에 남아 번들에 들어가던 작업 공간 감시(`watch:start`, `watch:stop`)는 `src/main/watch.ts`로 떼어 내고(Electron 동작 그대로, bridge.ts가 등록) Tauri 빌드에서 뺐다. `tauri/build.mjs`의 `MOVED`에 `git`, `githubPr`, `githubPrDetail`, `githubPrReview`, `watch`를 더했다.

Rust로 옮긴 채널 (invoke 31개, 이벤트 1개):

- git: `git:info`, `repos`, `log`, `showFile`, `blame`, `status`, `push`, `pull`, `discard`, `stage`, `unstage`, `stageAll`, `commit`, `branches`, `checkout`, `createBranch`, `fetch`, `stash`, `stashPop`, `stashList`, `watch`, 이벤트 `git:changed`(마지막으로 `git:watch`를 부른 페이지로)
- gh: `gh:prs`, `newPrDraft`, `createPr`, `pushBranch`, `createWeb`, `prDetail`, `prFile`, `submitReview`, `replyThread`, `resolveThread`

구조:

- **같은 명령줄:** git과 gh의 인자, 순서, 시간 제한(gh 목록 20초, 상세 30초, PR 만들기 60초, push 120초, 초안의 git 10초), 출력 한도(Node `execFile` 기본 1MB, status 10MB, showFile 20MB, blame 50MB, gh 16MB/64MB)가 Node 판과 같다. `services/git::exec`가 `execFile`의 실패 규칙(0이 아닌 종료, 시간 초과 SIGTERM, 한도 초과)과 메시지(`Command failed: <cmd>\n<stderr>`, `spawn git ENOENT`, `stdout maxBuffer length exceeded`)를 그대로 만든다. 화면에 가는 오류 문자열이 이 메시지이기 때문이다. 본문을 stdin으로 주는 gh 호출(PR 만들기, 리뷰, 답글, 해결)은 `spawn_io`(SIGKILL, `\ntimed out`)로 Node의 spawn 도우미와 같다.
- **인증:** 예전과 같이 gh CLI의 로그인을 쓴다. riven은 토큰을 갖지 않는다. gh는 로그인 셸 PATH에서 찾고(`resolveBin`과 같은 X_OK 검사), 자식 환경도 로그인 PATH다. 사용자의 gh 래퍼(`~/.local/bin/gh`, PWD로 계정 선택)가 그대로 적용된다: 모든 gh 호출의 cwd가 그 저장소다. 시험에서 hs-playground 아래 저장소의 `api user`가 `wassupss`로 답했다. 뷰어 로그인은 Node처럼 처음 물은 저장소의 답을 앱이 끝날 때까지 캐시한다(래퍼가 디렉터리마다 다른 계정을 주는 환경에서는 원래부터 부정확한 동작, 그대로 둠).
- **git:status 공유:** 같은 폴더에 대한 요청은 진행 중이거나 300ms 안에 끝난 결과 하나를 같이 받고, riven이 저장소를 바꾸면(stage, commit, checkout 등, 시작과 끝에 세대 증가) 그 전 결과는 쓰지 않는다(Node와 같은 규칙, `tokio::sync::OnceCell`).
- **git:watch:** `.git` 폴더를 재귀 없이 감시하고 `HEAD`, `ORIG_HEAD`, `index`가 바뀌면 `git:changed`를 보낸다. 앱에 하나, 새 호출이 이전 감시를 대신한다. `.git`이 파일인 워크트리는 Node(`fs.watch`가 파일 이름만 알려 줘서 이벤트가 오지 않음)처럼 감시하지 않는다.
- **느슨한 인자:** 화면 인자는 JSON 값으로 받아 Node 처리기처럼 읽는다(`??`, 참거짓, `String()`, `Number.isInteger`). 예: `gh:prDetail`에 문자열 `'5'`를 주면 거부가 아니라 `bad pr number`.

Node 판과 다른 점:

- git 자식의 PATH가 로그인 셸 PATH다(Node는 Node 자신의 PATH로 `git`을 찾았다). 이 컴퓨터에서는 둘 다 `/opt/homebrew/bin/git`.
- `execFile`의 stdin은 열린 채 아무것도 쓰지 않는 파이프였고, Rust는 `/dev/null`이다. stdin을 읽는 git/gh 명령은 Node에서 시간 초과까지 멈췄고 Rust에서는 바로 EOF를 받는다(실제 호출하는 명령 중 stdin을 읽는 것은 없다).
- `git:log`의 `limit`에 `null`을 주면 Node는 `-nnull`(실패, 빈 목록), Rust는 200이다(Tauri가 null을 없는 값으로 읽는다). 화면은 항상 숫자를 준다.

원래부터 있던 문제 (같게 옮김, 고치지 않음):

- `git:stashList`의 `--format=%gd%00%s`에서 `git stash list`는 `%00`을 NUL로 바꾸지 않는다(`%x00`이어야 함). 그래서 `ref`가 `stash@{0}%00On main: ...` 전체이고 `subject`가 없다. 시험에서 Node와 Rust 모두 이렇게 나왔다.
- 추적하지 않는 폴더(`git status`가 `dir/`로 보여 줌)의 `git:discard`는 아무것도 지우지 않고 `{ok:true}`다(Node `fs.rm`이 recursive 없이 폴더를 거부).

같은 입력으로 비교 (원래 모듈 4개를 electron 대역으로 묶어 Node로 실행한 결과 vs 실앱 화면의 `window.api` -> preload 셰임 -> Rust, 백그라운드 모드 개발 빌드, 시험 훅 eval):

- **읽기 59건** (riven-tauri 워크트리, riven, hs-playground 컨테이너, 저장소 아닌 폴더, 없는 경로, 공개 저장소 cli/cli를 origin으로 둔 빈 저장소): info 7, repos 4, log 4, status 5, branches/stashList 5, showFile 4, blame 5(수정 중인 파일, 추적 안 된 파일의 오류, 다른 저장소의 파일, 없는 경로), gh:prs 8(open/closed/all, 저장소 아님 -> `no-remote`, 공개 저장소, 잘못된 state), newPrDraft 4, prDetail 8(riven #244/#241, 잘못된 번호 2, 없는 PR, cli/cli #14717/#14952의 리뷰 스레드 7개와 대화), prFile 5(한글 경로 인코딩 포함). 56건이 JSON 바이트 단위로 같고, 3건은 `git log`의 상대 시간("50 minutes ago"/"51 minutes ago")만 달랐다(두 실행 사이에 분이 넘어감). 두 실행이 부른 gh 명령(인자, cwd) 41건도 같았다(PR 파일 양쪽을 동시에 받는 두 호출의 순서와 Rust 쪽의 캐시된 `api user`만 다름).
- **쓰기 63건** (스크래치 저장소, 원격은 로컬 bare 저장소): stage/unstage/stageAll/commit(한글, 따옴표, 백틱, 여러 줄)/빈 커밋 오류, 브랜치 만들기(중복 오류)/checkout(없는 브랜치 오류), stash(메시지 있음/없음)/stashList/stashPop, discard(추적 파일, 추적 안 된 파일, 추적 안 된 폴더, untracked=null), upstream 없는 push 오류, `gh:pushBranch`(로컬 bare로, 잘못된 이름 2가지), 다른 클론이 push한 뒤 fetch/status(behind 1)/pull. 매 단계 `git:status`로 상태 공유가 변경 직후 옛 결과를 주지 않는 것도 확인. 결과는 해시와 시각(blame time, 상대 시간)을 가리면 모두 같고, 끝난 뒤 저장소 상태(커밋, 브랜치, upstream, stash, 작업 트리 파일 내용)도 같았다.
- **gh 쓰기:** 실제 GitHub에 쓰지 않으려고 시험용 `$SHELL`이 로그인 PATH 앞에 기록용 `gh`를 두었다. 읽기는 사용자의 gh 래퍼로 넘기고, 쓰기(`pr create`, `api --method POST`, `api graphql --input -`)는 인자, cwd, stdin을 기록하고 정해진 답을 준다. 대상 저장소도 쓰기 권한이 없는 cli/cli다. createPr 4가지(공백 정리, base, draft, 제목 없음, push 필요 오류 -> `needsPush:true`), createWeb, submitReview 7가지(여러 줄 코멘트의 `start_line`/`start_side`, APPROVE 빈 본문, 보낼 것 없음, 잘못된 event/번호, GitHub 오류, GitHub 아닌 원격), replyThread 3가지, resolveThread 3가지. 결과와 gh에 간 stdin(JSON 페이로드)이 바이트 단위로 같았다.
- **git:watch:** 같은 단계(stage, 브랜치 전환, 작업 파일만 수정, 워크트리로 감시 교체 후 이전 저장소 변경)에서 `git:changed` 수가 Node 2/6/6/0, Rust 2/6/6/0으로 같았다.
- **화면:** 상태 줄의 브랜치(`feat/tauri-port`), 워크스페이스 카드의 브랜치와 변경 수(`±15`), 탐색기의 `git-modified` 표시가 Rust 결과로 그려졌다. 실제 로그인 셸(기록용 gh 없이)로 다시 띄워 `gh:prs`가 사용자의 gh 래퍼로 동작하는 것도 확인(login `wassupss`).

추론만 한 것: 실제 GitHub로 가는 쓰기(PR 만들기, 리뷰, 답글, 해결. 기록용 gh에서 멈춤), `gh pr create --web`이 브라우저를 여는 것(창을 띄우면 안 돼서 기록만), 시간 초과와 출력 한도 초과 경로(코드만 맞춤), 50개 넘는 리뷰 스레드나 100개 넘는 파일의 페이지 나눔(해당 PR을 찾지 못함. `parse_graphql_pages`, `flatten_pages`는 단위 시험), 원격이 있는 실제 저장소로의 push/pull(로컬 bare로만), Electron 빌드의 `watch.ts` 분리(타입 검사와 기존 테스트만).

측정 (개발 빌드, 시험 뒤 유휴): riven-tauri footprint 63MB, CPU 0.0%. 읽기 59건 전체가 Rust 29.6초, Node 28.1초로 같은 수준이다(대부분 gh의 네트워크 시간). 첫 실행에서 3분이 걸린 적이 있는데 gh의 cli/cli GraphQL 호출이 네트워크에서 늦었던 것으로, 같은 호출을 다시 재면 2.7초였다.

남은 Node 코드 (`src/main`, 테스트 제외, Tauri 빌드의 Node 번들에 들어가는 것):

| | 줄 수 |
|---|---|
| 4단계 후 | 15,477 (소스맵 기준 13,178) |
| 5단계 후 | 13,962 (git 418 + githubPr 457 + githubPrDetail 408 + githubPrReview 173 + bridge.ts에서 뺀 감시 59 제외). 소스맵 기준 11,720 |

소스맵 기준은 이번에 같은 방법으로 4단계 커밋을 다시 묶어 세면 13,239였다(문서의 13,178과 세는 방법이 조금 다름). 그 기준으로 1,519줄이 줄었다. Rust 쪽은 `services/git` 1,649줄(단위 시험 포함) + `commands/git.rs` 180줄이 늘었다. `tauri/shim/moved`에 4줄짜리 빈 모듈 5개가 늘었다.

다음 단계가 알아야 할 것:

- **gh를 시험할 때:** 실제 GitHub에 쓰지 말 것. 이번처럼 시험용 `$SHELL`로 로그인 PATH 앞에 기록용 gh를 두면 앱과 Node 대역 둘 다 같은 gh를 쓴다(앱은 시작할 때 `$SHELL -lic`로 PATH를 읽는다). `execFile`처럼 stdin을 열어 두는 쪽과 닫는 쪽이 있으니 기록용 gh는 쓰기 명령에서만 stdin을 읽어야 한다(`--web`에서 읽으면 Node 쪽이 30초 시간 초과로 멈춘다).
- **`services/git::exec`:** 다른 그룹이 CLI를 `execFile`처럼 부를 때 그대로 쓸 수 있다(오류 메시지, 시간 제한, 출력 한도가 Node와 같음).
- **원래부터 있던 문제 두 가지**(위)를 고칠 때는 Electron 쪽 `git.ts`도 같이 고친다.

### 6단계 (2026-11-13): DB

`src/main/db/*`(engine, store, pg/mysql/sqlite 드라이버와 메타데이터, 내보내기, CSV 가져오기, 백업/복원, sqlite 워커)를 Rust `services/db`로 옮겼다. 명령은 `commands/db.rs`(채널마다 하나씩 52개). `tauri/build.mjs`의 `MOVED`에 `db/engine`을 더했고(`tauri/shim/moved/db/engine.ts`는 빈 `registerDbHandlers`), Node 번들에서 sqlite 워커 진입점을 뺐다. MCP의 DB 다리(Rust가 `mcpTool`로 Node에 넘기고 Node가 `mcp.ask`로 확인 카드를 되묻던 길)를 없앴다. `riven_db_*`는 Rust `services/mcp::db_call`이 엔진을 바로 부르고, 확인 카드는 다른 도구처럼 `page_call("ask_user")`로 연다. `riven_api_request`만 Node(`node_call`)에 남았다. `main.rs`의 `mcp.ask` 처리도 지웠다.

Rust로 옮긴 채널 (invoke 52개, 이벤트 4개): `db:list`, `save`, `delete`, `test`, `sqlite-pick`, `databases`, `schemas`, `objects`, `table`, `column`, `editTarget`, `ddl`, `ddl-apply`, `apply`, `query`, `cancel`, `session-commit`/`rollback`/`status`/`close`, `roles`, `privileges`, `default-acl`, `rls`, `role-grants`, `completion-meta`, `erd`, `schema-snapshot`, `mon-overview`/`sessions`/`locks`/`tables`/`indexes`/`settings`/`signal`/`reload`, `search-tables`/`run`/`cancel`, `export`, `save-text`, `import-pick`/`preview`/`run`/`cancel`, `backup-tools`/`server`/`run`/`cancel`, `restore-pick`/`inspect`/`run` (`engine.rs`의 `CHANNELS` 표가 인자 이름까지 담은 전체 목록). 이벤트 `db:search-progress`, `db:import-progress`, `db:backup-progress`, `db:export-progress`.

구조:

- **드라이버를 직접 구현:** 화면이 받는 값이 Node 드라이버(node-postgres, mysql2)의 텍스트 변환 결과라서, 그 변환을 바이트 단위로 맞추려고 pg 와이어(`pgwire.rs`, `postgres-protocol`로 SCRAM/메시지만 씀)와 MySQL 와이어(`mywire.rs`, native/caching_sha2/RSA, TLS)를 직접 구현했다. 값 변환은 `pg.rs`/`my.rs`(Node의 type parser 규칙), 숫자를 JS 문자열로 찍는 것은 `js.rs`(`ryu-js`). SQLite는 `libsqlite3-sys`(bundled)로 핸들마다 스레드 하나(`sl.rs` 워커, Node의 worker_threads 자리). 풀은 연결당 4개, 5분 유휴 종료, 수동 커밋 세션은 10분 유휴 종료로 Node와 같다.
- **취소:** pg는 cancel 요청, MySQL은 `KILL QUERY`, SQLite는 `sqlite3_interrupt` 뒤 핸들을 닫는다. 취소 이유("cancelled", "timeout")가 있으면 SQLite의 "interrupted" 대신 그 이유를 돌려준다(Node와 같은 메시지).
- **인자 그대로 읽기:** 명령이 invoke 본문 JSON을 직접 읽어서 화면이 뺀 인자(undefined)와 `null`을 구분한다. `db:save`는 비밀번호가 undefined면 저장된 것을 두고 `null`이면 지운다(Node와 같음). 5단계의 `git:log` null 문제 같은 차이가 DB에는 없다.
- **저장소:** 연결 목록과 비밀번호를 Node와 같은 파일, 같은 형식(`db/connections.json`, 비밀번호는 `riven-tauri Safe Storage` 키체인 키로 암호화, Node 판이 Electron safeStorage와 맞춘 형식)에 둔다. 비밀 항목 삭제가 순서를 바꾸지 않게 `shift_remove`.
- **백업 도구:** `pg_dump`/`pg_restore`/`mysqldump` 등을 로그인 PATH와 Homebrew, libpq, Postgres.app 경로에서 찾고, 자식 환경은 비우고(`PG*` 변수 없음) 로그인 PATH와 도구용 변수만 준다(Node와 같은 규칙). 진행 목록(TOC) 파싱의 키 순서도 Node와 같다.
- **XLSX:** zip을 직접 만든다(`flate2` deflate + `crc32fast`). 시트 XML은 Node와 같다.
- **대화 상자:** `tauri_plugin_dialog`. Electron의 "모든 파일"(`*`) 필터는 macOS 패널에 없어서 그 필터가 있으면 필터를 걸지 않는다. 개발용 훅 `RIVEN_DEV_SQLITE_FILE`, `RIVEN_DEV_PICK_FILE`, `RIVEN_DEV_SAVE_FILE`을 지킨다(아래 차이 참고).
- **시험 하네스:** 디버그 빌드에서 `RIVEN_DB_HARNESS=1`이면 바이너리가 창 없이 stdin의 JSON 줄(`{ch,args,env}` 또는 `{tool,args,answer}`)을 엔진에 넘기고 결과와 이벤트를 stdout에 쓴다(`services/db/harness.rs`, 릴리스 빌드에는 없음). Node 쪽은 원래 모듈을 electron 대역으로 묶어 같은 줄 형식으로 돌렸다.

Node 판과 다른 점:

- **pg 시작 매개변수:** node-postgres는 항상 `client_encoding=UTF8`을 보낸다. 처음에는 빠뜨려서 서버 설정 화면 비교에서 차이가 났고, 같게 넣었다.
- **SQLite 버전:** Node 내장 3.53.4, Rust bundled 3.54.1. `db:test` 문구("SQLite 3.54.1")만 다르다.
- **SQLite 세션 취소 뒤 잠금:** Node는 취소된 워커가 잠금을 쥔 채 남아 다음 쓰기가 "database is locked"였다. Rust는 핸들을 닫아서 잠금이 풀린다(의도한 동작이라 맞추지 않음).
- **쓸 수 없는 경로로 내보내기:** Node는 쓰기 스트림이 `drain`을 영원히 기다려 응답이 오지 않았다. Rust는 `ENOENT: no such file or directory, open '<경로>'`를 돌려준다.
- **XLSX 압축:** 시트와 부품 파일은 같고 zip 컨테이너만 다르다(Node zlib vs Rust miniz, 파일이 약 4% 큼). 엑셀/Numbers에서 같은 내용.
- **개발 훅:** Node는 `RIVEN_DEV_SAVE_FILE`을 `backup-run`에만 썼고 Rust는 `export`, `save-text`에도 쓴다(대화 상자 없이 시험하려고). 실사용에는 영향 없음.

같은 입력으로 비교 (원래 Node 모듈 vs Rust 하네스, Docker의 임시 PostgreSQL 16 / MySQL 8 / MariaDB와 스크래치 sqlite 파일만 사용):

| 묶음 | 호출 | 다른 것 |
|---|---|---|
| 기본(저장, 목록, 연결 시험, 비밀번호 유지/삭제) | 34 | SQLite 버전 문구 2건 |
| pg(타입 전부, 스키마/객체/컬럼/DDL, 편집 적용, 세션, 취소, 시간대/격리/시작 스크립트, 읽기 전용 거부) | 107 | 0 |
| mysql | 105 | InnoDB 행 수 추정치 1건(서버가 매번 다름) |
| mariadb | 105 | 0 |
| sqlite | 101 | 세션 취소 뒤 잠금 2건(위 차이) |
| MCP 도구 결과 텍스트 | 6 | 0 |
| 기타(검색, 내보내기, 가져오기, 백업/복원, 대화 상자 훅, 없는 채널) | 147 | 비결정적인 것만: 새 테이블 oid, 검색 진행 이벤트 순서(순서 무시하면 같음), 병렬 덤프 진행 순서, 쓸 수 없는 경로 내보내기(Node 멈춤) |

- 내보내기 파일 csv/tsv/json/sql/svg는 바이트 단위로 같다(pg 15만 행, sqlite 10만 행 포함). 가져오기는 UTF-8 BOM, EUC-KR, UTF-16LE, 건너뛰기 모드, 6만 행이 같다(결과 테이블 md5 비교). 백업은 plain/custom/directory/tar와 inspect, 복원(pg_restore의 `transaction_timeout` 무시 처리 포함)이 같다.
- **화면 경로:** 같은 시나리오를 실앱 `window.api` -> preload 셰임 -> Tauri -> Rust로 다시 돌렸다(백그라운드 모드 개발 빌드, 시험 훅 eval). 위 표와 같은 차이 외에는 같았다. 화면 경로에서 뺀 것: MCP 도구 호출(아래 따로 시험), 저장 경로가 앱 환경으로 고정되어 백업 형식은 plain만, 대화 상자 훅 경로가 앱 환경 값인 것, `window.electron`이 없어서 "없는 채널" 호출.
- **MCP:** 실앱의 MCP 서버에 HTTP로 `riven_db_connections`/`browse`/`describe`/`query`(읽기 전용 거부 포함)를 불렀다. `riven_db_execute`는 (1) 채팅 패널이 아닌 pane에서 "needs the user to confirm in a riven chat pane" 거부, (2) 채팅 패널 pane에서 확인 카드가 Node와 같은 문구(`PG local / rt_run 에 아래 SQL 2개를 한 트랜잭션으로 실행할까요?`, WHERE 없는 DELETE 경고)로 떠서 "실행"을 누르면 `committed: 1. UPDATE 1 2. DELETE 0`, (3) "취소"면 `not executed: the user did not approve (취소).`, (4) 클라이언트가 끊으면 카드가 만료 상태로 바뀌는 것까지 확인했다. 채팅 패널은 CLI를 띄우지 않으려고 시험 중에만 화면의 `chat.start`를 빈 함수로 바꿔 열었다.

메모리 (개발 빌드, 10만 행 결과, pg `select * from public.big` 20만 행 중 한도 10만):

- 엔진만(하네스): Rust 12번 반복 후 52MB에서 멈춤, 유휴 10초 45MB. 같은 일을 Node 엔진은 335MB(반복마다 늘어 유휴 뒤에도 그대로).
- 실앱: 쿼리 한 번 545ms 안팎. 그런데 riven-tauri footprint가 호출마다 약 13MB씩 늘고 줄지 않았다(102MB -> 12번 뒤 355MB). DB 엔진 문제가 아니다: 1단계부터 있던 `workspace:readFile`로 12MB 파일을 읽어도 호출마다 약 23MB씩 같은 모양으로 늘었다. 늘어난 몫은 "Owned physical footprint (unmapped)"와 MALLOC_LARGE에 있다. Tauri IPC 응답(큰 invoke 결과를 WKWebView로 넘기는 길)이 응답 바이트를 놓지 않는 것으로 보인다. 큰 결과를 자주 받는 DB 패널에서 바로 드러나므로 다음 단계 전에 따로 조사해야 한다(시험은 숨긴 창이었고 eval 훅을 WKWebView 직접 실행으로 바꾼 상태였으니 보이는 창에서도 재현되는지부터).
- 20만 행 CSV 내보내기: 680ms, 내보내는 동안 footprint가 늘지 않았다(스트리밍).

추론만 한 것: TLS 연결(pg `sslmode`, MySQL TLS, 코드는 `native-tls`로 맞춤, 시험 DB는 TLS 없음), MySQL 8의 RSA 공개키 교환 경로(caching_sha2 캐시가 비어 있을 때, 시험에서는 캐시된 빠른 경로만), MariaDB 외 다른 서버 버전, Windows/리눅스의 백업 도구 위치, 실제 macOS 파일 대화 상자(창을 띄우면 안 되어 개발 훅으로만), 사용자 키체인의 기존 비밀번호 복호화(시험은 별도 키체인 파일).

시험 중 사고: 화면 경로 시험에서 `db:sqlite-pick`이 개발 훅 없이(훅 변수를 시험 스크립트에만 주고 앱 환경에 안 줌) 실제 macOS 파일 대화 상자를 열어서 시험 앱이 약 8초(15:26:37~15:26:44) 맨 앞 앱이 되었다. 그 뒤 실행 스크립트에 훅 변수를 넣고, 시험 앱이 맨 앞이 되면 바로 죽이는 감시 스크립트(50ms 간격)를 붙였다. 이후에는 맨 앞에 온 적이 없다. 다음 단계도 대화 상자를 여는 채널은 반드시 개발 훅을 앱 환경에 주고 시험할 것.

남은 Node 코드 (`src/main`, 테스트 제외, Tauri 빌드의 Node 번들에 들어가는 것):

| | 줄 수 |
|---|---|
| 5단계 후 | 13,962 (소스맵 기준 11,720) |
| 6단계 후 | 4,461 (`src/main/db` 테스트 제외 9,501 제외). 소스맵 기준 4,491, 30개 파일 |

Rust 쪽은 `services/db` 10,985줄(단위 시험 포함) + `commands/db.rs` 328줄이 늘었다.

다음 단계가 알아야 할 것:

- **eval 훅이 멈출 때:** 백그라운드 모드에서 한동안 아무것도 안 하면 페이지 소켓 eval(`op=eval`)이 답하지 않는 일이 있었다(`document.visibilityState`가 hidden). 시험 중에만 빌드된 번들의 `executeJavaScript`가 `wv.exec`(WKWebView 직접 실행)를 쓰게 바꿔서 피했다. 다시 빌드하면 원래대로 돌아간다.
- **값 변환을 바꿀 때:** 화면과 MCP 결과가 Node 드라이버의 텍스트 변환에 맞춰져 있으니 `pg.rs`/`my.rs`/`js.rs`의 변환을 바꾸면 하네스 비교를 다시 돌릴 것.
- **IPC 메모리**(위)는 DB만의 일이 아니라 큰 invoke 결과 전부에 해당한다.

### 7단계 (2026-11-13): 큰 응답 메모리, 언어 서버, 디버거, 나머지 작은 기능

#### 7-1. 큰 invoke 응답 뒤 메모리가 돌아오지 않던 문제

6단계에서 본 현상(큰 결과를 받을 때마다 riven-tauri footprint가 약 12MB씩 늘어 남음)의 원인은 두 가지였다. 둘 다 고쳤다.

1. **invoke가 postMessage + eval로 돌고 있었다.** 페이지는 Node가 `http://127.0.0.1`로 주는데, 렌더러의 CSP(`src/renderer/index.html`, Electron용)의 `connect-src`에 `ipc:`가 없어서 WebKit이 Tauri의 `ipc://localhost/<명령>` fetch를 막았다. 그러면 Tauri는 postMessage로 바꾸고 결과를 스크립트 문자열로 페이지에 eval한다. 그 문자열이 "Owned physical footprint (unmapped)"로 이 프로세스 몫에 남았다(2단계 pty에서 본 것과 같은 현상). 고침: Tauri 빌드에서만 Node가 HTML을 줄 때 CSP에 `ipc: http://ipc.localhost`를 더한다(`tauri/shim/server.ts`). 실앱에서 fetch를 가로채 세어 보니 invoke 2건이 모두 `ipc://`로 갔고 postMessage는 0건이었다.
2. **macOS libmalloc의 큰 블록 realloc.** 1을 고친 뒤에도 같은 양이 이번에는 `MALLOC_LARGE`로 남았다. 응답을 WebSocket(2단계 pty 스트림)으로 보내 봐도 같았다. 그래서 IPC가 아니라 Rust 쪽 할당 문제로 좁혔다. 시험 명령으로 순수 Rust `Vec`을 12MB까지 늘렸다가 버리기만 해도 12번에 63MB -> 219MB가 됐다. 같은 크기를 한 번에 할당하면(늘리지 않음) 63MB -> 87MB에서 멈췄다. libmalloc은 큰 블록을 늘릴 때 페이지를 복사하지 않고 다시 매핑하는데(copy-on-write), 그 뒤 버린 옛 블록의 페이지가 몇 분 동안 footprint에 남는다(90초 뒤에야 일부가 돌아옴). JSON 결과를 `Vec`에 써 가는 직렬화, 파일을 `String`으로 읽기 등 커지는 버퍼는 모두 이 길을 탄다. 고침: `main.rs`의 전역 할당자가 시스템 할당자를 그대로 쓰되, 512KB 이상 realloc만 새로 할당 + 복사 + 해제로 한다. `malloc_zone_pressure_relief`로는 돌아오지 않았다(0바이트).

측정 (개발 빌드, 백그라운드 모드, 12MB 파일 `workspace:readFile`, riven-tauri footprint, `footprint`만 사용):

| | 1회 전 | 6회 | 12회 | 24회 | 유휴 뒤 |
|---|---|---|---|---|---|
| 고치기 전 (eval 경로) | 62MB | 152MB | 212MB(16회) | | 30초 뒤 188MB |
| CSP만 고침 (ipc:// 경로) | 63MB | 138MB | 223MB | | 26회 354MB, 90초 뒤 179MB |
| CSP + 할당자 | 64MB | 101MB | 102MB | 102MB | 20초 뒤 102MB |
| 할당자만 (eval 경로 그대로) | 63MB | 183MB | 211MB | | 211MB ("owned unmapped" 85MB) |

읽기 시간은 한 번에 330ms에서 278ms로 줄었다(eval 대신 fetch 본문). 큰 결과를 WebSocket으로 보내는 경로도 만들어 재 봤다. CSP와 할당자를 고친 상태에서 12회 102MB로 fetch 경로(111MB)와 거의 같아서, 경로를 하나 더 두지 않으려고 넣지 않았다.

시험 환경 고침:

- 백그라운드 모드 창은 모든 창 뒤에 있어서 WebKit이 가려진 페이지로 보고 타이머와 소켓 메시지를 늦췄다. 6단계에서 eval 훅이 답하지 않던 원인이 이것이다. 백그라운드 모드(`RIVEN_TAURI_BACKGROUND=1`)에서만 WKWebView의 `_windowOcclusionDetectionEnabled`를 끈다(`main.rs`의 `no_occlusion`). 이제 페이지가 보이는 창처럼 돌고(`visibilityState` visible), 위 측정도 보이는 창 기준이다. 평소 실행에는 영향이 없다.
- 시험 훅에 `op=wv`를 더했다. 페이지 소켓을 거치지 않고 WKWebView `callAsyncJavaScript`로 바로 eval한다. 식 하나를 받는다(async 함수는 IIFE로 감쌀 것).

추론만 한 것: DB 10만 행 결과(같은 직렬화와 같은 응답 경로라 같다고 본다. 시험 DB 연결 저장이 키체인을 건드릴 수 있어서 이번에는 돌리지 않음). WebContent 프로세스 쪽 메모리(시험 앱의 프로세스 트리에 없어서 PID로 좁힐 수 없어 재지 않음).

#### 7-2. 언어 서버, 디버거

`src/main/lsp.ts`, `debugger.ts`를 Rust `services/lsp.rs`, `services/debug.rs`로 옮겼다. 명령은 `commands/lsp.rs`, `commands/debug.rs`. `MOVED`에 `lsp`, `debugger`를 더했다.

Rust로 옮긴 채널 (invoke/send 14개, 이벤트 3개): `lsp:servers`, `start`, `request`, `notify`(send), `stopRoot`, 이벤트 `lsp:notify`, `lsp:stopped`. `debug:start`, `stop`, `continue`, `stepOver`, `stepInto`, `stepOut`, `setBreakpoints`, `getProperties`, `evaluate`, 이벤트 `debug:event`.

언어 서버:

- **설치된 것만 (4장 결정):** 서버마다 (1) 워크스페이스의 node_modules(위로 올라가며 찾음, Node `require`와 같은 방식)에 있으면 로그인 PATH의 `node`로 실행, (2) 없으면 서버 자체 명령을 로그인 PATH에서 찾는다. 둘 다 없으면 그 키는 `lsp:servers`에서 빠진다. 앱에 넣거나 내려받지 않는다. Electron은 지금처럼 앱에 묶인 서버를 쓴다(`src/main/lsp.ts` 그대로).
- **상태줄 안내:** 편집기에 연 파일의 언어 서버가 없으면 편집기 상태줄에 "gopls 언어 서버 없음"을 보이고, 마우스를 올리면 설치 명령을 보여 준다(`lsp/client.ts`의 `useLspMissing`, `LSP_INSTALL`, `EditorStatusBar.tsx`, i18n `lsp.missing`/`lsp.installHint`). 화면 공통 코드라 Electron에도 있다(Electron은 묶인 서버가 있어 PATH 전용 서버가 없을 때만 보임). 워크스페이스를 바꾸면 쓸 수 있는 서버 목록을 다시 받는다(워크스페이스 node_modules에 따라 달라지므로).
- **같은 동작:** initialize의 capabilities, 서버 요청 답(workspace/configuration은 항목마다 `{}`, applyEdit는 적용 안 함, 나머지 null), 초기화 전의 notify는 초기화 뒤 순서대로, 같은 키를 동시에 start하면 하나만 띄움(키마다 잠금), 다른 루트로 start하면 이전 서버를 끄고 새로 띄움, 마지막 문서를 닫고 10분 뒤 정지(`RIVEN_LSP_IDLE_STOP_MS`) + `lsp:stopped`, `stopRoot`, 앱 종료 시 shutdown/exit/kill.

디버거:

- 사용자의 `node`(로그인 PATH)를 `--inspect-brk=127.0.0.1:0`으로 띄우고(TypeScript는 `--experimental-strip-types`), stderr에서 `ws://` 주소를 읽어 CDP에 붙는다. WebSocket 클라이언트는 직접 구현했다(마스크한 텍스트 프레임, 조각 합치기). 이벤트 모양(started, paused {reason, frames, scopes}, resumed, output, terminated)과 값 문자열(`description`, 없으면 `String(value)`, JS 숫자 표기)이 Node 판과 같다.
- Node 판과 다른 점: (1) 디버그 중에 새로 시작하면 Node 판은 이전 자식의 exit 처리기가 늦게 와서 새 세션까지 지웠다(새 start가 영원히 답하지 않음, 비교 시험에서 재현). Rust는 세션 세대를 확인해서 이전 자식의 종료가 새 세션을 건드리지 않는다. (2) stop 때 Node 판은 `terminated`를 두 번 보냈고(stop + 죽은 자식의 exit) Rust는 한 번이다. (3) node가 주소를 출력하기 전에 끝나면 Node 판은 start가 답하지 않았고 Rust는 `{ok:false}`다. (4) node가 PATH에 없으면 `{ok:false, error}`로 알린다.

같은 입력으로 비교 (원래 모듈을 electron 대역으로 묶어 Node로 실행 vs 실앱 화면의 `window.api` -> preload 셰임 -> Rust, 백그라운드 모드 개발 빌드, `op=wv` eval):

- **언어 서버 15건:** servers, typescript start(capabilities 키 23개), hover, definition, documentSymbol, completion(`p.`), 없는 메서드 오류, 시작 안 한 서버 오류, pyright start, bash start와 hover, 없는 서버 start 오류, stopRoot(3), 파일별 마지막 진단(ts, pyright, bash), `lsp:stopped` 3건. 14건이 같았다. 다른 1건은 servers 목록에 Rust가 `rust`를 더 넣은 것으로, 시험 앱의 로그인 PATH에 `~/.cargo/bin/rust-analyzer`(rustup)가 있어서다(Node 대역은 다른 PATH로 실행). 처음엔 bash hover가 Node에서 null이었는데, 서버가 파일을 분석하기 전에 물은 시간 차이였다(1초 기다리면 같음).
- **워크스페이스에 node_modules가 없을 때:** `lsp:servers`가 `["clangd","rust"]`(PATH에 있는 것만), pyright start는 "LSP server pyright is not installed".
- **상태줄:** 워크트리에 임시 `.go` 파일을 만들어 탐색기에서 열자 편집기 상태줄에 "gopls 언어 서버 없음"과 설치 명령 툴팁이 떴고, `.ts` 파일로 바꾸자 사라졌다(화면 캡처로 확인).
- **디버거 30건:** 중단점 설정, start, Break on start, continue -> 중단점(add, 3행), 지역 변수 속성, evaluate(숫자, 객체, ReferenceError), stepOver/stepOut/stepInto 뒤 프레임, 중단점 비우기, 두 번째 반복, stop, 출력(console.log, stdout, stderr, console.error), 이벤트 순서, TypeScript 파일(strip types) 중단과 출력, 세션 없을 때 stop과 step. 출력은 stdout 조각 경계가 실행마다 달라 수준별로 이어 붙여 비교했고, 이벤트 순서에서 Node의 중복 terminated 하나는 뺐다. 30건 모두 같았다.
- **정리:** 시험 뒤 디버그 대상 node, 언어 서버 자식이 남지 않았다. 앱을 SIGTERM으로 끝낸 경우(Exit 이벤트 없음)도 typescript-language-server가 stdin EOF로 스스로 끝났다.

추론만 한 것: 10분 유휴 정지(같은 타이머 코드, 시간을 줄여 돌리지 않음), clangd/gopls/rust-analyzer/svelte 서버로 실제 편집(목록과 경로 찾기만), 서버가 죽었을 때 다음 요청이 "not started"인 것, 디버거 화면 패널(`DebugPanel`)을 눌러서 쓰는 흐름(같은 `window.api.debug`를 직접 불러 확인).

#### 7-3. 작은 기능: cli, ports, models, diagnostics, usage, API 클라이언트

Rust로 옮긴 채널 (invoke 9개):

- `cli:list`, `ports:list`, `ports:kill`, `models:claude`, `diagnostics:run` (`services/tools.rs`)
- `usage:today`, `usage:codex` (`services/usage.rs`)
- `api:request` (`services/http.rs`)
- MCP `riven_api_request`도 `services/http.rs`로 돈다. 4단계에서 남긴 마지막 Node 다리(`mcpTool` / `mcp.toolResult`, `node_call`, `try_emit`)를 지웠다. 이제 MCP 도구는 전부 Rust 아니면 화면에서 돈다.

`MOVED`에 `cli`, `ports`, `modelCatalog`, `diagnostics`, `usage`, `apiclient`를 더했다. `usage:limits`(Anthropic OAuth 사용량 API)는 Claude Code 토큰을 키체인에서 읽어야 해서 이번에는 Node에 남겼다. 그래서 `usage.ts`에서 그 처리를 `usageLimits()`로 떼어 export했다(Electron 동작은 같음). `tauri/shim/moved/usage.ts`가 그 채널 하나만 등록한다.

구조와 Node 판과 같게 맞춘 것:

- **실행 파일 찾기:** `tools::resolve_bin`은 Node `resolveBin`처럼 로그인 PATH에서 X_OK로 찾는다. 언어 서버와 디버거의 node 찾기도 이걸로 바꿨다(처음엔 `is_file`만 봤음).
- **ports:** `lsof -Fpcn` 두 번, 같은 파싱(pid별 포트를 처음 본 순서로), 워크스페이스 안 cwd만, 포트 순 정렬. kill은 새로 스캔한 목록에 그 pid가 있는지 확인하고, riven 자신(이제 Rust 프로세스)은 거부, SIGTERM 3초 뒤 SIGKILL, 오류 문구(`kill ESRCH` 등)도 같다.
- **models:claude:** 같은 인자로 claude CLI에 `initialize` 제어 요청만 보내고(턴 없음), 20초 제한, 설정 폴더마다 캐시, 실패는 캐시하지 않는다.
- **diagnostics:** 워크스페이스의 `node_modules/.bin/tsc`, `eslint`만 쓰고(5단계의 `git::exec`, execFile과 같은 오류와 버퍼 64MB), 같은 정규식과 로그 문구.
- **usage:** JS `Date`의 로컬 날짜 계산(ISO 파싱, `localtime_r`), 같은 순서의 f64 합(결과 숫자가 마지막 자리까지 같음), 파일마다 크기/시간/오프셋을 기억해 덧붙은 부분만 읽는 캐시, 메시지 id|요청 id 중복 제거, 비용 내림차순 안정 정렬. 정수는 `.0` 없이 낸다.
- **http (fetch 대신):** reqwest를 들이지 않고 HTTP/1.1을 직접 했다(TLS는 이미 있는 native-tls, 압축은 이미 있는 flate2). undici와 같게 맞춘 것: 기본 요청 헤더(`accept`, `accept-language`, `sec-fetch-mode`, `user-agent: node`, `accept-encoding: gzip, deflate`, keep-alive, HEAD는 close), 문자열 본문의 `text/plain;charset=UTF-8`, 본문 없는 POST/PUT의 `content-length: 0`, 리디렉션(최대 20번, 303과 POST의 301/302는 GET으로, 다른 출처로 가면 authorization/cookie 제거), gzip/deflate 풀기, 청크 전송, 응답 헤더를 소문자 정렬하고 중복은 ", "로 합침(set-cookie는 따로), `text()`의 BOM 제거, 오류 문구(`fetch failed`, `Failed to parse URL from ...`), riven_api_request의 8000자(UTF-16) 자르기.

Node 판과 다른 점:

- https에서 undici는 `br`도 받겠다고 하고 brotli를 푼다. Rust는 `gzip, deflate`만 보내서 서버가 gzip으로 준다. 본문은 같고 `content-encoding` 헤더가 다르다(example.com 확인).
- TLS 인증서는 시스템 신뢰 저장소로 확인한다(Node는 자체 Mozilla 목록). 회사 내부 CA는 Rust 쪽이 오히려 통한다.
- `data:`, `file:` URL은 지원하지 않는다(`fetch failed`).
- riven_api_request가 실행 중에 에이전트가 끊으면 답은 버리지만 요청 자체는 끝까지 간다(Node도 같았음).

같은 입력으로 비교 (원래 모듈을 electron 대역으로 묶어 Node로 실행 vs 실앱 `window.api` -> Rust, HTTP는 Rust 시험 함수):

- **도구 13건:** cli:list, ports:list 2, ports:kill(틀린 pid), diagnostics 5(tsc 오류 있는 ts 프로젝트, eslint 설정 없음, 도구 없는 폴더 2, 빈 루트), usage:today 2(오늘 고친 실제 대화 기록 33개 파일, 1GB를 스크래치 폴더에 복사해 고정, 없는 폴더), usage:codex, models:claude. 12건이 같았고 cli:list만 Rust가 `cargo`를 하나 더 찾았다(시험 앱 로그인 PATH의 `~/.cargo/bin`, 언어 서버의 rust-analyzer와 같은 환경 차이). usage:today는 총비용 931.96달러, 토큰 4억 6천만 개, 모델별 숫자까지 같았다.
- **ports:kill 실제:** 스크래치 폴더에서 띄운 python http.server 두 개를 Node와 Rust가 하나씩 죽였다. 둘 다 `{ok:true}`, 다시 부르면 Rust는 "that port is no longer held by that process".
- **HTTP 32가지 x 2 (api:request, riven_api_request 문자열):** 로컬 시험 서버로 GET/POST/PUT/PATCH/DELETE/HEAD, 사용자 헤더와 대소문자, 리디렉션 3단계, 무한 리디렉션, 301/302/303/307, 다른 출처 리디렉션(Authorization, Cookie 제거), gzip, deflate, 청크, set-cookie와 중복 헤더, BOM, 사용자 정의 상태 문구(418), 2만 자 본문 자르기, 204, 잘못된 UTF-8, 404, 잘못된 URL, 빈 URL, ftp, 연결 거부, 그리고 https://example.com 읽기 하나. 64건 모두 같았다(date 헤더와 example.com의 캐시 헤더는 빼고 비교). 처음에는 HEAD의 `connection` 헤더 하나가 달랐다.
- **실앱:** `window.api.api.request`로 307 POST(본문 유지)와 연결 거부(`fetch failed`)를 확인했다.

시험 뒤 발견해서 고친 것: 처음 `usage:today`는 파일을 통째로 읽었다(`read_to_end`). 사용자의 실제 대화 기록(36시간 안, 1GB)을 앱 시작 때 읽고 나서 riven-tauri footprint가 809MB로 남았다. Node처럼 64KB씩 읽고 한 줄만 들고 있게 바꾼 뒤 시작 45초 뒤 68MB, 1GB 사본을 한 번 더 읽은 뒤 71MB였다. 결과는 다시 비교해 3건 모두 같았다. usage:codex도 같은 방식으로 읽는다(token_count 줄만 보관).

추론만 한 것: MCP를 거친 riven_api_request 왕복(시험 앱의 MCP 토큰을 얻으려고 터미널 환경을 읽으려 했는데 권한 확인에서 거부되어 하지 않음. 같은 `api_request_text`를 위 비교에서 확인했고, 연결은 DB 도구와 같은 `wait`/`page_result` 길), usage:today의 하루가 바뀔 때 캐시 비우기, ports:kill의 SIGKILL 경로(시험 서버가 SIGTERM에 바로 끝남).

#### 7-4. 창 닫기 저장 누락, 디스플레이 목록이 빌 때

- **창 닫기 직전 300ms의 설정/세션 변경이 사라지던 문제 (1단계에서 기록):** WKWebView는 창을 닫을 때 beforeunload도 pagehide도 보내지 않는다. 이제 앱 창(`w*`)의 CloseRequested에서 Rust가 닫기를 잠시 막고, 페이지에서 `dispatchEvent(new Event('beforeunload'))`를 WKWebView로 직접 실행해 끝나기를 기다린 뒤(최대 3초) 진짜로 닫는다(`main.rs`의 `flush_page`). 렌더러의 저장(settings.ts, session.ts)은 beforeunload에서 sendSync로 막고 쓰므로 스크립트가 끝났으면 저장도 끝났다. 팝아웃 창은 원래 하던 방식(beforeunload 후 1.5초 뒤 destroy) 그대로다.
  - 확인: 탐색기에서 파일을 열고(세션 변경, 300ms 디바운스) 바로 시험 훅 `op=close`(닫기 버튼과 같은 `win.close`)로 창을 닫았다. 고치기 전 빌드는 sessions.json에 그 파일이 없었고(0건), 고친 빌드는 있었다(2건). 페이지에 beforeunload 리스너를 달아 `config.saveSync`로 파일을 쓰게 한 시험도 고친 빌드에서 닫는 순간 파일이 생겼다(settings.json, sessions.json도 같은 시각에 다시 써짐).
  - 앱 종료(Cmd+Q, Node의 app.quit)는 이 경로가 아니다. 그때의 저장은 아직 Node의 동기 XHR 중계(`ipc.sync`)가 맡는다. 8단계에서 Node를 지울 때 종료 경로도 같은 `flush_page`로 바꿔야 한다.
- **`screen.displays`가 비면 펫 창 오류:** macOS가 잠깐 디스플레이를 0개로 알려 주면(디스플레이 잠자기, 덮개 닫힘, 구성 변경 중) Node 셰임의 `getPrimaryDisplay()`가 undefined를 주고 펫 위치 계산의 `.workArea`가 터졌다. Electron은 항상 디스플레이를 하나 이상 준다. Rust `displays`가 빈 목록 대신 마지막으로 본 목록, 없으면 메인 창의 모니터, 그것도 없으면 0,0의 1440x900 하나를 준다.
  - 확인: 개발용 `RIVEN_DEV_NO_DISPLAYS=1`(앱 환경에 줌)로 빈 목록을 흉내 내고 새 시험 훅 `op=displays`로 Node가 보는 값을 읽었다. 디스플레이 1개(메인 창 모니터 3440x1440)를 받았고 앱이 정상으로 떴다. 평소에는 2개(작업 영역 3440x1410). 펫 창은 화면 위에 뜨는 창이라 이번 시험에서 열지 않았다.

#### 7-5. 잠자기 방지, CPU 표본

- `power:busy`, `power:remote`(send), `perf:metrics`를 `services/power.rs`로 옮겼다. `MOVED`에 `keepAwake`, `perf`를 더했다.
- 잠자기 방지는 셰임이 Electron `powerSaveBlocker`를 흉내 내던 방식 그대로 `/usr/bin/caffeinate -i -w <pid>`다. 다만 pid가 Node가 아니라 Rust 프로세스라서 Rust가 죽으면 caffeinate도 스스로 끝난다. 조건(`(enabled && count > 0) || remote`, count는 `Math.max(0, Math.floor(count))`)과 로그 문구도 같다. 앱이 끝날 때(RunEvent::Exit) 놓는다.
- `perf:metrics`는 Chromium 프로세스 목록이 없으니 메인(Rust) 프로세스 하나의 CPU(직전 표본 이후 getrusage 차이, 코어 하나 기준 %)를 준다. 셰임은 Node 프로세스를 'Browser'로 보고했었다. WebKit 프로세스는 시스템 XPC 서비스라서 넣지 않았다.
- 확인 (실앱, `window.api.power`): busy(2,true) -> caffeinate 1개(`-i -w <riven-tauri pid>`), busy(1,true) 유지, busy(0,true) 해제, remote(true) 잡음, busy(3,false) 유지(remote 때문), remote(false) 해제, busy(3,false) 없음, busy(2.7,true) 잡음("2 pane(s)" 로그). 각 단계마다 시험 앱의 자식 프로세스만 확인했다. `perf:metrics`는 두 번째 표본에서 0.17%.
- 추론만 한 것: 실제로 잠자기가 막히는지(`pmset -g assertions`는 다른 프로세스의 정보까지 보여 줘서 읽지 않음. caffeinate 자체의 동작).

#### 7-6. 알림 (notify)

- `notify:show`, `notify:presence`(send), `notify:diag`를 `services/notify.rs`로 옮겼다. `MOVED`에 `notify`를 더했고 `tauri/shim/moved/notify.ts`는 빈 함수 두 개다. 계획(`computePlan`), 5초 쿨다운, 통계는 notify.ts와 같다(같은 단위 시험을 Rust로 옮김). presence는 webContents id 대신 창 label로 묶고, 창이 Destroyed 되면 지운다.
- 게시는 UNUserNotificationCenter(objc2-user-notifications)다. 앱 아이콘과 이름으로 뜨고, 클릭은 센터 delegate로 돌아온다. 클릭하면 계획이 고른 창을 복원, 표시, 포커스하고 그 창에 `notify:click`(paneId)을 보낸다. 앱이 앞에 있을 때도 배너를 띄운다(Electron과 같음, 보고 있는 패널은 계획이 이미 거름).
- notify.ts의 시작 시 무음 알림(목록 등록용)은 Rust 시작 시 권한 요청(alert, sound)으로 바꿨다. 백그라운드 시험 모드에서는 하지 않는다.
- 셰임의 `Notification` 클래스(update.ts의 "업데이트 준비됨")도 osascript 대신 제어 회선 `notify.post`로 같은 경로를 쓴다. 클릭은 `{ev: 'notify', id, kind: 'click'}`으로 Node에 온다.
- UNUserNotificationCenter는 번들 id가 있는 .app에서만 된다. `tauri/run.sh`는 개발 바이너리를 `src-tauri/target/debug/riven-tauri.app`(Info.plist, MacOS/riven-tauri 복제본, Resources/icon.icns, ad-hoc 서명)으로 감싸 실행한다. Resources에 app, node가 없어서 `bundled()`는 거짓이고 개발은 그대로 out-tauri를 쓴다. 번들 id는 `riven-tauri`다. WebKit이 페이지 데이터(localStorage)를 `~/Library/WebKit/<번들 id>`에 두는데, 번들 없는 바이너리는 이름(riven-tauri)을 썼으므로 같은 id여야 개발 데이터가 그대로 보인다. 패키지 앱(`dev.riven.tauri`)과도 섞이지 않는다. 번들이 아니면(`RIVEN_TAURI_NO_APP=1`, cargo run) 예전처럼 osascript로 띄우고 클릭은 못 본다.
- 패키지 앱은 tauri.bundle.json에 ad-hoc 서명(`signingIdentity: "-"`)을 더했다.
- 추론만 한 것: 실제 배너 표시, 아이콘, 클릭 경로, 권한 창(사용자가 쓰는 Mac이라 알림을 띄우지 않음). 빌드, 단위 시험, 개발 .app 구조와 서명만 확인했다.

#### 7단계 정리

Rust로 옮긴 채널 (이번 단계): lsp 5, debug 9, cli/ports/models/diagnostics 5, usage 2, api:request 1, power 2, perf 1 = invoke/send 25개, 이벤트 3개(`lsp:notify`, `lsp:stopped`, `debug:event`). MCP의 마지막 Node 다리(`riven_api_request`)를 지웠다. `MOVED`에 `lsp`, `debugger`, `cli`, `ports`, `modelCatalog`, `diagnostics`, `usage`(`usage:limits`만 남김), `apiclient`, `keepAwake`, `perf`를 더했다.

남은 Node 코드 (`src/main`, 테스트 제외, Tauri 빌드의 Node 번들에 들어가는 것):

| | 줄 수 |
|---|---|
| 6단계 후 | 4,461 (소스맵 기준 4,491, 30개 파일) |
| 7단계 후 | 3,033 (소스맵 기준 3,051, 18개 파일) |

남은 18개 파일: browser 722, usage 470(그중 `usageLimits`만 쓰임), index 448, pet 305, notify 200, tray 133, demo 101, auth 87, media 86, permissions 72, update 72, systemResume 69, menu 66, bridge 64, remoteKey 63, atomicWrite 40, focusTrace 28, appWindow 25. 이와 별도로 `tauri/shim`(Electron 대역, 서버, 창) 3,080줄이 번들에 있다. Rust 쪽은 `services/lsp.rs`, `debug.rs`, `tools.rs`, `usage.rs`, `http.rs`, `power.rs`와 명령 파일이 늘었다.

메모리 (개발 빌드, 빈 상태, 시작 45초 뒤, footprint): riven-tauri 68MB, Node 39MB. 4단계 때 Node는 175MB였다(그 차이 대부분은 사용량 위젯이 Node에서 대화 기록을 읽던 몫이 Rust로 온 것과 DB, 언어 서버 등이 빠진 것). 큰 응답 반복에서 riven-tauri가 늘지 않는 것은 7-1 참고.

이번 단계에서 옮기지 않은 것 (이유):

- **usage:limits:** Claude Code의 OAuth 토큰을 사용자 키체인에서 읽는다. 이번 시험은 키체인을 건드리지 않기로 해서 옮기지 않았다. Rust로 옮길 때는 같은 `security find-generic-password` 호출(서비스 이름 규칙은 `usage.ts`의 `keychainService`)과 https 요청(이제 `services/http.rs`로 가능)이면 된다.
- **permissions (`perm:report`, `ask`, `open`), auth (`auth:oauth`), update (`update:*`, `app:version`), remoteKey (`remoteKey:*`, 키체인):** 권한 창, 로그인 창, 업데이트 내려받기, 키체인처럼 시험할 때 화면에 뜨거나 실제 서비스/사용자 데이터를 건드리는 것들이다. 코드만 옮기고 검증 없이 넣지 않으려고 남겼다. 8단계에서 tauri-plugin-updater, 딥링크와 함께 옮긴다.
- **pet (17개 채널), tray (`tray:feed`, `diag`):** 화면 위에 떠 있는 창과 메뉴 막대 아이콘이라 시험 중 사용자 화면에 보인다. 창/트레이 원시 기능은 이미 Rust(제어 회선의 `win.*`, `tray.*`)이고 남은 것은 그 위의 로직이다.
- **browser (19개 채널):** 브라우저 패널의 TS 쪽 로직(즐겨찾기, 기록, 찾기, 요소 선택 등). 네이티브 부분은 이미 `browser.rs`다. 722줄로 크고 페이지 로드 시험이 필요해 다음으로 미뤘다.
- **index, menu, bridge(`capture:save`, `shell:openExternal`, `ui:setZoom`), media(riven-media 프로토콜), systemResume, focusTrace, demo, appWindow, atomicWrite, `env:defaults`:** 앱 생명주기와 창, 메뉴, 페이지 제공에 붙어 있어서 Node를 지우는 8단계와 같이 옮긴다.

### 8단계가 해야 할 것 (7단계에서 정리)

- **페이지를 Tauri가 직접 준다:** 지금은 Node(`tauri/shim/server.ts`)가 `http://127.0.0.1:47391`로 렌더러를 준다. Tauri 커스텀 프로토콜(또는 `frontendDist`)로 바꾸면 Node HTTP 서버, 페이지 소켓(`/__riven/ws`), 미디어 경로(`/__riven/media`)가 없어진다. 이때 7-1의 CSP 고침(`connect-src`에 `ipc:`)을 페이지를 주는 쪽으로 옮기고, localStorage가 출처(origin)별이라 기존 `http://127.0.0.1:47391`의 저장값을 옮기는 방법을 정해야 한다. pty 스트림(WebSocket)을 raw Channel로 바꿀지 그때 다시 잰다(2단계 메모).
- **sendSync 중계 없애기:** `config:save-sync`, `sessions:save-sync`는 창 닫기에서는 이제 `flush_page`(7-4)가 페이지의 beforeunload를 미리 돌려서 해결된다. 앱 종료(Cmd+Q, Dock 메뉴, 로그아웃)도 RunEvent::ExitRequested에서 모든 앱 창에 `flush_page`를 돌린 뒤 끝내면 동기 XHR이 필요 없다. `__riven:dragPaths`(드롭한 파일 경로)는 Rust가 드래그 시작/드롭 때 경로를 페이지에 미리 보내는 방식으로 바꿔야 한다.
- **종료 확인:** index.ts의 before-quit 대화상자와 그 수(`pty.working`, `chat.running` 동기 호출)를 Rust로.
- **시험 훅:** `server.ts`의 `/__riven/test`(`op=eval`, `wv`, `shot`, `close`, `busy`, `displays`, `front`)를 Rust 쪽 루프백 엔드포인트로 옮긴다(`RIVEN_TAURI_TEST_KEY`가 있을 때만). 백그라운드 모드(`RIVEN_TAURI_BACKGROUND=1`, 7-1의 가림 감지 끄기 포함)는 이미 Rust다.
- **위 "옮기지 않은 것" 전부:** usage:limits, permissions, auth, update, remoteKey, pet, tray, browser, menu, bridge, media, systemResume, focusTrace, demo.
- **패키징:** `tauri/package.mjs`에서 Node 바이너리와 node_modules 동봉을 빼고, 서명/공증, tauri-plugin-updater 피드. 언어 서버는 이미 설치된 것만 쓰므로(7-2) 앱에 넣을 것이 없다. 묶인 서버가 빠지면 Electron에서 넘어온 사용자에게 상태줄 안내가 처음 보일 수 있다.

### 8단계 전 정리 (2026-11-19)

#### 8a-1. 탭 줄의 거짓 "∨ 1" 넘침 버튼 (WKWebView)

- **현상:** 사용자 앱에서 탭 3개(탐색기, 코드, 안녕?)인 묶음에 아무 탭도 넘치지 않았는데 dockview 넘침 버튼 "1"이 떴다. 잰 값: `.dv-tabs-container` 너비 192.63(clientWidth 192, scrollWidth 193, 높이는 둘 다 30, scrollLeft 0), 마지막 탭의 오른쪽 끝이 탭 줄 오른쪽보다 약 1.5e-6px 밖.
- **원인:** dockview-core 7.0.2가 넘침을 정확한 비교 두 개로 판단한다. `OverflowObserver`의 `scrollWidth > clientWidth`(193 > 192), `toggleDropdown`의 `isChildEntirelyVisibleWithinParent`(오른쪽 끝 비교). 탭 줄은 내용 너비에 맞춰 줄어드는 상자이고 탭 너비가 소수라서, WebKit이 scrollWidth는 올리고 clientWidth는 내리는 반올림에 두 비교가 모두 걸린다. Chromium은 양쪽을 같게 맞춰서 Electron에서는 안 보였다.
- **고침:** `vite/dockviewSubpixelOverflow.ts` (렌더러 빌드 플러그인, `dockviewFilePopout`과 같은 방식). 두 비교에 1px 여유를 준다(`scrollWidth - clientWidth > 1`, 탭 위치 비교에 ±1px). 1px보다 덜 잘린 탭은 가려진 것이 아니다. 진짜 넘침은 그대로 같은 개수로 보인다. 레이아웃과 CSS는 건드리지 않아서 탭 줄 빈 곳에 끌어다 놓기는 그대로다. dockview가 바뀌어 고칠 코드를 못 찾으면 빌드가 실패한다. Electron 빌드에도 들어간다(빌드 결과에 고친 코드 확인).
- **확인 (백그라운드 시험 앱, `op=wv`):** 시험 앱이 같은 세션을 복원해 사용자 앱과 같은 묶음(192.6302, cw 192, sw 193)이 떴고 넘침 버튼이 없었다. 탭 너비를 소수로 바꾼 6가지(그중 5가지는 옛 판단이면 넘침, 4가지는 옛 탭 비교로 1개 숨김)에서 모두 버튼 없음. 진짜 넘침 4가지(숨은 탭 1, 2, 1, 3개)에서 버튼과 개수가 1, 2, 1, 3으로 맞았다. 시험 뒤 원래 너비로 돌리자 버튼 없음.
- dockview 원래 동작 그대로인 것: 넘친 상태에서 탭 줄 너비가 안 바뀌고 탭만 커지면 개수가 바로 갱신되지 않는다(ResizeObserver가 탭 줄에만 걸려 있음). 고치기 전과 같다.

#### 8a-2. 브라우저 패널: 페이지를 못 열 때 (did-fail-load)

- **현상:** DNS 실패, 연결 거부, 인증서 오류 등으로 페이지를 못 열면 아무 일도 없었다. 이전 페이지가 그대로 있고 주소줄은 이전 주소로 돌아갔다. wry의 WKNavigationDelegate에 실패 콜백이 없고, `tauri/shim/views.ts`는 did-fail-load를 내지 않았다.
- **확인한 사실:** Electron 쪽(`src/main/browser.ts`)도 did-fail-load를 듣지 않고, 렌더러 브라우저 패널에는 따로 오류 화면이 없다. Electron에서 보이던 것은 Chromium 동작이다. 실패한 주소로 오류 페이지를 커밋하고(주소줄에 친 주소가 남음, 새로고침은 그 주소를 다시 시도), did-fail-load와 did-stop-loading을 내고, loadURL을 `ERR_NAME_NOT_RESOLVED (-105) loading '...'`로 거부한다. 이 모양에 맞췄다.
- **고침 (`browser.rs`):** 브라우저 뷰의 navigation delegate를 작은 대리 객체(`NavProxy`)로 바꾼다. 실패 콜백 두 개(`didFailProvisionalNavigation`, `didFailNavigation`)만 직접 받고, 나머지 delegate 메시지는 `forwardingTargetForSelector`로 wry의 delegate에 그대로 넘긴다(탐색 정책, 페이지 로드, 내려받기 훅은 전과 같음). WebKit은 delegate를 약하게 잡으므로 대리 객체는 뷰가 닫힐 때까지 `PROXIES`가 잡는다. NSError를 Chromium net 오류 코드와 이름으로 바꾼다(`net_error`, 단위 시험). 커밋 전에 실패하고 중단(-3)이 아니면 Safari와 같은 방식(`_loadAlternateHTMLString:baseURL:forUnreachableURL:`)으로 실패한 주소 자리에 오류 페이지를 띄운다. 오류 페이지는 스크립트 없는 정적 HTML(CSP `default-src 'none'`)로 WebKit의 설명(시스템 언어), 주소, 오류 이름만 보인다. 커밋 뒤의 실패는 그린 내용을 두고 이벤트만 낸다. 중단(다른 주소로 바뀜, 정지, 내려받기로 바뀜)은 오류 페이지 없이 `ERR_ABORTED`만 낸다.
- **셰임 (`views.ts`):** `fail`을 받아 did-fail-provisional-load, did-fail-load(event, code, desc, url, isMainFrame=true, 0, 0)를 내고, 기다리는 loadURL을 Electron과 같은 오류(errno, code, url)로 거부한다. 로그에 `[browser] load failed: ERR_... (-N) url` 한 줄. 오류 페이지가 뜰 실패에서는 WebKit이 잠깐 이전 주소를 알려 주는 상태를 쓰지 않는다(주소줄 깜빡임 방지).
- **확인 (백그라운드 시험 앱, 로컬 시험 서버, `window.api.browser`):** 연결 거부, `.invalid` 호스트(DNS), 자체 서명 https, 연결 직후 끊음, 본문 중간에 끊음, 정상 페이지 6가지. 앞 4가지는 오류 페이지(ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED, ERR_CERT_AUTHORITY_INVALID, ERR_CONNECTION_RESET)와 실패한 주소, 로그 한 줄. 중간에 끊긴 것은 내용 유지와 ERR_CONNECTION_RESET 로그. 렌더러가 받는 이벤트 순서는 정상 로드와 같았다(loading true, nav, title, loading false). 오류 페이지에서 서버를 띄운 뒤 새로고침하면 진짜 페이지가 떴고, 뒤로/앞으로가 맞게 움직였고(앞으로 간 오류 항목은 다시 시도해 다시 실패), 로드 도중 다른 주소로 바꾸면 ERR_ABORTED만 나고 오류 페이지는 없었다. https://example.com 읽기 한 번은 정상.
- 추론만 한 것: 내려받기로 바뀌는 로드(대리 객체가 wry의 `didBecomeDownload`로 넘기는 것은 같은 전달 경로, 실제 파일을 받지 않으려고 돌리지 않음), 시간 초과(-1001, 60초 이상 걸려 돌리지 않음).

#### 8a-3. 브라우저 패널 로직을 Rust로 (`browser:*` 21개)

`src/main/browser.ts`(721줄)와 그 밑의 Electron 대역 `tauri/shim/views.ts`(WebContentsView 흉내, 451줄)를 `services/browser.rs` + `commands/browser.rs`로 옮겼다. 네이티브 뷰(`browser.rs`)의 훅은 이제 Node가 아니라 Rust 서비스로 바로 간다. `MOVED`에 `browser`를 더했고 `views.ts`는 지웠다(셰임 `windows.ts`의 `contentView`, `electron-main.ts`의 `session`/`WebContentsView`도 지움).

- **옮긴 채널 (invoke/send 21개, 이벤트 3개):** `browser:bookmarks`, `history`, `addBookmark`, `removeBookmark`, `clearHistory`, `create`, `navigate`, `go`, `destroy`, `sync`(send), `hideAll`(send), `execJs`, `capture`, `state`, `setZoom`, `find`(send), `openDevtools`, `setLang`(send), `suggest`(send), `barMenu`, `pickElement`. 이벤트 `browser:event`, `browser:key`, `browser:suggestPick`. (`browser:focusApp`은 preload에 있지만 Electron에도 받는 곳이 없다. 그대로 둠.)
- **구조:** 네이티브 훅은 메인 스레드에서 본 것을 큐에 넣기만 하고, `browser` 스레드 하나가 순서대로 이벤트로 바꾼다. 메인 스레드는 상태 잠금을 잡지 않는다(명령이 잠금을 잡은 채 메인 스레드를 기다리는 네이티브 호출을 해도 막히지 않게). 창 이벤트(팝아웃 닫힘, 창 파괴, 부모 창 이동)도 큐로 간다. 명령은 전부 async, 메인 스레드 밖에서 돈다.
- **같게 맞춘 것:** views.ts `_state`의 상태 차이 -> Electron 이벤트 -> browser.ts의 `browser:event` 변환(`diff`, 단위 시험), 로딩 중 700ms 상태 확인, 해시 변경 120ms 뒤 다시 읽기, 기록(http(s)만, 같은 주소 하나, 500개, 목록은 100개)과 즐겨찾기(같은 주소 중복 없음), `browser.json`(같은 파일, 모르는 키 보존, 300ms 뒤 저장. 이제 원자적 쓰기), `browser:sync`의 배치 계산(CSS px -> 창 px 비율, 1px 테두리 안쪽, `Math.round`), 패널별 최신 sync만 반영, 다른 워크스페이스 패널의 뷰는 건드리지 않음, `hideAll`, execJs의 식/스크립트 판단(이제 페이지 CSP를 받지 않는 riven 콘텐츠 월드에서 `new Function`으로 파싱만 함)과 `error: ...` 문자열, capture의 data URL, 오른쪽 클릭과 도구 막대 메뉴(같은 항목, 한/영, 확대 0.4~3), 요소 선택 스크립트, 주소 줄 추천 목록 HTML.
- **팝아웃:** browser.ts의 방식(창의 `window.__rivenPopout` 키로 찾기, 닫힐 때 뷰를 riven 창으로 돌리고 `resync`)을 Rust에 넣었다. views.ts의 TODO(팝아웃의 브라우저 패널은 riven 창에 숨은 채로 남음)가 이것으로 풀린다. Tauri 팝아웃 창(`pop-*`)의 첫 닫기와 `win.destroy`에서 뷰를 먼저 돌려보낸다.
- **같은 입력 비교 (같은 시험 앱에서 Node 구현과 Rust 구현을 차례로, 로컬 시험 서버):** 34단계 시나리오(만들기, 이동, 뒤로/앞으로, 기록, 해시 변경, 제목 변경, 즐겨찾기 추가/중복/삭제, 확대, sync 정수와 소수 사각형(뷰 안쪽 크기로 확인), hideAll, 다른 패널의 sync, 자기 패널 숨김, execJs 오류/객체/Promise/undefined, capture, find와 지우기, 요소 선택(클릭, Esc), 연결 거부 실패, 없는 탭의 state/execJs/capture, destroy, 끝의 기록). 값과 렌더러가 받은 `browser:event` 순서가 34단계 모두 같았다. 처음 실행에서는 이벤트가 하나도 오지 않았는데, `emit_ipc`의 args를 배열로 감싸지 않은 실수였다(고친 뒤 위 결과).
- **Node에서 원래 모듈로 비교:** browser.ts를 electron 대역으로 묶어 Node로 돌려 메뉴 4가지(영어 기본, 한국어 전부 켬, 도구 막대 about:blank, 즐겨찾기된 https), 확대 단계 3가지, sync 배치 2가지를 뽑았고 Rust 단위 시험의 기대값과 글자까지 같았다.
- 추론만 한 것 (화면에 뜨는 것이라 시험 앱에서 띄우지 않음): 오른쪽 클릭 메뉴와 도구 막대 메뉴의 실제 팝업과 항목 클릭(링크 복사는 pbcopy), 주소 줄 추천 창(포커스를 받지 않는 별도 창, 행 높이에 맞춘 크기, 클릭 -> `browser:suggestPick`, 부모 창이 움직이거나 포커스를 잃으면 닫힘. 백그라운드 시험 모드에서는 띄우지 않음), 팝아웃 창으로 뷰 옮기기와 닫을 때 돌아오기, 내려받기 이벤트, Cmd/Ctrl 키 전달(신뢰된 키 입력이 필요).
