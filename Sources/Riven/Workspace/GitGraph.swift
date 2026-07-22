import AppKit

// A Fork-style commit graph: colored lanes showing branch/merge topology, commit
// rows (sha · subject · refs · author · time), and a detail pane (message + changed
// files). Built from `git log --all --topo-order` + a lane-assignment pass.

// ---- lane layout ----
struct GraphRow {
    let commit: Git.Commit
    var dotCol = 0
    var dotColor = 0
    // half-edges: (from column, to column, color). Top runs row-top→center, bottom center→row-bottom.
    var top: [(from: Int, to: Int, color: Int)] = []
    var bottom: [(from: Int, to: Int, color: Int)] = []
}

enum GraphLayout {
    static func rows(_ commits: [Git.Commit]) -> [GraphRow] {
        var lanes: [String?] = []     // the sha each lane column is currently routing toward
        var color: [Int] = []          // color index per lane column
        var nextColor = 0
        var out: [GraphRow] = []

        for c in commits {
            var row = GraphRow(commit: c)
            let before = lanes, beforeColor = color

            // The commit's column: the first lane awaiting it, else a fresh lane (branch tip).
            var dc = before.firstIndex(where: { $0 == c.sha })
            let dotColor: Int
            if let d = dc { dotColor = beforeColor[d] }
            else {
                if let free = lanes.firstIndex(where: { $0 == nil }) {
                    dc = free; lanes[free] = c.sha; color[free] = nextColor
                } else { dc = lanes.count; lanes.append(c.sha); color.append(nextColor) }
                dotColor = nextColor; nextColor += 1
            }
            let dot = dc!
            row.dotCol = dot; row.dotColor = dotColor

            // Top half: every active incoming lane draws to center — into the dot if it
            // awaited this commit (merge / continuation), else straight through.
            for (i, s) in before.enumerated() where s != nil {
                row.top.append((from: i, to: s == c.sha ? dot : i, color: beforeColor[i]))
            }

            // Reached the commit → free every lane that awaited it (they converge here).
            for i in lanes.indices where lanes[i] == c.sha { lanes[i] = nil }

            // Route parents: first stays in the dot's column; extra parents (merges) open lanes.
            if let p0 = c.parents.first {
                lanes[dot] = p0; color[dot] = dotColor
                for pk in c.parents.dropFirst() {
                    if lanes.contains(where: { $0 == pk }) { continue }        // already routed
                    if let free = lanes.firstIndex(where: { $0 == nil }) { lanes[free] = pk; color[free] = nextColor }
                    else { lanes.append(pk); color.append(nextColor) }
                    nextColor += 1
                }
            } else { lanes[dot] = nil }   // root commit

            while let last = lanes.last, last == nil { lanes.removeLast(); color.removeLast() }

            // Bottom half: outgoing lanes draw center→bottom; parents fan out FROM the dot.
            let extraParents = Array(c.parents.dropFirst())
            for (i, s) in lanes.enumerated() where s != nil {
                let fromDot = i == dot || extraParents.contains(s!)
                row.bottom.append((from: fromDot ? dot : i, to: i, color: color[i]))
            }
            out.append(row)
        }
        return out
    }
}

