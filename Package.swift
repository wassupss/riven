// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Riven",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .binaryTarget(
            name: "GhosttyKit",
            path: "ghostty-fw/GhosttyKit.xcframework"
        ),
        .executableTarget(
            name: "Riven",
            dependencies: ["GhosttyKit", .product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/Riven",
            resources: [.copy("Resources")],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                // Sparkle.framework is embedded in the .app's Frameworks dir at package time.
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
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
