import AppKit

// Live, remappable keybindings for the app-level (menu) shortcuts — riven's keymap.
// Each action has a stable id and a default chord; the user can override any of them
// in Settings › Shortcuts (the recorder writes an override), and the menu bar is
// rebuilt from this model so the new key takes effect immediately.
//
// A chord is stored as a lowercase string like "cmd+shift+f" / "cmd+=" and resolves to
// an NSMenuItem (keyEquivalent + modifier mask). Only Command-based chords live in the
// menu; the ⌃-based ones (terminal select) stay in the event monitor.
enum Keys {
    // action id -> default chord. `cat`: "riven" (app) or "terminal". Order/labels
    // drive the Settings list.
    struct Action { let id: String; let label: String; let def: String; let cat: String }
    static let actions: [Action] = [
        .init(id: "app.settings", label: "설정 열기", def: "cmd+,", cat: "riven"),
        .init(id: "file.addPanel", label: "패널 추가", def: "cmd+o", cat: "riven"),
        .init(id: "file.quickOpen", label: "빠른 파일 열기", def: "cmd+p", cat: "riven"),
        .init(id: "file.commandPalette", label: "명령 팔레트", def: "cmd+shift+p", cat: "riven"),
        .init(id: "file.newWorkspace", label: "새 워크스페이스", def: "cmd+shift+n", cat: "riven"),
        .init(id: "view.popout", label: "패널 새 창으로", def: "cmd+shift+o", cat: "riven"),
        .init(id: "file.save", label: "저장", def: "cmd+s", cat: "riven"),
        .init(id: "file.closeTab", label: "탭 닫기", def: "cmd+w", cat: "riven"),
        .init(id: "view.toggleSidebar", label: "사이드바 토글", def: "cmd+b", cat: "riven"),
        .init(id: "view.search", label: "검색", def: "cmd+shift+f", cat: "riven"),
        .init(id: "view.git", label: "소스 컨트롤", def: "cmd+shift+g", cat: "riven"),
        .init(id: "view.preview", label: "미리보기", def: "cmd+shift+v", cat: "riven"),
        .init(id: "view.changes", label: "변경 사항", def: "cmd+shift+c", cat: "riven"),
        .init(id: "view.focusEditor", label: "에디터로 포커스", def: "cmd+e", cat: "riven"),
        .init(id: "view.focusTerminal", label: "터미널로 포커스", def: "cmd+j", cat: "riven"),
        .init(id: "view.zoomIn", label: "글자 크게", def: "cmd+=", cat: "riven"),
        .init(id: "view.zoomOut", label: "글자 작게", def: "cmd+-", cat: "riven"),
        .init(id: "view.zoomReset", label: "글자 크기 초기화", def: "cmd+0", cat: "riven"),
        .init(id: "term.new", label: "새 터미널", def: "cmd+t", cat: "terminal"),
        .init(id: "term.clear", label: "터미널 지우기", def: "cmd+k", cat: "terminal"),
        .init(id: "term.splitRight", label: "오른쪽으로 분할", def: "cmd+d", cat: "terminal"),
        .init(id: "term.splitDown", label: "아래로 분할", def: "cmd+shift+d", cat: "terminal"),
        .init(id: "term.next", label: "다음 터미널", def: "cmd+shift+]", cat: "terminal"),
        .init(id: "term.prev", label: "이전 터미널", def: "cmd+shift+[", cat: "terminal"),
    ]
    // Editor (Monaco) commands — remappable per-command; overrides are applied on top
    // of the chosen preset via addKeybindingRules in editor.html.
    static let editorActions: [Action] = [
        .init(id: "actions.find", label: "찾기", def: "cmd+f", cat: "editor"),
        .init(id: "editor.action.startFindReplaceAction", label: "바꾸기", def: "cmd+alt+f", cat: "editor"),
        .init(id: "editor.action.addSelectionToNextFindMatch", label: "다음 같은 항목 선택", def: "cmd+d", cat: "editor"),
        .init(id: "editor.action.copyLinesDownAction", label: "줄 복제", def: "shift+alt+down", cat: "editor"),
        .init(id: "editor.action.deleteLines", label: "줄 삭제", def: "cmd+shift+k", cat: "editor"),
        .init(id: "editor.action.moveLinesUpAction", label: "줄 위로 이동", def: "alt+up", cat: "editor"),
        .init(id: "editor.action.moveLinesDownAction", label: "줄 아래로 이동", def: "alt+down", cat: "editor"),
        .init(id: "editor.action.commentLine", label: "한 줄 주석", def: "cmd+/", cat: "editor"),
        .init(id: "editor.action.formatDocument", label: "문서 포맷", def: "shift+alt+f", cat: "editor"),
        .init(id: "editor.action.rename", label: "이름 변경", def: "f2", cat: "editor"),
        .init(id: "editor.action.revealDefinition", label: "정의로 이동", def: "f12", cat: "editor"),
        .init(id: "editor.action.gotoLine", label: "줄 번호로 이동", def: "ctrl+g", cat: "editor"),
    ]
    static func byCat(_ cat: String) -> [Action] {
        cat == "editor" ? editorActions : actions.filter { $0.cat == cat }
    }
    // id -> effective chord for all editor commands (passed to Monaco).
    static func editorChords() -> [String: String] {
        var m: [String: String] = [:]; for a in editorActions { m[a.id] = effective(a.id) }; return m
    }