// Source-control panel = the commit graph (main) + the working-changes/commit view
// (right). This is what the "git" dock panel shows — the graph lives in source
// control, not a separate command.
final class SourceControlView: NSView {
    let graph = GitGraphView(frame: .zero)
    let changes: GitPanel
    init(changes: GitPanel) {
        self.changes = changes
        super.init(frame: .zero)
        graph.translatesAutoresizingMaskIntoConstraints = false
        changes.translatesAutoresizingMaskIntoConstraints = false
        let divider = NSBox(); divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        addSubview(graph); addSubview(divider); addSubview(changes)
        NSLayoutConstraint.activate([
            graph.topAnchor.constraint(equalTo: topAnchor), graph.bottomAnchor.constraint(equalTo: bottomAnchor),
            graph.leadingAnchor.constraint(equalTo: leadingAnchor),
            graph.trailingAnchor.constraint(equalTo: divider.leadingAnchor),
            divider.topAnchor.constraint(equalTo: topAnchor), divider.bottomAnchor.constraint(equalTo: bottomAnchor),
            divider.widthAnchor.constraint(equalToConstant: 1),
            divider.trailingAnchor.constraint(equalTo: changes.leadingAnchor),
            changes.topAnchor.constraint(equalTo: topAnchor), changes.bottomAnchor.constraint(equalTo: bottomAnchor),
            changes.trailingAnchor.constraint(equalTo: trailingAnchor),
            changes.widthAnchor.constraint(equalToConstant: 320),   // working-changes sidebar
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    func setRoot(_ url: URL?) { graph.setRoot(url); if let url { changes.setRoot(url) } }
}

// ---- the graph panel (dock content) ----
final class GitGraphView: NSView, Themable {
    private let titleLabel = NSTextField(labelWithString: "Git 그래프")
    private let countLabel = NSTextField(labelWithString: "")
    private let refreshBtn = NSButton(title: "", target: nil, action: nil)
    private let list = GraphListView()
    private let listScroll = NSScrollView()
    private let detail = CommitDetailView()
    private var root: URL?

    var onOpenFile: ((String) -> Void)? {
        get { detail.onOpenFile } set { detail.onOpenFile = newValue }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true; layer?.backgroundColor = Theme.bg.cgColor

        titleLabel.font = .systemFont(ofSize: 12, weight: .semibold); titleLabel.textColor = Theme.fg
        countLabel.font = .systemFont(ofSize: 11); countLabel.textColor = Theme.fgDim
        refreshBtn.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        refreshBtn.image?.isTemplate = true; refreshBtn.imagePosition = .imageOnly
        refreshBtn.isBordered = false; refreshBtn.contentTintColor = Theme.fgDim
        refreshBtn.target = self; refreshBtn.action = #selector(reload)
        let header = NSStackView(views: [titleLabel, countLabel, NSView(), refreshBtn])
        header.orientation = .horizontal; header.edgeInsets = .init(top: 6, left: 10, bottom: 6, right: 8)
        header.translatesAutoresizingMaskIntoConstraints = false

        listScroll.documentView = list
        listScroll.hasVerticalScroller = true
        listScroll.drawsBackground = false
        // Document view tracks the clip view width (fills horizontally) while its height
        // comes from intrinsicContentSize (scrolls). Without pinning the width the view
        // is 0-wide and nothing draws.
        list.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            list.topAnchor.constraint(equalTo: listScroll.contentView.topAnchor),
            list.leadingAnchor.constraint(equalTo: listScroll.contentView.leadingAnchor),
            list.trailingAnchor.constraint(equalTo: listScroll.contentView.trailingAnchor),
        ])
        list.onSelect = { [weak self] commit in self?.showDetail(commit) }

        listScroll.translatesAutoresizingMaskIntoConstraints = false
        detail.translatesAutoresizingMaskIntoConstraints = false
        let divider = NSBox(); divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        // header (top) · graph list (flexible) · thin divider · commit detail (fixed)
        addSubview(header); addSubview(listScroll); addSubview(divider); addSubview(detail)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: topAnchor),
            header.leadingAnchor.constraint(equalTo: leadingAnchor),
            header.trailingAnchor.constraint(equalTo: trailingAnchor),
            listScroll.topAnchor.constraint(equalTo: header.bottomAnchor),
            listScroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            listScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            listScroll.bottomAnchor.constraint(equalTo: divider.topAnchor),
            divider.leadingAnchor.constraint(equalTo: leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: detail.topAnchor),
            detail.leadingAnchor.constraint(equalTo: leadingAnchor),
            detail.trailingAnchor.constraint(equalTo: trailingAnchor),
            detail.bottomAnchor.constraint(equalTo: bottomAnchor),
            detail.heightAnchor.constraint(equalToConstant: 210),
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func setRoot(_ url: URL?) { root = url; reload() }

    @objc func reload() {
        guard let root else { list.setRows([]); countLabel.stringValue = ""; return }
        DispatchQueue.global(qos: .userInitiated).async {
            let commits = Git.log(cwd: root.path)
            let rows = GraphLayout.rows(commits)
            DispatchQueue.main.async {
                self.list.setRows(rows)
                self.countLabel.stringValue = commits.isEmpty ? "" : "\(commits.count) commits"
                if let first = commits.first { self.showDetail(first) }
            }
        }
    }

    private func showDetail(_ commit: Git.Commit) {
        guard let root else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let body = Git.commitBody(cwd: root.path, sha: commit.sha)
            let files = Git.commitFiles(cwd: root.path, sha: commit.sha)
            DispatchQueue.main.async { self.detail.show(commit: commit, body: body, files: files) }
        }
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg.cgColor
        titleLabel.textColor = Theme.fg; countLabel.textColor = Theme.fgDim
        refreshBtn.contentTintColor = Theme.fgDim
        list.needsDisplay = true; detail.applyTheme()
    }
}

