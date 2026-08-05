// Pull frames back out of the encoded mp4 to verify what actually got written.
//   swift probe.swift <in.mp4> <outDir> <seconds...>
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Foundation

let a = CommandLine.arguments
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let outDir = URL(fileURLWithPath: a[2])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero

let sem = DispatchSemaphore(value: 0)
Task {
    let d = try await asset.load(.duration)
    print("duration: \(String(format: "%.2f", CMTimeGetSeconds(d)))s")
    if let track = try await asset.loadTracks(withMediaType: .video).first {
        let size = try await track.load(.naturalSize)
        let fps = try await track.load(.nominalFrameRate)
        print("video: \(Int(size.width))x\(Int(size.height)) @ \(fps)fps")
    }
    for s in a.dropFirst(3) {
        let secs = Double(s)!
        let img = try await gen.image(at: CMTime(seconds: secs, preferredTimescale: 600)).image
        let url = outDir.appendingPathComponent("t\(s).png")
        if let dst = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(dst, img, nil)
            CGImageDestinationFinalize(dst)
        }
    }
    sem.signal()
}
sem.wait()
print("ok")
