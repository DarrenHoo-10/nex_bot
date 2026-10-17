// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "NexClientKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "NexClientKit", targets: ["NexClientKit"])],
    targets: [
        .target(name: "NexClientKit"),
        .testTarget(name: "NexClientKitTests", dependencies: ["NexClientKit"]),
    ],
    swiftLanguageModes: [.v6]
)
