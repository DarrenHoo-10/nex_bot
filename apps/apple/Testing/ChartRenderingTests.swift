import XCTest
import SwiftUI
import WebKit
import NexMarkdown
@testable import NexRenderFixture

final class ChartRenderingTests: XCTestCase {
    @MainActor
    func evaluate(_ view: WKWebView, _ script: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            view.evaluateJavaScript(script, in: nil, in: .defaultClient) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value as? String ?? "")
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    @MainActor
    func testProductionWebKitCharts() async throws {
        let specs = [
            #"{"type":"bar","labels":["A","B"],"series":[{"name":"Sales","values":[10,-5]}]}"#,
            #"{"type":"histogram","values":[1,2,3,4],"bins":2}"#,
            #"{"type":"line","labels":["A","B","C"],"series":[{"name":"Trend","values":[1,null,3]}]}"#,
            #"{"type":"pie","labels":["A","B"],"values":[1,3]}"#
        ]
        let markdown = "<b>Fixture</b><script>window.untrusted=1</script>\n\n" + specs.map { "```chart\n\($0)\n```" }.joined(separator: "\n\n")
        let fragment = try XCTUnwrap(ChatDocument(markdown).staticHTML)
        var measured: CGFloat = 40
        var renderer = StaticHTMLWebView(html: StaticHTML.document(fragment: fragment, fontSize: 14, dark: false), width: 320, height: Binding(get: { measured }, set: { measured = $0 }), openLink: { _ in })
        let coordinator = renderer.makeCoordinator()
        let view = renderer.makeWebView(coordinator)
        view.frame = CGRect(x: 0, y: 0, width: 320, height: 2400)
        #if os(macOS)
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        #else
        let window = UIWindow(frame: view.frame)
        let controller = UIViewController()
        controller.view = view
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        #endif
        defer {
            view.stopLoading()
            view.navigationDelegate = nil
            view.configuration.userContentController.removeScriptMessageHandler(forName: "nexChartHeight", contentWorld: .defaultClient)
        }
        renderer.update(view, coordinator: coordinator)
        for _ in 0..<100 {
            if (try? await evaluate(view, "String(document.querySelectorAll('.nex-chart svg').length)")) == "4" { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        let types = try await evaluate(view, "Array.from(document.querySelectorAll('[data-chart-type]')).map(x=>x.dataset.chartType).join(',')")
        XCTAssertEqual(types, "bar,histogram,line,pie")
        XCTAssertFalse(view.configuration.defaultWebpagePreferences.allowsContentJavaScript)
        let scripts = try await evaluate(view, "String(document.querySelectorAll('script,iframe,img').length)")
        XCTAssertEqual(scripts, "0")
        let tooltip = try await evaluate(view, "document.querySelector('[data-label]').dispatchEvent(new Event('click',{bubbles:true}));document.querySelector('.nex-chart-tooltip').textContent")
        XCTAssertTrue(tooltip.contains("10"), tooltip)
        let histogram = try await evaluate(view, "document.querySelector('[data-chart-type=histogram] tbody').textContent")
        XCTAssertTrue(histogram.contains("2"), histogram)
        let pie = try await evaluate(view, "document.querySelector('[data-chart-type=pie]').textContent")
        XCTAssertTrue(pie.contains("25%"), pie)
        try await Task.sleep(for: .milliseconds(500))
        let collapsed = measured
        _ = try await evaluate(view, "document.querySelectorAll('details').forEach(x=>x.open=true);'open'")
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertGreaterThan(measured, collapsed)
        let snapshot = try await view.takeSnapshot(configuration: nil)
        let attachment = XCTAttachment(image: snapshot)
        attachment.name = "four-charts-narrow"
        attachment.lifetime = .keepAlways
        add(attachment)
        renderer = StaticHTMLWebView(html: StaticHTML.document(fragment: fragment, fontSize: 14, dark: true), width: 800, height: Binding(get: { measured }, set: { measured = $0 }), openLink: { _ in })
        view.frame.size.width = 800
        renderer.update(view, coordinator: coordinator)
        for _ in 0..<100 {
            if (try? await evaluate(view, "String(document.querySelectorAll('.nex-chart svg').length)")) == "4" { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        let darkCount = try await evaluate(view, "String(document.querySelectorAll('.nex-chart svg').length)")
        XCTAssertEqual(darkCount, "4")
    }
}
