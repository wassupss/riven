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
        /// 굵게 그릴 칸 (보통 머리행). "행,열" 좌표.
        var bold: [[Int]] = []
        /// 숫자 칸. 표에서 숫자가 왼쪽에 붙어 있으면 그것도 깨져 보인다 (엑셀은 오른쪽 정렬).
        var nums: [[Int]] = []
        /// 합쳐진 칸: [행, 열, 세로칸수, 가로칸수].
        var merges: [[Int]] = []
        /// 열 너비 (엑셀 문자 단위). 없으면 빈 배열.
        var colWidths: [Double] = []
    }

    /// 셀 하나를 그리는 데 필요한 서식 (값만 읽던 때는 없던 것).
    struct Style {
        var numFmt: String = ""     // 표시 형식 코드 ("yyyy-mm-dd", "#,##0", "0%" …)
        var bold: Bool = false
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
        // 서식이 없으면 날짜가 45678 같은 일련번호로, 비율이 0.15 로 보인다 — 값은 맞는데
        // 표는 깨져 보인다. 스타일 표를 읽어 셀마다 어떤 형식인지 알아 둔다.
        let styles = unzip(url, "xl/styles.xml").map(cellStyles) ?? []
        let names = sheetNames(workbook)          // [(name, r:id)]
        var out: [Sheet] = []
        for (i, entry) in names.enumerated() {
            // 관계 파일이 알려 주는 실제 경로를 쓴다. sheet 순서와 sheetN.xml 번호는
            // 일치하지 않을 수 있다 (시트를 지웠다 만든 파일에서 어긋난다).
            let target = entry.rid.flatMap { rels[$0] } ?? "worksheets/sheet\(i + 1).xml"
            guard let xml = unzip(url, "xl/" + target) else { continue }
            let sheet = worksheet(xml, shared: shared, styles: styles, name: entry.name)
            out.append(sheet)
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

    private static func worksheet(_ data: Data, shared: [String], styles: [Style], name: String) -> Sheet {
        let d = SheetParser(shared: shared, styles: styles)
        XMLParser(data: data).also { $0.delegate = d }.parse()
        let rows = capped(d.rows)
        return Sheet(name: name, rows: rows, totalRows: d.rows.count,
                     bold: d.bold.filter { $0[0] < rows.count && $0[1] < maxCols },
                     nums: d.nums.filter { $0[0] < rows.count && $0[1] < maxCols },
                     merges: d.merges.filter { $0[0] < rows.count && $0[1] < maxCols },
                     colWidths: d.colWidths)
    }

    /// styles.xml → cellXfs 순서대로의 서식. numFmtId 는 내장 번호이거나 custom 정의를 가리킨다.
    private static func cellStyles(_ data: Data) -> [Style] {
        let d = StylesParser()
        XMLParser(data: data).also { $0.delegate = d }.parse()
        return d.styles
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
///
/// 값과 함께 **어떻게 보여야 하는지**도 읽는다. 서식을 버리면 날짜가 45678 로, 비율이
/// 0.15 로 나온다 — 값은 맞는데 사람 눈에는 깨진 표다.
private final class SheetParser: NSObject, XMLParserDelegate {
    private let shared: [String]
    private let styles: [Spreadsheet.Style]
    private var rowCells: [Int: String] = [:]
    private var col = 0
    private var type = ""
    private var styleIdx = -1
    private var buf = ""
    private var inValue = false
    private var inIS = false          // <is> 인라인 문자열
    var rows: [[String]] = []
    var bold: [[Int]] = []
    var nums: [[Int]] = []
    var merges: [[Int]] = []
    var colWidths: [Double] = []

    init(shared: [String], styles: [Spreadsheet.Style]) { self.shared = shared; self.styles = styles }

    private var style: Spreadsheet.Style? {
        styleIdx >= 0 && styleIdx < styles.count ? styles[styleIdx] : nil
    }

    func parser(_ p: XMLParser, didStartElement e: String, namespaceURI: String?,
                qualifiedName q: String?, attributes a: [String: String]) {
        switch e {
        case "row": rowCells = [:]
        case "c":
            col = SheetParser.columnIndex(a["r"] ?? "") ?? (rowCells.keys.max().map { $0 + 1 } ?? 0)
            type = a["t"] ?? ""
            styleIdx = Int(a["s"] ?? "") ?? -1
        case "is": inIS = true
        case "v", "t": inValue = true; buf = ""
        case "col":
            // 열 너비. min/max 는 1부터라 0 기반으로 옮긴다.
            if let mn = Int(a["min"] ?? ""), let mx = Int(a["max"] ?? ""), let w = Double(a["width"] ?? "") {
                if colWidths.count < mx { colWidths += Array(repeating: 0, count: mx - colWidths.count) }
                for c in (mn - 1)..<mx where c >= 0 && c < colWidths.count { colWidths[c] = w }
            }
        case "mergeCell":
            // "B2:D4" → [행, 열, 세로칸수, 가로칸수]. 합친 칸을 모르면 값이 한 칸에만 남고
            // 나머지가 빈 칸으로 보여 표가 어긋난 것처럼 읽힌다.
            if let ref = a["ref"], let m = SheetParser.mergeRect(ref) { merges.append(m) }
        default: break
        }
    }
    func parser(_ p: XMLParser, foundCharacters s: String) { if inValue { buf += s } }
    func parser(_ p: XMLParser, didEndElement e: String, namespaceURI: String?, qualifiedName q: String?) {
        switch e {
        case "v", "t":
            inValue = false
            var out: String? = nil
            if type == "s", let i = Int(buf), i >= 0, i < shared.count { out = shared[i] }
            else if type == "inlineStr" || inIS { out = buf.isEmpty ? nil : buf }
            else if !buf.isEmpty {
                // 숫자는 셀 서식을 입혀 사람이 보는 모양으로 바꾼다.
                out = Spreadsheet.display(buf, format: style?.numFmt ?? "", isText: type == "str")
                if type != "str", Double(buf) != nil { nums.append([rows.count, col]) }
            }
            if let out { rowCells[col] = out }
            if style?.bold == true { bold.append([rows.count, col]) }
        case "is": inIS = false
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
    static func rowIndex(_ ref: String) -> Int? {
        let digits = ref.drop { !$0.isNumber }
        return Int(digits).map { $0 - 1 }
    }
    static func mergeRect(_ ref: String) -> [Int]? {
        let parts = ref.split(separator: ":")
        guard parts.count == 2,
              let c0 = columnIndex(String(parts[0])), let r0 = rowIndex(String(parts[0])),
              let c1 = columnIndex(String(parts[1])), let r1 = rowIndex(String(parts[1])) else { return nil }
        return [min(r0, r1), min(c0, c1), abs(r1 - r0) + 1, abs(c1 - c0) + 1]
    }
}

/// styles.xml 에서 cellXfs 를 순서대로 읽는다. 셀의 s="3" 은 이 배열의 3번을 가리킨다.
private final class StylesParser: NSObject, XMLParserDelegate {
    private var customFormats: [Int: String] = [:]   // numFmtId → 코드
    private var boldFonts: Set<Int> = []
    private var fontIdx = -1
    private var inFonts = false, inCellXfs = false
    var styles: [Spreadsheet.Style] = []

    func parser(_ p: XMLParser, didStartElement e: String, namespaceURI: String?,
                qualifiedName q: String?, attributes a: [String: String]) {
        switch e {
        case "numFmt":
            if let id = Int(a["numFmtId"] ?? ""), let code = a["formatCode"] { customFormats[id] = code }
        case "fonts": inFonts = true; fontIdx = -1
        case "font": if inFonts { fontIdx += 1 }
        case "b": if inFonts, fontIdx >= 0 { boldFonts.insert(fontIdx) }
        case "cellXfs": inCellXfs = true
        case "xf":
            guard inCellXfs else { return }
            let id = Int(a["numFmtId"] ?? "0") ?? 0
            // applyNumberFormat="0" 이면 형식을 쓰지 않겠다는 뜻이다 (기본으로 둔다).
            let applies = a["applyNumberFormat"] != "0"
            let code = applies ? (customFormats[id] ?? Spreadsheet.builtinFormat(id)) : ""
            let f = Int(a["fontId"] ?? "")
            styles.append(.init(numFmt: code, bold: f.map { boldFonts.contains($0) } ?? false))
        default: break
        }
    }
    func parser(_ p: XMLParser, didEndElement e: String, namespaceURI: String?, qualifiedName q: String?) {
        if e == "fonts" { inFonts = false }
        if e == "cellXfs" { inCellXfs = false }
    }
}

extension Spreadsheet {

    /// 엑셀 내장 표시 형식 중 사람이 실제로 만나는 것들. 나머지는 기본(그대로)으로 둔다.
    static func builtinFormat(_ id: Int) -> String {
        switch id {
        case 1: return "0"
        case 2: return "0.00"
        case 3: return "#,##0"
        case 4: return "#,##0.00"
        case 9: return "0%"
        case 10: return "0.00%"
        case 11: return "0.00E+00"
        case 14: return "yyyy-mm-dd"
        case 15: return "d-mmm-yy"
        case 16: return "d-mmm"
        case 17: return "mmm-yy"
        case 18: return "h:mm AM/PM"
        case 19: return "h:mm:ss AM/PM"
        case 20: return "h:mm"
        case 21: return "h:mm:ss"
        case 22: return "yyyy-mm-dd h:mm"
        case 37, 38: return "#,##0"
        case 39, 40: return "#,##0.00"
        case 44, 43: return "#,##0.00"
        case 45: return "mm:ss"
        case 46: return "h:mm:ss"
        case 47: return "mm:ss.0"
        case 49: return "@"
        default: return ""
        }
    }

    /// 셀에 저장된 raw 값을 그 셀의 형식으로 그린다.
    ///
    /// 완전한 엑셀 형식 엔진이 아니다 — 날짜/시간, 백분율, 천 단위, 소수 자릿수까지만
    /// 본다. 그 넷이 "표가 깨져 보인다" 의 대부분이고, 나머지(색·조건부 서식·회계
    /// 괄호)는 값을 틀리게 보여 주지는 않는다.
    static func display(_ raw: String, format: String, isText: Bool) -> String {
        guard !isText, let n = Double(raw) else { return raw }
        let f = format.lowercased()
        if f.isEmpty || f == "general" { return trimNumber(n) }
        if f == "@" { return raw }
        // 날짜/시간: 코드에 y/d 가 있거나 h:mm 이 있으면 일련번호로 본다.
        let hasDate = f.contains("y") || f.contains("d")
        let hasTime = f.contains("h") || f.contains("s")
        if (hasDate || hasTime) && !f.contains("e+") {
            return excelDate(n, format: f, hasDate: hasDate, hasTime: hasTime)
        }
        var value = n
        var suffix = ""
        if f.contains("%") { value *= 100; suffix = "%" }
        let decimals = f.contains(".") ? (f.split(separator: ".").last?.filter { $0 == "0" || $0 == "#" }.count ?? 0) : 0
        let grouped = f.contains(",") || f.contains("#,##")
        let fm = NumberFormatter()
        fm.numberStyle = grouped ? .decimal : .none
        fm.usesGroupingSeparator = grouped
        fm.minimumFractionDigits = decimals
        fm.maximumFractionDigits = decimals
        let body = fm.string(from: NSNumber(value: value)) ?? trimNumber(value)
        // 통화 기호는 형식 코드에 그대로 들어 있다 (₩#,##0 처럼) — 앞에 붙은 것만 살린다.
        let currency = format.prefix { "₩$€£¥".contains($0) }
        return currency + body + suffix
    }

    /// 엑셀 일련번호 → 날짜. 1900 윤년 버그 때문에 기준은 1899-12-30 이다.
    private static func excelDate(_ serial: Double, format: String, hasDate: Bool, hasTime: Bool) -> String {
        guard serial > 0, serial < 2_958_466 else { return trimNumber(serial) }
        let base = DateComponents(calendar: .current, timeZone: TimeZone(identifier: "UTC"),
                                  year: 1899, month: 12, day: 30).date ?? Date(timeIntervalSince1970: 0)
        let date = base.addingTimeInterval(serial * 86_400)
        let df = DateFormatter()
        df.timeZone = TimeZone(identifier: "UTC")
        if hasDate && hasTime { df.dateFormat = "yyyy-MM-dd HH:mm" }
        else if hasDate { df.dateFormat = format.contains("yyyy") || format.contains("yy") ? "yyyy-MM-dd" : "MM-dd" }
        else { df.dateFormat = format.contains("s") ? "HH:mm:ss" : "HH:mm" }
        return df.string(from: date)
    }

    /// 1.0 을 "1" 로. 부동소수 찌꺼기(0.30000000000000004)도 여기서 걷힌다.
    private static func trimNumber(_ n: Double) -> String {
        if n == n.rounded(), abs(n) < 1e15 { return String(Int(n)) }
        return String(format: "%g", n)
    }
}
