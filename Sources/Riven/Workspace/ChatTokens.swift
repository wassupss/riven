import AppKit

// 채팅 입력에서 "실제로 뜻이 있는 조각"을 찾아내는 한 곳.
//
// 두 군데가 같은 답을 써야 한다: 입력창의 색칠과, 보낼 때의 해석. 규칙이 갈라지면 색이 붙은
// @동료에게 메시지가 안 가거나 그 반대가 되므로 스캐너는 하나뿐이다. CLI 가 존재하는 슬래시
// 명령·스킬만 색을 입히는 것과 같은 원칙으로, 여기서도 "실재하는 것"만 토큰이 된다.
enum ChatTokens {
    enum Kind { case command, mention }
    struct Token {
        let range: NSRange       // UTF-16 기준 (NSAttributedString / NSTextView 와 맞춘다)
        let kind: Kind
        /// 매칭된 원래 이름 (동료 닉네임의 정식 표기).
        let name: String
    }

    /// 토큰 글자색. 팔레트에 따라 accent 가 본문색과 거의 같을 수 있어(void: accent #eef0f3 vs
    /// fg #f4f4f6) 대비를 직접 확인하고, 너무 가까우면 보조 액센트로 물러난다.
    static func color(_ kind: Kind) -> NSColor {
        switch kind {
        case .command: return legible(Theme.info)
        case .mention: return legible(Theme.accent)
        }
    }
    /// 토큰 뒤에 까는 옅은 칩 배경. 색만으로는 구분이 안 되는 테마에서도 "이건 토큰"이 읽힌다.
    static func chip(_ kind: Kind) -> NSColor { color(kind).withAlphaComponent(0.18) }

    /// 본문색과 너무 비슷하면 보조 액센트로 바꾼다 (그것도 비슷하면 그냥 쓴다).
    private static func legible(_ c: NSColor) -> NSColor {
        contrastOK(c) ? c : (contrastOK(Theme.accent2) ? Theme.accent2 : c)
    }
    private static func contrastOK(_ c: NSColor) -> Bool {
        guard let a = c.usingColorSpace(.sRGB), let b = Theme.fg.usingColorSpace(.sRGB) else { return true }
        let d = abs(a.redComponent - b.redComponent) + abs(a.greenComponent - b.greenComponent)
              + abs(a.blueComponent - b.blueComponent)
        return d > 0.25
    }

    /// 텍스트에서 색을 입힐 토큰들을 찾는다.
    /// - commands: 실재하는 명령/스킬 이름 (소문자). 비어 있으면 명령은 칠하지 않는다.
    /// - peers: 같은 그룹 동료 닉네임. 비어 있으면(그룹이 아니면) @ 는 평범한 글자다.
    static func scan(_ text: String, commands: Set<String>, peers: [String]) -> [Token] {
        var out: [Token] = []
        let ns = text as NSString
        // 슬래시 명령은 맨 앞에 있을 때만 (CLI 와 같다). "…에서 /tmp 를" 같은 경로는 명령이 아니다.
        if ns.length > 0, ns.character(at: 0) == UInt16(UnicodeScalar("/").value) {
            let end = firstBreak(ns, from: 1)
            let name = ns.substring(with: NSRange(location: 1, length: end - 1)).lowercased()
            if !name.isEmpty, commands.contains(name) {
                out.append(Token(range: NSRange(location: 0, length: end), kind: .command, name: name))
            }
        }
        guard !peers.isEmpty else { return out }
        // 이름에 공백이 있을 수 있어("멤버 2") 가장 길게 맞는 것부터 본다. 이름끼리 접두사가
        // 겹칠 때도("리뷰" / "리뷰어") 긴 쪽이 이긴다.
        let sorted = peers.sorted { $0.count > $1.count }
        let at = UInt16(UnicodeScalar("@").value)
        var i = 0
        while i < ns.length {
            guard ns.character(at: i) == at, isWordStart(ns, i) else { i += 1; continue }
            var matched: (String, Int)?
            for p in sorted {
                let pn = p as NSString
                guard i + 1 + pn.length <= ns.length else { continue }
                let cand = ns.substring(with: NSRange(location: i + 1, length: pn.length))
                if cand.compare(p, options: .caseInsensitive) == .orderedSame { matched = (p, pn.length); break }
            }
            if let (name, len) = matched {
                out.append(Token(range: NSRange(location: i, length: len + 1), kind: .mention, name: name))
                i += len + 1
            } else {
                i += 1
            }
        }
        return out
    }