// ---- the scrollable graph list (custom-drawn) ----
final class GraphListView: NSView {
    static let laneColors: [NSColor] = [
        .systemBlue, .systemGreen, .systemOrange, .systemPurple,
        .systemTeal, .systemPink, .systemYellow, .systemRed,
    ]
    private let rowH: CGFloat = 26
    private let laneW: CGFloat = 14
    private let leftPad: CGFloat = 12
    private var rows: [GraphRow] = []
    private var maxCols = 1
    private var selected = 0
    var onSelect: ((Git.Commit) -> Void)?

    override var isFlipped: Bool { true }

    func setRows(_ r: [GraphRow]) {
        rows = r
        maxCols = max(1, r.map { row in
            1 + max(row.top.map { max($0.from, $0.to) }.max() ?? 0,
                    row.bottom.map { max($0.from, $0.to) }.max() ?? 0)
        }.max() ?? 1)
        selected = 0
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: CGFloat(rows.count) * rowH) }

    private func laneX(_ col: Int) -> CGFloat { leftPad + CGFloat(col) * laneW }
    private var graphWidth: CGFloat { laneX(maxCols) + 6 }

    override func mouseDown(with event: NSEvent) {
        let y = convert(event.locationInWindow, from: nil).y
        let i = Int(y / rowH)
        if i >= 0 && i < rows.count { selected = i; needsDisplay = true; onSelect?(rows[i].commit) }
    }

    override func draw(_ dirty: NSRect) {
        guard !rows.isEmpty else { return }
        let ctx = NSGraphicsContext.current!.cgContext
        let first = max(0, Int(dirty.minY / rowH)), last = min(rows.count - 1, Int(dirty.maxY / rowH))
        if first > last { return }
        for i in first...last {
            let row = rows[i]
            let top = CGFloat(i) * rowH, mid = top + rowH / 2, bot = top + rowH
            if i == selected {
                Theme.hover.setFill(); NSRect(x: 0, y: top, width: bounds.width, height: rowH).fill()
            }
            ctx.setLineWidth(1.6); ctx.setLineCap(.round)
            for e in row.top { drawEdge(ctx, x0: laneX(e.from), y0: top, x1: laneX(e.to), y1: mid, color: e.color) }
            for e in row.bottom { drawEdge(ctx, x0: laneX(e.from), y0: mid, x1: laneX(e.to), y1: bot, color: e.color) }
            // dot
            let dx = laneX(row.dotCol)
            let col = GraphListView.laneColors[row.dotColor % GraphListView.laneColors.count]
            col.setFill(); Theme.bg.setStroke()
            let dot = NSBezierPath(ovalIn: NSRect(x: dx - 4, y: mid - 4, width: 8, height: 8))
            dot.fill(); dot.lineWidth = 1.5; dot.stroke()
            drawText(row, x: graphWidth, mid: mid)
        }
    }

    private func drawEdge(_ ctx: CGContext, x0: CGFloat, y0: CGFloat, x1: CGFloat, y1: CGFloat, color: Int) {
        GraphListView.laneColors[color % GraphListView.laneColors.count].setStroke()
        let p = CGMutablePath()
        p.move(to: CGPoint(x: x0, y: y0))
        if x0 == x1 { p.addLine(to: CGPoint(x: x1, y: y1)) }
        else { p.addCurve(to: CGPoint(x: x1, y: y1), control1: CGPoint(x: x0, y: (y0 + y1) / 2), control2: CGPoint(x: x1, y: (y0 + y1) / 2)) }
        ctx.addPath(p); ctx.strokePath()
    }

    private func drawText(_ row: GraphRow, x: CGFloat, mid: CGFloat) {
        var cx = x + 4
        // ref badges (HEAD/branch/tag)
        for ref in row.commit.refs.prefix(4) {
            cx = drawBadge(ref, x: cx, mid: mid) + 5
        }
        let sha = attr(row.commit.short, .monospacedSystemFont(ofSize: 11, weight: .regular), Theme.fgDim)
        sha.draw(at: NSPoint(x: cx, y: mid - sha.size().height / 2)); cx += sha.size().width + 8
        // author + relative time (right-aligned)
        let meta = "\(row.commit.author) · \(relTime(row.commit.timestamp))"
        let ma = attr(meta, .systemFont(ofSize: 10), Theme.fgDim)
        let mw = ma.size().width
        let metaX = bounds.width - mw - 10
        ma.draw(at: NSPoint(x: metaX, y: mid - ma.size().height / 2))
        // subject (fills the middle)
        let subj = attr(row.commit.subject, .systemFont(ofSize: 12), Theme.fg)
        let avail = max(20, metaX - cx - 8)
        subj.draw(with: NSRect(x: cx, y: mid - subj.size().height / 2, width: avail, height: subj.size().height),
                  options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin])
    }

    private func drawBadge(_ text: String, x: CGFloat, mid: CGFloat) -> CGFloat {
        let isHead = text.hasPrefix("HEAD")
        let isTag = text.hasPrefix("tag:")
        let label = text.replacingOccurrences(of: "HEAD -> ", with: "").replacingOccurrences(of: "tag: ", with: "")
        let color = isHead ? Theme.accent : (isTag ? Theme.warning : Theme.info)
        let a = attr(label, .systemFont(ofSize: 10, weight: .medium), color)
        let w = a.size().width + 10
        let r = NSRect(x: x, y: mid - 8, width: w, height: 16)
        let bg = NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4)
        color.withAlphaComponent(0.14).setFill(); bg.fill()
        color.withAlphaComponent(0.4).setStroke(); bg.lineWidth = 1; bg.stroke()
        a.draw(at: NSPoint(x: x + 5, y: mid - a.size().height / 2))
        return x + w
    }

    private func attr(_ s: String, _ f: NSFont, _ c: NSColor) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: c])
    }
}

