import XCTest
import CryptoKit
@testable import NexClientKit

final class ClientUpdateTests: XCTestCase {
    let installer = Data((0..<4096).map { UInt8($0 % 251) })
    var sha: String { SHA256.hash(data: installer).map { String(format: "%02x", $0) }.joined() }

    func testVersionsCompareNumerically() {
        XCTAssertTrue(ClientUpdateOffer.newer("0.2.10", than: "0.2.9"))
        XCTAssertFalse(ClientUpdateOffer.newer("0.2.9", than: "0.2.9"))
        XCTAssertFalse(ClientUpdateOffer.newer("0.2.8", than: "0.2.9"))
        XCTAssertFalse(ClientUpdateOffer.newer("1.0.0-beta", than: "0.2.9"))
        XCTAssertTrue(ClientUpdateOffer.newer("0.2.9", than: "unknown"))
    }

    func testCheckAsksForThePlatformAndRefusesBadOffers() async throws {
        let core = StubCore()
        var answer: [String: Any] = ["available": false]
        core.handle { _ in .json(answer) }
        let client = core.client()
        let none = try await client.clientUpdate(platform: "mac", current: "0.2.4")
        XCTAssertNil(none)
        let r = core.recorded("/api/client/update")[0]
        XCTAssertEqual(r.query, "platform=mac&version=0.2.4")
        answer = ["available": true, "version": "0.2.5", "size": 4096, "sha256": sha, "url": "https://mirror.test/NexBot-0.2.5-mac-arm64.dmg?Signature=x"]
        let offer = try await client.clientUpdate(platform: "mac", current: "0.2.4")
        XCTAssertEqual(offer?.version, "0.2.5"); XCTAssertEqual(offer?.size, 4096)
        for bad: [String: Any] in [["url": "http://mirror.test/a.dmg"], ["sha256": "nope"], ["version": "0.2.4"], ["size": 0]] {
            answer = answer.merging(bad) { $1 }
            let refused = try await client.clientUpdate(platform: "mac", current: "0.2.4")
            XCTAssertNil(refused, "\(bad)")
            answer = ["available": true, "version": "0.2.5", "size": 4096, "sha256": sha, "url": "https://mirror.test/NexBot-0.2.5-mac-arm64.dmg?Signature=x"]
        }
    }

    func testDownloadKeepsOnlyAVerifiedFile() async throws {
        let core = StubCore(), mirror = StubCore()
        var body = installer
        mirror.handle { _ in StubResponse(status: 200, headers: ["Content-Type": "application/octet-stream"], body: body) }
        let offer = ClientUpdateOffer(version: "0.2.5", size: installer.count, sha256: sha, url: URL(string: "https://\(mirror.host)/NexBot-0.2.5-mac-arm64.dmg")!)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("NexBot-0.2.5.dmg")
        let saved = try await core.client().downloadUpdate(offer, to: file)
        XCTAssertEqual(try Data(contentsOf: saved), installer)
        XCTAssertNil(mirror.recorded()[0].headers["Authorization"])
        _ = try await core.client().downloadUpdate(offer, to: file)
        XCTAssertEqual(mirror.recorded().count, 1, "a verified file is reused")
        try FileManager.default.removeItem(at: file)
        body = installer + Data([0])
        do { _ = try await core.client().downloadUpdate(offer, to: file); XCTFail() } catch { XCTAssertEqual((error as? CoreError)?.message, "更新文件校验失败") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
}
