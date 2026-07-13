import { keymap } from './keys'
import { focusEditor, focusPane } from './focus'
import { useSession } from '../state/session'
import { useUI } from '../state/ui'
import { contextBus } from '../bridge/contextBus'
import { addTerminal, togglePanel, popoutActive, cyclePanel } from '../dock/registry'

// Registers the default set of actions. Bindings are customizable at runtime.
export function registerDefaultActions(): void {
  // Workspace switching: Mod+1 .. Mod+9
  for (let i = 1; i <= 9; i++) {
    keymap.register({
      id: `workspace.switch.${i}`,
      label: `워크스페이스 ${i}번으로 전환`,
      category: '워크스페이스',
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
    category: '포커스',
    def: 'Mod+e',
    run: () => focusEditor()
  })
  keymap.register({
    id: 'focus.terminal',
    label: '활성 터미널로 포커스',
    category: '포커스',
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
    category: '포커스',
    def: 'Mod+Alt+Right',
    run: () => cyclePanel(1)
  })
  keymap.register({
    id: 'focus.panel.prev',
    label: '이전 패널',
    category: '포커스',
    def: 'Mod+Alt+Left',
    run: () => cyclePanel(-1)
  })

  // Add terminal panels (dockview handles arranging via drag). Run claude / codex
  // / anything inside a terminal.
  keymap.register({
    id: 'terminal.new',
    label: '새 터미널',
    category: '터미널',
    def: 'Mod+t',
    run: () => addTerminal()
  })

  // Toggle singleton panels
  keymap.register({
    id: 'panel.explorer',
    label: '탐색기 사이드바 토글',
    category: '패널',
    def: 'Mod+b',
    run: () => useUI.getState().toggleExplorer()
  })
  keymap.register({
    id: 'panel.search',
    label: '검색 패널',
    category: '패널',
    def: 'Mod+Shift+f',
    run: () => togglePanel('search')
  })
  keymap.register({
    id: 'panel.git',
    label: 'Git 패널',
    category: '패널',
    def: 'Mod+Shift+g',
    run: () => togglePanel('git')
  })
  keymap.register({
    id: 'panel.cli',
    label: 'CLI 런처 패널',
    category: '패널',
    def: 'Mod+Shift+l',
    run: () => togglePanel('cli')
  })
  keymap.register({
    id: 'panel.popout',
    label: '현재 패널 새 창으로',
    category: '패널',
    def: 'Mod+Shift+p',
    run: () => popoutActive()
  })
  keymap.register({
    id: 'panel.preview',
    label: '프리뷰 패널',
    category: '패널',
    def: 'Mod+Shift+v',
    run: () => togglePanel('preview')
  })

  // Open settings / keybindings
  keymap.register({
    id: 'app.settings',
    label: '설정 열기',
    category: '앱',
    def: 'Mod+,',
    run: () => useUI.getState().setSettingsOpen(true)
  })
  keymap.register({
    id: 'app.keybindings',
    label: '단축키 설정 열기',
    category: '앱',
    def: 'Mod+Alt+k',
    run: () => useUI.getState().setKeybindingsOpen(true)
  })
}
