import Foundation

// 표 파일(.xlsx / .csv / .tsv)을 읽어 화면에 그릴 수 있는 값으로만 바꾼다.
//
// 라이브러리를 넣지 않았다. xlsx 는 XML 몇 개를 담은 zip 이고, 우리가 필요한 것은 셀에
// 보이는 값뿐이다 — 수식·서식·차트는 읽지 않는다. 그걸 위해 1MB 짜리 파서를 들이면
// 번들만 커지고, 정작 안 쓰는 코드가 대부분이 된다.
//
// 읽기 전용이다. 편집을 지원하는 척하지 않는다 — 반쯤 편집되는 표는 안 되는 것보다 나쁘다.
enum Spreadsheet {

    struct Sheet {
        let name: String
        /// 행 → 열 → 보이는 문자열. 빈 칸은 "".
        let rows: [[String]]
        /// 파일에 들어 있는 실제 행 수 (아래 cap 으로 잘랐을 때 알려 주기 위해).
        let totalRows: Int
    }

    /// 한 번에 그리는 최대 행. 수만 행짜리 표를 통째로 DOM 에 만들면 창이 멈춘다.
    /// 자른 사실은 화면에 적는다 — 조용히 자르면 데이터가 없는 것처럼 보인다.
    static let maxRows = 5_000
    static let maxCols = 200

    static func isSpreadsheet(_ path: String) -> Bool {
        ["xlsx", "xlsm", "csv", "tsv"].contains((path as NSString).pathExtension.lowercased())
    }

    static func read(_ url: URL) -> [Sheet]? {
        switch url.pathExtension.lowercased() {
        case "csv": return readSeparated(url, sep: ",")
        case "tsv": return readSeparated(url, sep: "\t")
        case "xlsx", "xlsm": return readXLSX(url)
        default: return nil
        }
    }

    // ---- csv / tsv ---------------------------------------------------------

    /// 따옴표 안의 구분자·줄바꿈을 지킨다. 이 두 가지를 놓치면 주소나 문장이 든 표가
    /// 통째로 어긋난다 (엑셀에서 내보낸 csv 에 흔하다).
    private static func readSeparated(_ url: URL, sep: Character) -> [Sheet]? {
        guard let text = readText(url) else { return nil }
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        var it = text.makeIterator()
        var pending: Character? = nil
        func finishRow() { row.append(field); field = ""; rows.append(row); row = [] }
        while let c = pending ?? it.next() {
            pending = nil
            if inQuotes {
                if c == "\"" {
                    if let n = it.next() {
                        if n == "\"" { field.append("\"") } else { inQuotes = false; pending = n }
                    } else { inQuotes = false }
                } else { field.append(c) }
            } else if c == "\"" { inQuotes = true }
            else if c == sep { row.append(field); field = "" }
            else if c == "\r" { }                       // CRLF 의 CR 은 버린다
            else if c == "\n" { finishRow() }
            else { field.append(c) }
        }
        if !field.isEmpty || !row.isEmpty { finishRow() }
        let total = rows.count
        return [Sheet(name: url.lastPathComponent, rows: capped(rows), totalRows: total)]
    }

    /// UTF-8 이 아니면 흔한 인코딩을 차례로 시도한다 (엑셀이 내보낸 한글 csv 는 대개 CP949).
    private static func readText(_ url: URL) -> String? {
        if let s = try? String(contentsOf: url, encoding: .utf8) { return s }
        guard let data = try? Data(contentsOf: url) else { return nil }
        for enc in [String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(
                        CFStringEncoding(CFStringEncodings.dosKorean.rawValue))), .utf16, .isoLatin1] {
            if let s = String(data: data, encoding: enc) { return s }
        }
        return nil
    }

    // ---- xlsx --------------------------------------------------------------

    private static func readXLSX(_ url: URL) -> [Sheet]? {
        // zip 을 직접 풀지 않고 시스템 unzip 에 맡긴다. Foundation 에는 zip API 가 없고,
        // 직접 구현하면 중앙 디렉터리 파싱까지 떠안게 된다 — 표를 읽자고 할 일이 아니다.
        guard let workbook = unzip(url, "xl/workbook.xml") else { return nil }
        let shared = unzip(url, "xl/sharedStrings.xml").map(sharedStrings) ?? []
        let rels = unzip(url, "xl/_rels/workbook.xml.rels").map(relationships) ?? [:]
        let names = sheetNames(workbook)          // [(name, r:id)]
        var out: [Sheet] = []
        for (i, entry) in names.enumerated() {
            // 관계 파일이 알려 주는 실제 경로를 쓴다. sheet 순서와 sheetN.xml 번호는
            // 일치하지 않을 수 있다 (시트를 지웠다 만든 파일에서 어긋난다).
            let target = entry.rid.flatMap { rels[$0] } ?? "worksheets/sheet\(i + 1).xml"
            guard let xml = unzip(url, "xl/" + target) else { continue }
            let (rows, total) = worksheet(xml, shared: shared)
            out.append(Sheet(name: entry.name, rows: rows, totalRows: total))
        }
        return out.isEmpty ? nil : out
    }

    private static func unzip(_ url: URL, _ entry: String) -> Data? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        p.arguments = ["-p", url.path, entry]
        let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return data.isEmpty ? nil : data
    }

    /// <si> 하나가 문자열 하나. <t> 가 여러 개로 쪼개져 있으면(서식이 섞인 셀) 이어 붙인다.
    private static func sharedStrings(_ data: Data) -> [String] {
        let d = XMLCollector(itemTag: "si", textTags: ["t"])
        XMLParser(data: data).also { $0.delegate = d }.parse()
        return d.items
    }

    private static func sheetNames(_ data: Data) -> [(name: String, rid: String?)] {
        let d = AttrCollector(tag: "sheet", keys: ["name", "r:id"])
        XMLParser(data: data).also { $0.delegate = d }.parse()
        return d.rows.map { (name: $0["name"] ?? "Sheet", rid: $0["r:id"]) }
    }

    private static func relationships(_ data: Data) -> [String: String] {
        let d = AttrCollector(tag: "Relationship", keys: ["Id", "Target"])
        XMLParser(data: data).also { $0.delegate = d }.parse()
        var map: [String: String] = [:]
        for r in d.rows { if let id = r["Id"], let t = r["Target"] { map[id] = t } }
        return map
    }

    private static func worksheet(_ data: Data, shared: [String]) -> ([[String]], Int) {
        let d = SheetParser(shared: shared)
        XMLParser(data: data).also { $0.delegate = d }.parse()
        return (capped(d.rows), d.rows.count)
    }

    private static func capped(_ rows: [[String]]) -> [[String]] {
        rows.prefix(maxRows).map { Array($0.prefix(maxCols)) }
    }
}

