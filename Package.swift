// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Riven",
    platforms: [.macOS(.v14)],
    targets: [
        .binaryTarget(
            name: "GhosttyKit",
            path: "ghostty-fw/GhosttyKit.xcframework"
        ),
        .executableTarget(
            name: "Riven",
            dependencies: ["GhosttyKit"],
            path: "Sources/Riven",
            resources: [.copy("Resources")],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .linkedFramework("Metal"),
                .linkedFramework("MetalKit"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("CoreText"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("IOSurface"),
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("WebKit"),
                .linkedLibrary("c++")
            ]
        )
    ]
)