// ---- commit detail (message + changed files) ----
final class CommitDetailView: NSView, Themable {
    private let header = NSTextField(labelWithString: "")
    private let message = NSTextView()
    private let msgScroll = NSScrollView()
    private let filesStack = FlippedStack()
    private let filesScroll = NSScrollView()
    private var root: URL?
    var onOpenFile: ((String) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true; layer?.backgroundColor = Theme.bg2.cgColor
        header.font = .monospacedSystemFont(ofSize: 11, weight: .medium); header.textColor = Theme.fgDim
        header.lineBreakMode = .byTruncatingTail; header.translatesAutoresizingMaskIntoConstraints = false
        message.isEditable = false; message.drawsBackground = false; message.font = .systemFont(ofSize: 12)
        message.textColor = Theme.fg; message.textContainerInset = NSSize(width: 8, height: 6)
        msgScroll.documentView = message; msgScroll.hasVerticalScroller = true; msgScroll.drawsBackground = false
        msgScroll.translatesAutoresizingMaskIntoConstraints = false
        filesScroll.documentView = filesStack; filesScroll.hasVerticalScroller = true; filesScroll.drawsBackground = false
        filesScroll.translatesAutoresizingMaskIntoConstraints = false
        filesStack.orientation = .vertical; filesStack.alignment = .leading; filesStack.spacing = 0
        addSubview(header); addSubview(msgScroll); addSubview(filesScroll)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            msgScroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 4),
            msgScroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            msgScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            msgScroll.heightAnchor.constraint(equalToConstant: 64),
            filesScroll.topAnchor.constraint(equalTo: msgScroll.bottomAnchor, constant: 2),
            filesScroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            filesScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            filesScroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(commit: Git.Commit, body: String, files: [Git.DiffFile]) {
        header.stringValue = "\(commit.short)  ·  \(commit.author)  ·  \(relTime(commit.timestamp))"
        message.string = body
        filesStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for f in files { filesStack.addArrangedSubview(fileRow(f)) }
    }