private extension XMLParser {
    func also(_ f: (XMLParser) -> Void) -> XMLParser { f(self); return self }
}

/// <si> 처럼 "한 항목 = 그 안의 텍스트 전부" 인 목록을 모은다.
private final class XMLCollector: NSObject, XMLParserDelegate {
    private let itemTag: String, textTags: Set<String>
    private var inItem = false, inText = false, buf = ""
    var items: [String] = []
    init(itemTag: String, textTags: Set<String>) { self.itemTag = itemTag; self.textTags = textTags }
    func parser(_ p: XMLParser, didStartElement e: String, namespaceURI: String?,
                qualifiedName q: String?, attributes a: [String: String]) {
        if e == itemTag { inItem = true; buf = "" }
        else if inItem, textTags.contains(e) { inText = true }
    }
    func parser(_ p: XMLParser, foundCharacters s: String) { if inText { buf += s } }
    func parser(_ p: XMLParser, didEndElement e: String, namespaceURI: String?, qualifiedName q: String?) {
        if e == itemTag { items.append(buf); inItem = false }
        else if textTags.contains(e) { inText = false }
    }
}

/// 특정 태그의 속성만 순서대로 모은다.
private final class AttrCollector: NSObject, XMLParserDelegate {
    private let tag: String, keys: [String]
    var rows: [[String: String]] = []
    init(tag: String, keys: [String]) { self.tag = tag; self.keys = keys }
    func parser(_ p: XMLParser, didStartElement e: String, namespaceURI: String?,
                qualifiedName q: String?, attributes a: [String: String]) {
        guard e == tag else { return }
        var row: [String: String] = [:]
        for k in keys { if let v = a[k] { row[k] = v } }
        rows.append(row)
    }
}

/// 워크시트를 행렬로. 셀 좌표(r="C5")를 그대로 읽어 빈 칸을 지킨다 — 좌표를 무시하고
/// 나온 순서대로 채우면, 중간이 빈 표에서 값들이 왼쪽으로 밀려 다른 열에 붙는다.
private final class SheetParser: NSObject, XMLParserDelegate {
    private let shared: [String]
    private var rowCells: [Int: String] = [:]
    private var col = 0
    private var type = ""
    private var buf = ""
    private var inValue = false
    var rows: [[String]] = []

    init(shared: [String]) { self.shared = shared }

    func parser(_ p: XMLParser, didStartElement e: String, namespaceURI: String?,
                qualifiedName q: String?, attributes a: [String: String]) {
        switch e {
        case "row": rowCells = [:]
        case "c":
            col = SheetParser.columnIndex(a["r"] ?? "") ?? (rowCells.keys.max().map { $0 + 1 } ?? 0)
            type = a["t"] ?? ""
        case "v", "t": inValue = true; buf = ""
        default: break
        }
    }
    func parser(_ p: XMLParser, foundCharacters s: String) { if inValue { buf += s } }
    func parser(_ p: XMLParser, didEndElement e: String, namespaceURI: String?, qualifiedName q: String?) {
        switch e {
        case "v", "t":
            inValue = false
            // t="s" 는 공유 문자열 표의 번호다. 그대로 두면 숫자가 보인다.
            if type == "s", let i = Int(buf), i >= 0, i < shared.count { rowCells[col] = shared[i] }
            else if !buf.isEmpty { rowCells[col] = buf }
        case "row":
            let width = (rowCells.keys.max() ?? -1) + 1
            rows.append((0..<width).map { rowCells[$0] ?? "" })
        default: break
        }
    }

    /// "C5" → 2 (0부터). 문자 부분만 26진수로 읽는다.
    static func columnIndex(_ ref: String) -> Int? {
        var n = 0, any = false
        for ch in ref.uppercased() {
            guard let a = ch.asciiValue, a >= 65, a <= 90 else { break }
            n = n * 26 + Int(a - 64); any = true
        }
        return any ? n - 1 : nil
    }
}
