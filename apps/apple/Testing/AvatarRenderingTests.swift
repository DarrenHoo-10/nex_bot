import XCTest
import SwiftUI
import NexClientKit
@testable import NexRenderFixture

final class AvatarRenderingTests: XCTestCase {
    func testSavedGraphicsAndClassicPortraitsSurviveParsing() {
        for id in AvatarCatalog.graphics.map(\.id) {
            let bot = Bot(row: ["id": "b", "appearance_json": .string("{\"kind\":\"graphic\",\"id\":\"\(id)\"}")])
            XCTAssertEqual(AgentAppearance.of(bot, firstID: "b"), .graphic(id))
        }
        let old = Bot(row: ["id": "b", "appearance_json": "{\"kind\":\"portrait\",\"id\":\"fox\"}"])
        XCTAssertEqual(AgentAppearance.of(old, firstID: "b"), .portrait("fox"))
        let invalid = Bot(row: ["id": "b", "appearance_json": "{\"kind\":\"graphic\",\"id\":\"missing\"}"])
        XCTAssertEqual(AgentAppearance.of(invalid, firstID: "b"), .graphic("secretary-01"))
        if case .companion = AgentAppearance.of(Bot(row: ["id": "c"]), firstID: "b") {} else { XCTFail("Other agents keep a companion default") }
    }

    func testCompletionPlaysOnceAndStatesHaveDistinctMotion() throws {
        for graphic in AvatarCatalog.graphics {
            XCTAssertNotEqual(GraphicAvatarMotion.sample(graphic, state: .done, elapsed: 0.32), .init())
            for elapsed in [0.72, 1, 5, 10] {
                XCTAssertEqual(GraphicAvatarMotion.sample(graphic, state: .done, elapsed: elapsed), .init())
            }
            let thinking = GraphicAvatarMotion.sample(graphic, state: .thinking, elapsed: graphic.tempo * 0.65 * 0.3)
            XCTAssertEqual(thinking.rotation, graphic.tilt)
            XCTAssertEqual(thinking.y, graphic.lift)
            XCTAssertNotEqual(thinking, GraphicAvatarMotion.sample(graphic, state: .working, elapsed: graphic.tempo * 0.3 * 0.52))
        }
    }

    @MainActor func testBundledArtworkRendersInBothThemesAndNarrowPicker() throws {
        for dark in [false, true] {
            let content = RoleAvatarOptions(choice: .constant(.graphic("female-06")), columns: 4)
                .padding(16).frame(width: 375)
                .background { WorkspaceSurface(kind: .reading) }
                .environment(\.colorScheme, dark ? .dark : .light)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            #if os(macOS)
            let image = try XCTUnwrap(renderer.nsImage)
            #else
            let image = try XCTUnwrap(renderer.uiImage)
            #endif
            XCTAssertEqual(image.size.width, 375, accuracy: 0.1)
            let attachment = XCTAttachment(image: image)
            attachment.name = "role-picker-\(dark ? "dark" : "light")"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        for descriptor in AvatarCatalog.graphics {
            #if os(macOS)
            let source = try XCTUnwrap(NSImage(named: descriptor.assetName), descriptor.id)
            XCTAssertGreaterThan(source.size.width, 1000)
            #else
            let source = try XCTUnwrap(UIImage(named: descriptor.assetName), descriptor.id)
            XCTAssertGreaterThan(source.size.width * source.scale, 1000)
            #endif
            let renderer = ImageRenderer(content: AgentAvatar(appearance: .graphic(descriptor.id), size: 104))
            let cgImage = try XCTUnwrap(renderer.cgImage, descriptor.id)
            let pixels = try XCTUnwrap(cgImage.dataProvider?.data) as Data
            XCTAssertGreaterThan(Set(pixels).count, 100, "Missing or flat artwork: \(descriptor.id)")
        }
    }
}