    private func fileRow(_ f: Git.DiffFile) -> NSView {
        let name = NSTextField(labelWithString: (f.path as NSString).lastPathComponent)
        name.font = .systemFont(ofSize: 12); name.textColor = Theme.fg; name.lineBreakMode = .byTruncatingMiddle
        let dir = (f.path as NSString).deletingLastPathComponent
        let path = NSTextField(labelWithString: dir.isEmpty ? "" : dir)
        path.font = .systemFont(ofSize: 10); path.textColor = Theme.fgDim; path.lineBreakMode = .byTruncatingHead
        let stat = NSTextField(labelWithString: f.binary ? "bin" : "+\(f.added) −\(f.removed)")
        stat.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        stat.textColor = f.added >= f.removed ? Theme.gitAdded : Theme.gitDeleted
        let row = ClickRow { [weak self] in self?.onOpenFile?(f.path) }
        let s = NSStackView(views: [name, path, NSView(), stat]); s.orientation = .horizontal; s.spacing = 8
        s.edgeInsets = .init(top: 3, left: 12, bottom: 3, right: 12)
        s.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(s)
        NSLayoutConstraint.activate([
            s.leadingAnchor.constraint(equalTo: row.leadingAnchor), s.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            s.topAnchor.constraint(equalTo: row.topAnchor), s.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            row.widthAnchor.constraint(equalToConstant: 10).withPriority(1),
        ])
        return row
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        header.textColor = Theme.fgDim; message.textColor = Theme.fg
    }
}

// small helpers
private func relTime(_ ts: Int) -> String {
    guard ts > 0 else { return "" }
    let d = Int(Date().timeIntervalSince1970) - ts
    if d < 60 { return "방금" }
    if d < 3600 { return "\(d / 60)분 전" }
    if d < 86400 { return "\(d / 3600)시간 전" }
    if d < 2_592_000 { return "\(d / 86400)일 전" }
    if d < 31_536_000 { return "\(d / 2_592_000)개월 전" }
    return "\(d / 31_536_000)년 전"
}

private final class ClickRow: NSView {
    private let action: () -> Void
    init(_ a: @escaping () -> Void) { action = a; super.init(frame: .zero); wantsLayer = true }
    required init?(coder: NSCoder) { fatalError() }
    override func mouseDown(with e: NSEvent) { action() }
    override func mouseEntered(with e: NSEvent) { layer?.backgroundColor = Theme.hover.cgColor }
    override func mouseExited(with e: NSEvent) { layer?.backgroundColor = nil }
    override func updateTrackingAreas() {
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }
}

private extension NSLayoutConstraint {
    func withPriority(_ p: Float) -> NSLayoutConstraint { priority = NSLayoutConstraint.Priority(p); return self }
}
