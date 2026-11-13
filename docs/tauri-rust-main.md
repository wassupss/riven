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
