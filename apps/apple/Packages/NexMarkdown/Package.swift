// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "NexMarkdown",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "NexMarkdown", targets: ["NexMarkdown"])],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-cmark.git", exact: "0.9.0"),
        .package(url: "https://github.com/scinfu/SwiftSoup.git", exact: "2.14.3"),
    ],
    targets: [
        .target(name: "NexMarkdown", dependencies: [
            .product(name: "cmark-gfm", package: "swift-cmark"),
            .product(name: "cmark-gfm-extensions", package: "swift-cmark"),
            .product(name: "SwiftSoup", package: "SwiftSoup"),
        ], resources: [.copy("Resources/chat-charts.js")]),
        .testTarget(name: "NexMarkdownTests", dependencies: ["NexMarkdown"]),
    ],
    swiftLanguageModes: [.v6]
)
