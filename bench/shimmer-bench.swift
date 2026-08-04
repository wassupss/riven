import AppKit

// 상태 애니메이션(ShimmerLabel / StatusPulseDot) CPU 측정 하네스.
//
// 앱 전체를 링크하지 않고 Sources/Riven/UI/StatusAnimation.swift 를 그대로 컴파일해서
// 재는 것이라, 실제로 배포되는 구현과 같은 코드를 측정한다.
//
//   swiftc -O -parse-as-library bench/shimmer-bench.swift \
//          Sources/Riven/UI/StatusAnimation.swift -o /tmp/shimmer-bench && /tmp/shimmer-bench
//
// 3단계로 잰다:
//   A 정지    — 뷰만 올려 두고 애니메이션 끔 (바닥값)
//   B 8+8 구동 — shimmer 8개 + 펄스 점 8개 동시 (요구 조건인 "동시에 8개")
//   C 가림     — 창을 화면에서 내림. 게이트가 전부 멈춰야 하고 CPU 는 A 로 돌아와야 한다
//
// CPU% = (user+sys CPU 시간 증가분 / 실제 흐른 시간) × 100. 이 프로세스 기준이다
// (WindowServer 쪽 비용은 여기 포함되지 않는다).

let LABELS = 8
let PHASE_SECONDS = 8.0

func cpuSeconds() -> Double {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    let user = Double(u.ru_utime.tv_sec) + Double(u.ru_utime.tv_usec) / 1e6
    let sys = Double(u.ru_stime.tv_sec) + Double(u.ru_stime.tv_usec) / 1e6
    return user + sys
}

final class Bench: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var labels: [ShimmerLabel] = []
    var dots: [StatusPulseDot] = []
    var results: [(String, Double, Int)] = []

    func applicationDidFinishLaunching(_ n: Notification) {
        let w = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 360, height: 300),
                         styleMask: [.titled], backing: .buffered, defer: false)
        w.title = "shimmer bench"
        w.level = .floating                  // 다른 창에 가려지면 게이트가 꺼져 측정이 무의미해진다
        w.backgroundColor = .black
        let root = NSView(frame: w.contentLayoutRect)
        root.autoresizingMask = [.width, .height]
        w.contentView = root

        for i in 0..<LABELS {
            let l = ShimmerLabel(labelWithString: "배포팀 · 에이전트 \(i + 1) 작업 중")
            l.textColor = .white
            l.font = .systemFont(ofSize: 12)
            l.frame = NSRect(x: 34, y: CGFloat(260 - i * 30), width: 300, height: 18)
            root.addSubview(l)
            labels.append(l)

            let d = StatusPulseDot(diameter: 7)
            d.translatesAutoresizingMaskIntoConstraints = true
            d.frame = NSRect(x: 16, y: CGFloat(265 - i * 30), width: 7, height: 7)
            root.addSubview(d)
            dots.append(d)
        }
        w.orderFrontRegardless()
        window = w
        // --hold on|off --seconds N: 상태를 그대로 붙들고만 있는다. 이 프로세스 밖에서
        // (WindowServer 처럼) 재야 하는 비용을 셸이 재는 동안 쓰는 모드다.
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--hold"), i + 1 < args.count {
            if args[i + 1] == "on" {
                labels.forEach { $0.shimmering = true }
                dots.forEach { $0.set(color: .orange, pulsing: true) }
            }
            let secs = (args.firstIndex(of: "--seconds").map { args[$0 + 1] }).flatMap(Double.init) ?? 10
            DispatchQueue.main.asyncAfter(deadline: .now() + secs) {
                print("live=\(ViewAnimationGate.liveCount)")
                exit(0)
            }
            return
        }
        run()
    }

    func run() {
        measure("A 정지 (0개)") { } then: {
            self.measure("B 구동 (shimmer 8 + 점 8)") {
                self.labels.forEach { $0.shimmering = true }
                self.dots.forEach { $0.set(color: .orange, pulsing: true) }
            } then: {
                self.measure("C 창 가림 (구동 상태 그대로)") {
                    self.window.orderOut(nil)
                } then: {
                    self.report()
                }
            }
        }
    }

    /// 준비 동작을 하고, 잠깐 안정화한 뒤 PHASE_SECONDS 동안 CPU 를 잰다.
    func measure(_ name: String, _ setup: @escaping () -> Void, then next: @escaping () -> Void) {
        setup()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {     // 준비 프레임은 빼고 잰다
            let c0 = cpuSeconds(), t0 = Date()
            DispatchQueue.main.asyncAfter(deadline: .now() + PHASE_SECONDS) {
                let pct = (cpuSeconds() - c0) / Date().timeIntervalSince(t0) * 100
                self.results.append((name, pct, ViewAnimationGate.liveCount))
                next()
            }
        }
    }

    func report() {
        print("")
        print("  단계                              CPU%   구동 중인 애니메이션")
        for (name, pct, live) in results {
            print(String(format: "  %-32@ %5.2f   %d", name as NSString, pct, live))
        }
        print("")
        if results.count > 1, results[1].2 != LABELS * 2 {
            print("  ! 경고: 측정 창이 가려져 있어 애니메이션이 게이트에서 꺼졌다. 창을 보이게 두고 다시 실행할 것.")
        }
        exit(0)
    }
}

@main
enum BenchMain {
    static let bench = Bench()
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)  // Dock 아이콘 없이, 포커스를 뺏지 않게
        app.delegate = bench
        app.run()
    }
}