    /// 보낼 때: 호출된 동료들과, @토큰을 걷어낸 나머지 메시지.
    /// 멘션마다 **그 뒤에 붙은 말**을 따로 떼어 준다. "@멤버1 저녁 추천 @멤버2 점심 추천" 은
    /// 두 사람에게 각각 다른 일을 시킨 것이지 같은 말을 두 번 보낸 게 아니다. 첫 멘션 앞의
    /// 문장은 공통 지시로 보고 모두에게 붙인다.
    /// 뒤에 붙은 말이 없는 멘션(예: "@A @B 이거 봐줘")은 공통 지시만 받는다.
    static func mentionTasks(_ text: String, peers: [String]) -> [(agent: String, message: String)] {
        let toks = scan(text, commands: [], peers: peers).filter { $0.kind == .mention }
        guard !toks.isEmpty else { return [] }
        let ns = text as NSString
        let prefix = ns.substring(to: toks[0].range.location)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var out: [(agent: String, message: String)] = []
        var pending: [String] = []      // 바로 뒤에 할 말이 없던 멘션들 (붙어 있는 호출)
        func put(_ name: String, _ body: String) {
            let full = [prefix, body].filter { !$0.isEmpty }.joined(separator: " ")
            if let k = out.firstIndex(where: { $0.agent == name }) {
                out[k].message = [out[k].message, full].filter { !$0.isEmpty }.joined(separator: " ")
            } else {
                out.append((agent: name, message: full))
            }
        }
        for (i, tok) in toks.enumerated() {
            let start = tok.range.location + tok.range.length
            let end = i + 1 < toks.count ? toks[i + 1].range.location : ns.length
            let own = ns.substring(with: NSRange(location: start, length: max(0, end - start)))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if own.isEmpty {
                // "@A @B 이거 봐줘" 처럼 이름만 붙어 있으면 뒤에 오는 지시를 함께 받는다.
                pending.append(tok.name)
                continue
            }
            for name in pending { put(name, own) }
            pending = []
            put(tok.name, own)
        }
        // 끝까지 할 말이 없던 멘션은 공통 지시만이라도 받는다 (그것도 없으면 위임하지 않는다).
        for name in pending where !prefix.isEmpty { put(name, "") }
        return out.contains { !$0.message.isEmpty } ? out : []
    }

    static func mentions(_ text: String, peers: [String]) -> (targets: [String], rest: String) {
        let toks = scan(text, commands: [], peers: peers).filter { $0.kind == .mention }
        guard !toks.isEmpty else { return ([], text) }
        var targets: [String] = []
        for t in toks where !targets.contains(t.name) { targets.append(t.name) }
        let ns = NSMutableString(string: text)
        for t in toks.reversed() { ns.replaceCharacters(in: t.range, with: "") }   // 뒤에서부터 지워야 오프셋이 안 밀린다
        let rest = (ns as String)
            .replacingOccurrences(of: "[ \\t]{2,}", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (targets, rest)
    }

    /// 전송된 버블에서도 같은 색을 유지하기 위한 속성 문자열.
    static func attributed(_ text: String, base: [NSAttributedString.Key: Any],
                           commands: Set<String>, peers: [String]) -> NSAttributedString {
        let s = NSMutableAttributedString(string: text, attributes: base)
        let bold = (base[.font] as? NSFont).map { NSFontManager.shared.convert($0, toHaveTrait: .boldFontMask) }
        for tok in scan(text, commands: commands, peers: peers) {
            // 글자색 + 옅은 칩 + 굵기. void 처럼 액센트가 본문색과 겹치는 팔레트에서도 읽힌다.
            var at: [NSAttributedString.Key: Any] = [
                .foregroundColor: color(tok.kind), .backgroundColor: chip(tok.kind)]
            if let bold { at[.font] = bold }
            s.addAttributes(at, range: tok.range)
        }
        return s
    }

    /// 공백/줄바꿈이 나오는 첫 위치 (없으면 끝).
    private static func firstBreak(_ ns: NSString, from: Int) -> Int {
        var i = from
        while i < ns.length {
            let c = ns.character(at: i)
            if c == 32 || c == 9 || c == 10 || c == 13 { return i }
            i += 1
        }
        return ns.length
    }
    /// @ 가 단어 시작인지 (앞이 문자열 처음이거나 공백). 이메일 주소 안의 @ 를 걸러낸다.
    private static func isWordStart(_ ns: NSString, _ i: Int) -> Bool {
        guard i > 0 else { return true }
        let c = ns.character(at: i - 1)
        return c == 32 || c == 9 || c == 10 || c == 13 || c == 40 || c == 44   // 공백류, '(', ','
    }
}
