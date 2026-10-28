// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EngineMenu",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "EngineMenu", targets: ["EngineMenu"])],
    targets: [
        .target(name: "EngineMenuCore"),
        .executableTarget(name: "EngineMenu", dependencies: ["EngineMenuCore"]),
        .testTarget(name: "EngineMenuCoreTests", dependencies: ["EngineMenuCore"], resources: [.copy("Fixtures")])
    ]
)
