// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Eaon-desktop",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "Eaon-desktop", targets: ["Eaon-desktop"])
    ],
    dependencies: [
        // Real terminal emulation (VT100/xterm) for Eaon Code's embedded
        // eaon-cli terminal — writing our own escape-sequence parser isn't
        // a reasonable use of time next to this actively maintained,
        // widely used library (also what several other macOS terminal
        // apps ship).
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.2.0")
    ],
    targets: [
        .executableTarget(
            name: "Eaon-desktop",
            dependencies: ["SwiftTerm"],
            path: "Eaon-desktop",
            resources: [
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "EaonDesktopSecurityTests",
            dependencies: ["Eaon-desktop"],
            path: "Tests/EaonDesktopSecurityTests"
        ),
        .testTarget(
            name: "EaonDesktopAgentTests",
            dependencies: ["Eaon-desktop"],
            path: "Tests/EaonDesktopAgentTests"
        )
    ]
)