    // Is `chord` already bound to a DIFFERENT action in the same category? (conflict).
    static func conflict(_ chord: String, excluding id: String, cat: String) -> Action? {
        byCat(cat).first { $0.id != id && effective($0.id) == chord }
    }

    private static var overrides: [String: String] {
        get { (Settings.shared.object("keybindings") as? [String: String]) ?? [:] }
    }
    static func effective(_ id: String) -> String {
        // Look up the built-in default across BOTH the app (menu) actions AND the editor
        // (Monaco) actions. Missing `editorActions` here made every editor chord fall back
        // to "" whenever the user had no override — invisible in dev (the dev machine's
        // settings.json had accumulated overrides) but blank on a fresh/packaged install.
        overrides[id] ?? (actions.first { $0.id == id } ?? editorActions.first { $0.id == id })?.def ?? ""
    }
    static func setOverride(_ id: String, _ chord: String) {
        var o = overrides; o[id] = chord; Settings.shared.set("keybindings", o)
        NotificationCenter.default.post(name: .rivenKeybindingsChanged, object: nil)
    }
    static func reset(_ id: String) {
        var o = overrides; o[id] = nil; Settings.shared.set("keybindings", o)
        NotificationCenter.default.post(name: .rivenKeybindingsChanged, object: nil)
    }

    // "cmd+shift+f" -> (keyEquivalent: "f", mods). Unknown → ("", []).
    static func resolve(_ chord: String) -> (key: String, mods: NSEvent.ModifierFlags) {
        var mods: NSEvent.ModifierFlags = []
        var key = ""
        for part in chord.lowercased().split(separator: "+").map(String.init) {
            switch part {
            case "cmd", "command", "⌘": mods.insert(.command)
            case "shift", "⇧": mods.insert(.shift)
            case "ctrl", "control", "⌃": mods.insert(.control)
            case "alt", "opt", "option", "⌥": mods.insert(.option)
            case "left": key = "\u{2190}"
            case "right": key = "\u{2192}"
            case "up": key = "\u{2191}"
            case "down": key = "\u{2193}"
            default: key = part   // single char (letter / digit / punctuation)
            }
        }
        return (key, mods)
    }

    // A display label like "⌘⇧F" for the settings chip.
    static func display(_ chord: String) -> String {
        let (key, mods) = resolve(chord)
        var s = ""
        if mods.contains(.control) { s += "⌃" }
        if mods.contains(.option) { s += "⌥" }
        if mods.contains(.shift) { s += "⇧" }
        if mods.contains(.command) { s += "⌘" }
        let up = key == "\u{2191}" ? "↑" : key == "\u{2193}" ? "↓" : key == "\u{2190}" ? "←" : key == "\u{2192}" ? "→" : key.uppercased()
        return s + up
    }

    // Build a storage chord from a recorded key event.
    static func chord(from e: NSEvent) -> String? {
        guard let chars = e.charactersIgnoringModifiers, let first = chars.first else { return nil }
        var parts: [String] = []
        if e.modifierFlags.contains(.command) { parts.append("cmd") }
        if e.modifierFlags.contains(.control) { parts.append("ctrl") }
        if e.modifierFlags.contains(.option) { parts.append("alt") }
        if e.modifierFlags.contains(.shift) { parts.append("shift") }
        let key: String
        switch e.keyCode {
        case 123: key = "left"; case 124: key = "right"; case 126: key = "up"; case 125: key = "down"
        default: key = String(first).lowercased()
        }
        parts.append(key)
        // Require at least one modifier so we don't capture bare keys.
        return parts.count >= 2 ? parts.joined(separator: "+") : nil
    }
}

extension Notification.Name { static let rivenKeybindingsChanged = Notification.Name("rivenKeybindingsChanged") }
