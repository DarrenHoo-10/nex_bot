// Native SwiftUI render fixture; no app session, keychain or network access.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Run on macOS with Xcode");
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = mkdtempSync(path.join(os.tmpdir(), "nex-gmail-swiftui-"));
const source = path.join(fixture, "Sources/GmailSnapshot"); mkdirSync(source, { recursive: true });
const output = path.join(root, "release/gmail-cross-platform/apple"); mkdirSync(output, { recursive: true });
for (const file of ["Theme.swift", "GmailConnectorView.swift"]) copyFileSync(path.join(root, "apps/apple/Shared", file), path.join(source, file));
writeFileSync(path.join(fixture, "Package.swift"), `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "GmailSnapshot", platforms: [.macOS(.v14)], dependencies: [.package(path: ${JSON.stringify(path.join(root, "apps/apple/Packages/NexClientKit"))})], targets: [.executableTarget(name: "GmailSnapshot", dependencies: [.product(name: "NexClientKit", package: "NexClientKit")])])
`);
const state = { sync: { cursor: 1, privacyEpoch: 0, coreId: "gmail-fixture", bootId: "fixture" }, bots: [{ id: "assistant", name: "工作助手" }], connectorCatalog: [{ id: "gmail", name: "Gmail", available: true }], connectors: ["reader@example.test", "research.team.with.a.long.mailbox.name@example.test"].map((account, i) => ({ id: "mail-" + i, name: "Gmail", provider: "gmail", account, enabled: true, hasToken: true, checkedAt: 1760000000000, version: 1, tools: ["gmail.search", "gmail.read", "gmail.thread"].map(name => ({ name, inputSchema: {} })), grants: [{ botId: "assistant", tools: ["gmail.search"] }] })) };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const emptyState = { ...state, connectors: [] };
const unavailableState = { ...emptyState, connectorCatalog: [{ id: "gmail", name: "Gmail", available: false }] };
const attempt = { id: "fixture-attempt", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=fixture", expiresAt: 4102444800000 };
writeFileSync(path.join(source, "Main.swift"), `import SwiftUI
import AppKit
import NexClientKit

final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var state = Data(base64Encoded: "${encode(state)}")!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        let data: Data
        if path.contains("oauth/start") { data = Data(base64Encoded: "${encode(attempt)}")! }
        else if path.contains("oauth/status") { data = Data("{\\"id\\":\\"fixture-attempt\\",\\"status\\":\\"pending\\"}".utf8) }
        else if path.contains("oauth/cancel") { data = Data("{}".utf8) }
        else { data = Self.state }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
let emptyData = Data(base64Encoded: "${encode(emptyState)}")!
let unavailableData = Data(base64Encoded: "${encode(unavailableState)}")!

@MainActor func makeStore(_ data: Data) async throws -> WorkspaceStore {
    FixtureProtocol.state = data
    let store = WorkspaceStore(client: CoreClient(origin: try CoreOrigin("https://fixture.example.test"), token: "synthetic", session: CoreClient.makeSession(protocolClasses: [FixtureProtocol.self])))
    await store.refresh()
    return store
}
@MainActor func snap<V: View>(_ name: String, _ width: Double, _ height: Double, _ dark: Bool, _ view: V) async throws {
    NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    let content = view.background(Theme.background).frame(width: width, height: height).environment(\\.colorScheme, dark ? .dark : .light).environment(\\.openURL, OpenURLAction { _ in .handled })
    let host = NSHostingView(rootView: content)
    let rect = NSRect(x: 0, y: 0, width: width, height: height)
    let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host; host.frame = rect
    host.layoutSubtreeIfNeeded()
    try await Task.sleep(for: .milliseconds(350))
    host.displayIfNeeded()
    guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("No rendered pixels") }
    host.cacheDisplay(in: host.bounds, to: bitmap)
    var shades = Set<String>()
    for y in stride(from: 0, to: bitmap.pixelsHigh, by: 5) {
        for x in stride(from: 0, to: bitmap.pixelsWide, by: 5) { if let color = bitmap.colorAt(x: x, y: y) { shades.insert(color.description) } }
    }
    guard shades.count > 30 else { fatalError("Native render is blank: " + name) }
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: ${JSON.stringify(output)}).appendingPathComponent(name + ".png"))
    withExtendedLifetime(window) {}
}
@main struct Snapshot {
    @MainActor static func main() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let gmail = NSImage(contentsOfFile: ${JSON.stringify(path.join(root, "apps/apple/Shared/Assets.xcassets/Gmail.imageset/gmail.png"))})!
        gmail.setName("Gmail")
        let workspace = try await makeStore(FixtureProtocol.state)
        guard workspace.state?.connectors.count == 2 else { fatalError("Fixture did not load") }
        for (name, width, height, dark) in [("mac-light", 1000.0, 1000.0, false), ("mac-dark", 1000.0, 1000.0, true), ("native-narrow", 390.0, 1000.0, false)] {
            try await snap(name, width, height, dark, GmailConnectorView(workspace: workspace).padding(20))
        }
        // Catalog row: Connect is offered directly until a mailbox is linked.
        let empty = try await makeStore(emptyData)
        guard empty.state?.connectors.isEmpty == true, empty.state?.gmailAvailable == true else { fatalError("Empty fixture did not load") }
        let unavailable = try await makeStore(unavailableData)
        guard unavailable.state?.gmailAvailable == false else { fatalError("Unavailable fixture did not load") }
        for (suffix, width, dark) in [("desktop", 700.0, false), ("desktop-dark", 700.0, true), ("narrow", 390.0, false)] {
            try await snap("catalog-connect-" + suffix, width, 110, dark, GmailCatalogButton(workspace: empty, open: {}).padding(.horizontal, 20))
            let authorization = ConnectorAuthorization(workspace: empty, allowLoopbackFixture: true)
            _ = await authorization.start()
            guard authorization.authorizationURL != nil else { fatalError("Authorization did not start: " + (authorization.error ?? "no error")) }
            try await snap("catalog-authorizing-" + suffix, width, 150, dark, GmailCatalogButton(workspace: empty, open: {}, authorization: authorization).padding(.horizontal, 20))
            authorization.cancel()
            try await snap("catalog-added-" + suffix, width, 110, dark, GmailCatalogButton(workspace: workspace, open: {}).padding(.horizontal, 20))
            try await snap("catalog-unavailable-" + suffix, width, 110, dark, GmailCatalogButton(workspace: unavailable, open: {}).padding(.horizontal, 20))
        }
        print("Rendered native Gmail detail and catalog snapshots")
        withExtendedLifetime(gmail) {}
    }
}
`);
const build = spawnSync("xcrun", ["swift", "build", "--package-path", fixture], { encoding: "utf8", timeout: 240_000 });
if (build.status !== 0) throw new Error(build.stderr.slice(-5000));
// SwiftUI's named image lookup uses the executable's bundle, not NSImage's cache.
const bundle = path.join(fixture, "GmailSnapshot.app/Contents");
mkdirSync(path.join(bundle, "MacOS"), { recursive: true }); mkdirSync(path.join(bundle, "Resources"));
copyFileSync(path.join(fixture, ".build/debug/GmailSnapshot"), path.join(bundle, "MacOS/GmailSnapshot"));
const assets = spawnSync("xcrun", ["actool", "--compile", path.join(bundle, "Resources"), "--platform", "macosx", "--minimum-deployment-target", "14.0", path.join(root, "apps/apple/Shared/Assets.xcassets")], { encoding: "utf8", timeout: 60_000 });
if (assets.status !== 0) throw new Error(assets.stderr.slice(-3000));
writeFileSync(path.join(bundle, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>GmailSnapshot</string><key>CFBundleIdentifier</key><string>test.nex.gmail-snapshot</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
const result = spawnSync(path.join(bundle, "MacOS/GmailSnapshot"), [], { encoding: "utf8", timeout: 30_000 });
writeFileSync(path.join(output, "render.log"), build.stdout + build.stderr + result.stdout + result.stderr);
if (result.status !== 0) throw new Error(result.stderr.slice(-5000));
console.log(JSON.stringify({ passed: true, output, fixture }));
