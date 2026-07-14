import { keymap } from './keys'
import { focusEditor, focusPane, clearFocusedTerminal } from './focus'
import { useSession } from '../state/session'
import { useUI } from '../state/ui'
import { contextBus } from '../bridge/contextBus'
import {
  addTerminal,
  togglePanel,
  popoutActive,
  cyclePanel,
  splitTerminal,
  cycleGroupTab,
  selectTerminal
} from '../dock/registry'

const RIVEN = '리븐 기본'
const TERMINAL = '터미널'

// Registers the default set of app actions (code-editor shortcuts live in
// editorKeymaps.ts). Bindings are customizable at runtime.
export function registerDefaultActions(): void {
  // Workspace switching: Mod+1 .. Mod+9
  for (let i = 1; i <= 9; i++) {
    keymap.register({
      id: `workspace.switch.${i}`,
      label: `워크스페이스 ${i}번으로 전환`,
      category: RIVEN,
      context: 'riven',
      def: `Mod+${i}`,
      run: () => {
        const st = useSession.getState()
        const ws = st.openWorkspaces[i - 1]
        if (ws) st.setActiveWorkspace(ws)
      }
    })
  }

  // Focus
  keymap.register({
    id: 'focus.editor',
    label: '에디터로 포커스',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+e',
    run: () => focusEditor()
  })
  keymap.register({
    id: 'focus.terminal',
    label: '활성 터미널로 포커스',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+j',
    run: () => {
      const st = useSession.getState()
      const sink = contextBus.getActive(st.activeWorkspace)
      if (sink) focusPane(sink.paneId)
    }
  })
  keymap.register({
    id: 'focus.panel.next',
    label: '다음 패널',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+Alt+Right',
    run: () => cyclePanel(1)
  })
  keymap.register({
    id: 'focus.panel.prev',
    label: '이전 패널',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+Alt+Left',
    run: () => cyclePanel(-1)
  })

  // Panels
  keymap.register({
    id: 'panel.explorer',
    label: '탐색기 사이드바 토글',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+b',
    run: () => useUI.getState().toggleExplorer()
  })
  keymap.register({
    id: 'panel.search',
    label: '검색 패널',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+Shift+f',
    run: () => togglePanel('search')
  })
  keymap.register({
    id: 'panel.git',
    label: 'Git 패널',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+Shift+g',
    run: () => togglePanel('git')
  })
  keymap.register({
    id: 'panel.popout',
    label: '현재 패널 새 창으로',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+Shift+o',
    run: () => popoutActive()
  })

  // Quick open + command palette
  keymap.register({
    id: 'app.quickOpen',
    label: '파일 빠른 열기',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+p',
    run: () => useUI.getState().setPalette('files')
  })
  keymap.register({
    id: 'app.commandPalette',
    label: '명령 팔레트',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+Shift+p',
    run: () => useUI.getState().setPalette('commands')
  })
  keymap.register({
    id: 'panel.preview',
    label: '프리뷰 패널',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+Shift+v',
    run: () => togglePanel('preview')
  })

  // App
  keymap.register({
    id: 'app.settings',
    label: '설정 열기',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+,',
    run: () => useUI.getState().openSettings('general')
  })
  keymap.register({
    id: 'app.keybindings',
    label: '단축키 설정 열기',
    category: RIVEN,
    context: 'riven',
    def: 'Mod+Alt+k',
    run: () => useUI.getState().openSettings('keys')
  })

  // Terminal
  keymap.register({
    id: 'terminal.new',
    label: '새 터미널',
    category: TERMINAL,
    context: 'riven', // works anywhere
    def: 'Mod+t',
    run: () => addTerminal()
  })
  keymap.register({
    id: 'terminal.clear',
    label: '터미널 화면 지우기',
    category: TERMINAL,
    context: 'terminal', // only while a terminal is focused
    def: 'Mod+k',
    run: () => clearFocusedTerminal()
  })
  keymap.register({
    id: 'terminal.split.right',
    label: '터미널 오른쪽 분할',
    category: TERMINAL,
    context: 'terminal',
    def: 'Mod+d',
    run: () => splitTerminal('right')
  })
  keymap.register({
    id: 'terminal.split.down',
    label: '터미널 아래로 분할',
    category: TERMINAL,
    context: 'terminal',
    def: 'Mod+Shift+d',
    run: () => splitTerminal('below')
  })
  keymap.register({
    id: 'terminal.tab.next',
    label: '다음 터미널 탭',
    category: TERMINAL,
    context: 'terminal',
    def: 'Mod+Shift+]',
    run: () => cycleGroupTab(1)
  })
  keymap.register({
    id: 'terminal.tab.prev',
    label: '이전 터미널 탭',
    category: TERMINAL,
    context: 'terminal',
    def: 'Mod+Shift+[',
    run: () => cycleGroupTab(-1)
  })
  // Select terminal 1..9 with Ctrl (keeps ⌘1-9 for workspace switching).
  for (let i = 1; i <= 9; i++) {
    keymap.register({
      id: `terminal.select.${i}`,
      label: `${i}번 터미널로`,
      category: TERMINAL,
      context: 'terminal',
      def: `Ctrl+${i}`,
      run: () => selectTerminal(i)
    })
  }
}
