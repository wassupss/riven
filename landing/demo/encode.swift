// Encode a directory of PNG frames into an H.264 .mp4 with AVFoundation.
// (No ffmpeg on this machine; AVAssetWriter is the system encoder.)
//   swift encode.swift <framesDir> <out.mp4> <fps> <outW> <outH> <kbps>
import AVFoundation
import CoreGraphics
import ImageIO
import Foundation

let a = CommandLine.arguments
guard a.count >= 7 else { fputs("usage: encode <frames> <out> <fps> <w> <h> <kbps>\n", stderr); exit(2) }
let dir = URL(fileURLWithPath: a[1])
let out = URL(fileURLWithPath: a[2])
let fps = Int32(a[3])!, W = Int(a[4])!, H = Int(a[5])!, kbps = Int(a[6])!

let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
    .filter { $0.pathExtension.lowercased() == "png" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
guard !files.isEmpty else { fputs("no frames\n", stderr); exit(1) }

try? FileManager.default.removeItem(at: out)
let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W, AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: kbps * 1000,
        AVVideoMaxKeyFrameIntervalKey: Int(fps) * 4,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: true
    ]
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H
    ])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

let space = CGColorSpaceCreateDeviceRGB()
var i = 0
let queue = DispatchQueue(label: "encode")
let done = DispatchSemaphore(value: 0)

input.requestMediaDataWhenReady(on: queue) {
    while input.isReadyForMoreMediaData {
        if i >= files.count { input.markAsFinished(); done.signal(); return }
        guard let src = CGImageSourceCreateWithURL(files[i] as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { i += 1; continue }
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
        guard let buf = pb else { i += 1; continue }
        CVPixelBufferLockBaseAddress(buf, [])
        if let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: W, height: H,
                               bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf),
                               space: space,
                               bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
                                   | CGBitmapInfo.byteOrder32Little.rawValue) {
            ctx.interpolationQuality = .high            // 2× capture → crisp downscale
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
        }
        CVPixelBufferUnlockBaseAddress(buf, [])
        adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
        i += 1
    }
}
done.wait()
let fin = DispatchSemaphore(value: 0)
writer.finishWriting { fin.signal() }
fin.wait()
if writer.status != .completed { fputs("failed: \(writer.error?.localizedDescription ?? "?")\n", stderr); exit(1) }
print("wrote \(out.path) — \(files.count) frames @ \(fps)fps")
